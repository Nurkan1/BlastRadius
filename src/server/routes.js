/**
 * Express router for the BlastRadius API (Phase 5: multi-repo).
 *
 * Read-only on every target repo. The only write surface is
 * preferences.json (under ~/.blastradius/) via /api/preferences and
 * /api/repos/select.
 *
 * Endpoints
 * ─────────
 *   GET  /api/health             liveness + diagnostics
 *   GET  /api/tree               repo tree (cached, current repo only)
 *   GET  /api/heat?window=…      heat map + metrics for the current repo
 *   GET  /api/events             SSE stream
 *   GET  /api/diff?path=…        validated git diff for current repo
 *   GET  /api/iteration          current iteration marker
 *   POST /api/iteration/close    advance marker, SSE notify
 *   GET  /api/repos              detected repos under parentDir + activity
 *   GET  /api/repos/active       currently active repo
 *   POST /api/repos/select       switch to a different repo (in parentDir)
 *   GET  /api/preferences        full prefs + needsSetup flag
 *   POST /api/preferences        merge into prefs (parentDir / autoSwitch / etc.)
 *
 * 503 vs 400
 * ──────────
 *   - 503 when there is no current repo (wizard mode) for endpoints
 *     that need one (/api/tree, /api/heat, /api/diff). Frontend uses
 *     this signal to render the wizard.
 *   - 400 when the client sends a bad input (path traversal, missing
 *     field, unknown repo path).
 */

