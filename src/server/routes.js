/**
 * Express router for the BlastRadius API.
 *
 *   GET /api/tree          → repo tree (cached)
 *   GET /api/heat?window=  → heat map + metrics for the chosen window
 *   GET /api/events        → SSE stream of "heat-update" and "tree-update"
 *   GET /api/health        → liveness probe (mostly for debugging)
 *
 * All handlers are read-only. None of them ever touch the target repo
 * directly — they delegate to treeScanner (which is the one place that
 * walks the repo, also read-only).
 */

import { Router } from 'express'
import { computeHeat } from './heatEngine.js'
import { PathTraversalError, InvalidRefError } from './diffProvider.js'

export function makeRouter({
  treeScanner,
  eventStore,
  sse,
  graphResolver,
  diffProvider,
  iterationMarker,
  depth = 2,
  logger,
}) {
  const router = Router()

  router.get('/api/health', (req, res) => {
    const graph = graphResolver?.getGraph()
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      sseClients: sse.size(),
      events: eventStore.getEvents().length,
      graph: graph
        ? { modules: graph.forward?.size ?? 0, builtAt: graph.builtAt }
        : { modules: 0, builtAt: 0 },
      depth,
      iterationStartedAt: iterationMarker?.getIso() ?? null,
    })
  })

  router.get('/api/tree', async (req, res) => {
    try {
      const tree = await treeScanner.getTree()
      res.json(tree)
    } catch (err) {
      logger?.warn({ err: String(err) }, 'tree scan failed')
      res.status(500).json({
        error: 'tree_scan_failed',
        message: String(err?.message ?? err),
      })
    }
  })

  router.get('/api/heat', async (req, res) => {
    try {
      const windowName = typeof req.query.window === 'string' ? req.query.window : 'session'
      const totalFiles = await treeScanner.countFiles()
      // graphResolver always returns a valid graph (possibly stale during
      // an in-flight rebuild) — never null, so computeHeat can rely on it.
      // We deliberately do NOT expose the graph itself via any /api/* route:
      // it would leak the full project structure with no functional gain.
      const graph = graphResolver?.getGraph() ?? null
      const result = computeHeat({
        events: eventStore.getEvents(),
        window: windowName,
        now: new Date(),
        totalFiles,
        graph,
        depth,
        iterationStartedAt: iterationMarker?.get() ?? null,
      })
      res.json(result)
    } catch (err) {
      logger?.warn({ err: String(err) }, 'heat compute failed')
      res.status(500).json({
        error: 'heat_compute_failed',
        message: String(err?.message ?? err),
      })
    }
  })

  router.get('/api/events', (req, res) => {
    sse.addClient(res)
    // We deliberately do NOT call res.end() here — the connection stays
    // open until the client disconnects, which sse.addClient hooks into
    // via res.on('close', ...).
  })

  // ── Diff endpoint ──────────────────────────────────────────────────────
  //
  // Path traversal is enforced by diffProvider.validatePath at the entry
  // point. PathTraversalError → 400 (client mistake / attack), other
  // errors → 500. No path normalization happens here in the route — that
  // would risk drift between what we validate and what we git-diff.
  router.get('/api/diff', async (req, res) => {
    if (!diffProvider) {
      res.status(503).json({ error: 'diff_provider_unavailable' })
      return
    }
    const filePath = typeof req.query.path === 'string' ? req.query.path : ''
    const against = typeof req.query.against === 'string' && req.query.against
      ? req.query.against
      : 'HEAD'
    try {
      const result = await diffProvider.getDiff(filePath, against)
      res.json(result)
    } catch (err) {
      if (err instanceof PathTraversalError || err instanceof InvalidRefError) {
        // Deliberate 400 — bad client input, not a server failure.
        res.status(400).json({ error: err.code, message: err.message })
        return
      }
      logger?.warn({ err: String(err?.message ?? err), path: filePath }, 'diff failed')
      res.status(500).json({ error: 'diff_failed', message: String(err?.message ?? err) })
    }
  })

  // ── Iteration endpoints ────────────────────────────────────────────────
  //
  // GET  → current marker (null when never closed).
  // POST → close the current iteration; advance the marker to NOW and
  //        notify any connected SSE clients so the iteration panel
  //        re-renders without waiting for the next polling tick.
  router.get('/api/iteration', (req, res) => {
    res.json({ iterationStartedAt: iterationMarker?.getIso() ?? null })
  })

  router.post('/api/iteration/close', (req, res) => {
    if (!iterationMarker) {
      res.status(503).json({ error: 'iteration_marker_unavailable' })
      return
    }
    const at = iterationMarker.close()
    sse?.broadcast('iteration-update', { iterationStartedAt: at.toISOString() })
    res.json({ iterationStartedAt: at.toISOString() })
  })

  return router
}
