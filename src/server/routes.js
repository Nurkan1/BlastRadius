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

export function makeRouter({ treeScanner, eventStore, sse, logger }) {
  const router = Router()

  router.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      sseClients: sse.size(),
      events: eventStore.getEvents().length,
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
      const result = computeHeat({
        events: eventStore.getEvents(),
        window: windowName,
        now: new Date(),
        totalFiles,
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

  return router
}