import { Router } from 'express'
import { existsSync, statSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { computeHeat } from './heatEngine.js'
import { PathTraversalError, InvalidRefError } from './diffProvider.js'

const STATUS_NEEDS_SETUP = 503

/** Normalize for cross-platform comparison. */
function fwd(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : p
}
// fwd is used in /api/repos handler; keep the export-shape stable.
void fwd

/** Anti-traversal check: `target` must be inside `parent` (after resolve). */
function isInside(parent, target) {
  if (!parent || !target) return false
  const p = resolve(parent)
  const t = resolve(target)
  return t === p || t.startsWith(p + sep)
}

export function makeRouter({
  getRepoContext,
  eventStore,
  sse,
  iterationMarker,
  preferences,
  repoDetector,
  rebuildRepoDetector,
  switchRepo,
  depth = 2,
  logger,
}) {
  const router = Router()

  // ── health ───────────────────────────────────────────────────────────────
  router.get('/api/health', (req, res) => {
    const ctx = getRepoContext?.()
    const graph = ctx?.graphResolver?.getGraph()
    const prefs = preferences.get()
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      sseClients: sse.size(),
      events: eventStore.getEvents().length,
      currentRepo: prefs.currentRepo,
      parentDir: prefs.parentDir,
      autoSwitch: prefs.autoSwitch,
      needsSetup: !!prefs.needsSetup,
      graph: graph
        ? { modules: graph.forward?.size ?? 0, builtAt: graph.builtAt }
        : { modules: 0, builtAt: 0 },
      depth,
      iterationStartedAt: iterationMarker?.getIso() ?? null,
    })
  })

  // ── tree / heat / events / diff (all need a current repo) ───────────────

  router.get('/api/tree', async (req, res) => {
    const ctx = getRepoContext?.()
    if (!ctx) return res.status(STATUS_NEEDS_SETUP).json({ error: 'no_active_repo', needsSetup: true })
    try {
      const tree = await ctx.treeScanner.getTree()
      res.json(tree)
    } catch (err) {
      logger?.warn({ err: String(err) }, 'tree scan failed')
      res.status(500).json({ error: 'tree_scan_failed', message: String(err?.message ?? err) })
    }
  })

  router.get('/api/heat', async (req, res) => {
    const ctx = getRepoContext?.()
    if (!ctx) return res.status(STATUS_NEEDS_SETUP).json({ error: 'no_active_repo', needsSetup: true })
    try {
      const windowName = typeof req.query.window === 'string' ? req.query.window : 'session'
      const totalFiles = await ctx.treeScanner.countFiles()
      const graph = ctx.graphResolver.getGraph()
      // Per-repo event slice — events are filtered by cwd === ctx.repoPath.
      const events = eventStore.getEventsForRepo(ctx.repoPath)
      const result = computeHeat({
        events,
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
      res.status(500).json({ error: 'heat_compute_failed', message: String(err?.message ?? err) })
    }
  })

  router.get('/api/events', (req, res) => {
    sse.addClient(res)
  })

  router.get('/api/diff', async (req, res) => {
    const ctx = getRepoContext?.()
    if (!ctx) return res.status(STATUS_NEEDS_SETUP).json({ error: 'no_active_repo', needsSetup: true })
    const filePath = typeof req.query.path === 'string' ? req.query.path : ''
    const against = typeof req.query.against === 'string' && req.query.against
      ? req.query.against
      : 'HEAD'
    try {
      const result = await ctx.diffProvider.getDiff(filePath, against)
      res.json(result)
    } catch (err) {
      if (err instanceof PathTraversalError || err instanceof InvalidRefError) {
        return res.status(400).json({ error: err.code, message: err.message })
      }
      logger?.warn({ err: String(err?.message ?? err), path: filePath }, 'diff failed')
      res.status(500).json({ error: 'diff_failed', message: 'failed to render diff' })
    }
  })

  // ── iteration ────────────────────────────────────────────────────────────

  router.get('/api/iteration', (req, res) => {
    res.json({ iterationStartedAt: iterationMarker?.getIso() ?? null })
  })

  router.post('/api/iteration/close', (req, res) => {
    if (!iterationMarker) {
      return res.status(503).json({ error: 'iteration_marker_unavailable' })
    }
    const at = iterationMarker.close()
    sse?.broadcast('iteration-update', { iterationStartedAt: at.toISOString() })
    res.json({ iterationStartedAt: at.toISOString() })
  })

  // ── repos ────────────────────────────────────────────────────────────────

  router.get('/api/repos', async (req, res) => {
    const det = repoDetector?.()
    if (!det) return res.json({ repos: [] })
    try {
      const repos = await det.getRepos({ force: req.query.refresh === '1' })
      const prefs = preferences.get()
      const activePath = fwd(prefs.currentRepo)
      res.json({
        repos: repos.map((r) => ({
          ...r,
          isActive: fwd(r.path) === activePath,
        })),
      })
    } catch (err) {
      logger?.warn({ err: String(err) }, 'repo list failed')
      res.status(500).json({ error: 'repos_failed', message: String(err?.message ?? err) })
    }
  })

  router.get('/api/repos/active', (req, res) => {
    const prefs = preferences.get()
    if (!prefs.currentRepo) return res.json(null)
    res.json({
      path: prefs.currentRepo,
      name: prefs.currentRepo.split('/').filter(Boolean).pop() || prefs.currentRepo,
    })
  })

  router.post('/api/repos/select', async (req, res) => {
    const body = req.body ?? {}
    const target = typeof body.path === 'string' ? body.path : ''
    if (!target) {
      return res.status(400).json({ error: 'invalid_path', message: 'body.path is required' })
    }
    const prefs = preferences.get()
    if (!prefs.parentDir) {
      return res.status(400).json({ error: 'no_parent_dir', message: 'set parentDir in preferences first' })
    }
    if (!isInside(prefs.parentDir, target)) {
      // Mirror F4: bad client input → 400, not 500.
      return res.status(400).json({ error: 'outside_parent_dir', message: 'path is not inside parentDir' })
    }
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      return res.status(400).json({ error: 'no_such_repo', message: 'path does not exist or is not a directory' })
    }
    try {
      await switchRepo(target, { reason: 'manual' })
      res.json({
        ok: true,
        repo: { path: target, name: target.split('/').filter(Boolean).pop() || target },
      })
    } catch (err) {
      logger?.warn({ err: String(err) }, 'repo select failed')
      res.status(500).json({ error: 'switch_failed', message: String(err?.message ?? err) })
    }
  })

  // ── preferences ──────────────────────────────────────────────────────────

  router.get('/api/preferences', (req, res) => {
    const p = preferences.get()
    res.json({
      parentDir: p.parentDir,
      autoSwitch: p.autoSwitch,
      currentRepo: p.currentRepo,
      iterationWindowMs: p.iterationWindowMs,
      needsSetup: !!p.needsSetup,
    })
  })

  router.post('/api/preferences', async (req, res) => {
    const body = req.body ?? {}
    const update = {}

    if ('parentDir' in body) {
      const parentDir = typeof body.parentDir === 'string' ? body.parentDir : ''
      if (!parentDir) {
        return res.status(400).json({ error: 'invalid_parent_dir', message: 'parentDir must be a non-empty string' })
      }
      const absParent = resolve(parentDir)
      if (!existsSync(absParent) || !statSync(absParent).isDirectory()) {
        return res.status(400).json({ error: 'parent_dir_not_found', message: 'parentDir does not exist or is not a directory' })
      }
      // Anti-escape: if parentDir is itself a symlink, resolve it and
      // confirm the real path equals the literal one. This blocks the
      // "symlink pointing somewhere unexpected" vector without forcing
      // users to keep all projects under $HOME (which excludes the
      // common D:\projects / /Volumes/data setups).
      try {
        const real = realpathSync(absParent)
        if (real !== absParent) {
          return res.status(400).json({
            error: 'parent_dir_is_symlink',
            message: 'parentDir is a symlink; point to the real directory instead',
          })
        }
      } catch (err) {
        return res.status(400).json({ error: 'parent_dir_not_found', message: String(err?.message ?? err) })
      }
      update.parentDir = absParent
    }
    if ('autoSwitch' in body) update.autoSwitch = !!body.autoSwitch
    if ('iterationWindowMs' in body) update.iterationWindowMs = body.iterationWindowMs

    try {
      const saved = await preferences.save(update)
      // If parentDir changed, the repo detector points at a stale dir.
      if ('parentDir' in update) rebuildRepoDetector?.()
      res.json({
        ok: true,
        preferences: {
          parentDir: saved.parentDir,
          autoSwitch: saved.autoSwitch,
          currentRepo: saved.currentRepo,
          iterationWindowMs: saved.iterationWindowMs,
          needsSetup: !!saved.needsSetup,
        },
      })
    } catch (err) {
      if (err instanceof TypeError) {
        return res.status(400).json({ error: 'invalid_preferences', message: err.message })
      }
      logger?.warn({ err: String(err) }, 'preferences save failed')
      res.status(500).json({ error: 'preferences_save_failed', message: String(err?.message ?? err) })
    }
  })

  return router
}
