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
import { DiffProvider, PathTraversalError, InvalidRefError } from './diffProvider.js'
import { readHeadSha, shortSha } from './gitSha.js'
import { makeRateLimiter } from './security.js'
import { getStats as getMcpStats } from '../mcp/stats.js'
import { DEFAULT_RESPONSE_CAP, HARD_RESPONSE_CAP } from './knowledgeGraph.js'
import { buildMarkdownReport, buildHtmlReport } from './reportBuilder.js'

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
  blastRadiusRoot,
  // rc8.4+: absolute path to the JSONL log directory. Used by the
  // hook-installer endpoints to assemble the --log-dir flag in the
  // Claude Code PostToolUse command. Production wires from
  // process.env.BLASTRADIUS_LOG_DIR (already validated at boot in
  // src/server/index.js). Tests can pass any string.
  logDir,
  serverStartSha,
  getAutoSwitchSnoozedUntil,
  // rc8+: multi-repo KnowledgeStore singleton, used by POST
  // /api/graph/node to persist agent-provided summaries. Optional
  // for backward compat with any caller that didn't pass it (those
  // calls return 503 on the write endpoint).
  knowledgeStore,
}) {
  const router = Router()

  // ── health ───────────────────────────────────────────────────────────────
  router.get('/api/health', (req, res) => {
    const ctx = getRepoContext?.()
    const graph = ctx?.graphResolver?.getGraph()
    const prefs = preferences.get()
    // Read the current on-disk HEAD fresh each call so the frontend can
    // detect that the server is running stale code after a commit. Cheap
    // (no shell out, just two small file reads via gitSha.js).
    const currentSha = blastRadiusRoot ? readHeadSha(blastRadiusRoot) : null
    const stale = !!(currentSha && serverStartSha && currentSha !== serverStartSha)
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
      // Version awareness — frontend uses this to surface a "restart"
      // banner when the running server lags behind HEAD.
      serverStartSha: serverStartSha ?? null,
      serverStartShaShort: serverStartSha ? shortSha(serverStartSha) : null,
      currentSha: currentSha ?? null,
      currentShaShort: currentSha ? shortSha(currentSha) : null,
      stale,
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

  /**
   * Strict YYYY-MM-DD validator. Used by the rc7+ date-range query
   * parameters on /api/heat. We deliberately reject ISO with time
   * components — the UI surface for rc7 is whole-day granularity and
   * accepting time would invite ambiguity over timezone.
   */
  const DATE_YMD_RE = /^\d{4}-\d{2}-\d{2}$/

  /**
   * Parse a YYYY-MM-DD into a Date pinned at local midnight. Returns
   * null on any malformed input including the same-shape-but-invalid
   * cases (e.g. 2025-02-30, 2025-13-01).
   */
  function parseYmd(s) {
    if (typeof s !== 'string' || !DATE_YMD_RE.test(s)) return null
    const [y, m, d] = s.split('-').map(Number)
    const dt = new Date(y, m - 1, d)
    // Round-trip check — catches "2025-02-30" (which JS would accept
    // as March 2nd) and similar overflow cases.
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
      return null
    }
    return dt
  }

  router.get('/api/heat', async (req, res) => {
    const ctx = getRepoContext?.()
    if (!ctx) return res.status(STATUS_NEEDS_SETUP).json({ error: 'no_active_repo', needsSetup: true })

    // ── rc7+ date-range parsing ──────────────────────────────────────
    //
    // When BOTH `since` and `until` are provided, the route loads
    // events from EventStore.loadDays() instead of getEventsForRepo()
    // and feeds them through the same computeHeat() pipeline. When
    // neither is provided the route behaves EXACTLY as in rc6 — fully
    // backward compatible.
    //
    // Validation order:
    //   1. Both params must be present together (one without the
    //      other is a bad request — be explicit instead of silently
    //      defaulting).
    //   2. Both must match /^\d{4}-\d{2}-\d{2}$/ and round-trip
    //      through Date construction (rejects 2025-02-30 etc.).
    //   3. until >= since.
    //   4. Range must fit within MAX_RANGE_DAYS (the EventStore cap;
    //      we re-validate at the API boundary so the user gets a 400
    //      instead of a 500 wrapping a RangeError).
    const sinceRaw = typeof req.query.since === 'string' ? req.query.since : ''
    const untilRaw = typeof req.query.until === 'string' ? req.query.until : ''
    const isRangeRequest = sinceRaw !== '' || untilRaw !== ''
    let from = null
    let to = null
    if (isRangeRequest) {
      if (!sinceRaw || !untilRaw) {
        return res.status(400).json({
          error: 'date_range_incomplete',
          message: '`since` and `until` must be provided together (YYYY-MM-DD).',
        })
      }
      from = parseYmd(sinceRaw)
      to = parseYmd(untilRaw)
      if (!from || !to) {
        return res.status(400).json({
          error: 'date_range_invalid',
          message: '`since` and `until` must be valid YYYY-MM-DD dates.',
        })
      }
      if (to < from) {
        return res.status(400).json({
          error: 'date_range_inverted',
          message: '`until` must be on or after `since`.',
        })
      }
      // Cap check (mirrors EventStore.MAX_RANGE_DAYS = 30). Computed
      // here so we return 400 with a clear message rather than 500
      // wrapping the RangeError from EventStore.
      const MAX_DAYS = 30
      const spanDays = Math.round((to - from) / 86400000) + 1
      if (spanDays > MAX_DAYS) {
        return res.status(400).json({
          error: 'date_range_too_wide',
          message: `Range spans ${spanDays} days; the maximum allowed is ${MAX_DAYS}.`,
        })
      }
    }

    try {
      const windowName = typeof req.query.window === 'string' ? req.query.window : 'session'
      const platform = typeof req.query.platform === 'string' ? req.query.platform : 'all'
      const totalFiles = await ctx.treeScanner.countFiles()
      // The tree set is the source of truth for "renderable files" —
      // anything not in here would be invisible in the tree pane and
      // shouldn't pollute the counters.
      const treeFiles = await ctx.treeScanner.getFileSet()
      const graph = ctx.graphResolver.getGraph()

      // Date-range query → load historical events for the range and
      // skip the time-window filtering in computeHeat (the range IS
      // the window). Otherwise → original rc6 path, byte-identical.
      let events
      let effectiveWindow = windowName
      if (isRangeRequest) {
        await eventStore.loadDays({ from, to })
        events = eventStore.getEventsForRepoInRange(ctx.repoPath, { from, to })
        // 'session' window means "no time filter" inside computeHeat —
        // exactly what we want once events have already been
        // pre-filtered by the date range. Documented in heatEngine
        // resolveWindow() table.
        effectiveWindow = 'session'
      } else {
        // Per-repo event slice — events are filtered by cwd === ctx.repoPath.
        events = eventStore.getEventsForRepo(ctx.repoPath)
      }

      const result = computeHeat({
        events,
        window: effectiveWindow,
        now: new Date(),
        totalFiles,
        graph,
        depth,
        iterationStartedAt: iterationMarker?.get() ?? null,
        treeFiles,
        platform,
      })
      // Surface the resolved range in the response so the frontend
      // can label the heat map ("heat for 2026-05-20 → 2026-05-26").
      if (isRangeRequest) {
        result.range = { from: sinceRaw, to: untilRaw }
      }
      res.json(result)
    } catch (err) {
      logger?.warn({ err: String(err) }, 'heat compute failed')
      res.status(500).json({ error: 'heat_compute_failed', message: String(err?.message ?? err) })
    }
  })

  router.get('/api/events', (req, res) => {
    sse.addClient(res)
  })

  // /api/diff is by far the most expensive endpoint: each call spawns
  // up to two `git diff` invocations (numstat + patch), each of which
  // can take 100-500 ms on a large file. A misbehaving frontend (or
  // hostile JS in an unrelated tab) could spam it and lock the event
  // loop. The token-bucket limiter below caps a single IP to 30
  // requests in a 10-second burst, sustained at 12/s (~720/min). That
  // is plenty for hover-prefetch + click-to-open flows but cuts any
  // pathological loop short. The rest of the API stays unlimited —
  // /api/heat is in-memory only and /api/tree is cached.
  const diffRateLimit = makeRateLimiter({
    maxTokens: 30,
    refillTokens: 12,
    refillIntervalMs: 1_000,
    onRateLimit: (req) => {
      logger?.warn({ ip: req.ip || req.socket?.remoteAddress }, 'diff rate-limited')
    },
  })

  router.get('/api/diff', diffRateLimit, async (req, res) => {
    const ctx = getRepoContext?.()
    if (!ctx) return res.status(STATUS_NEEDS_SETUP).json({ error: 'no_active_repo', needsSetup: true })
    const filePath = typeof req.query.path === 'string' ? req.query.path : ''
    // Default "auto" picks uncommitted changes, falling back to the
    // last commit that touched the file. Explicit `against=<ref>` still
    // works for advanced callers. "HEAD" stays a valid explicit ref.
    const against = typeof req.query.against === 'string' && req.query.against
      ? req.query.against
      : 'auto'
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
    // Surface BOTH the explicit marker (null until the user closes an
    // iteration for the first time) AND the effective window start +
    // last-event timestamp, so the UI can paint useful values even
    // when no manual marker has been set yet.
    //
    // Why this matters: before, the iteration panel showed "—" for
    // STARTED and LAST ACTIVITY whenever the user opened it without a
    // prior SSE heat-update — the panel looked dead even with real
    // activity in the window.
    const ITERATION_WINDOW_MS = 3 * 60 * 1000
    const now = Date.now()
    const explicitStart = iterationMarker?.get?.() ?? null
    const effectiveStartMs = explicitStart instanceof Date && !Number.isNaN(explicitStart.getTime())
      ? explicitStart.getTime()
      : now - ITERATION_WINDOW_MS

    // Compute lastEventTs by scanning this repo's slice of the day's
    // events, filtered to the active iteration window. Cheap — we
    // already do this work for /api/heat.
    let lastEventTs = null
    try {
      const ctx = getRepoContext?.()
      if (ctx) {
        const events = eventStore.getEventsForRepo(ctx.repoPath)
        for (const ev of events) {
          if (!ev?.ts) continue
          const ms = Date.parse(ev.ts)
          if (!Number.isFinite(ms)) continue
          if (ms < effectiveStartMs) continue
          if (lastEventTs === null || ms > lastEventTs) lastEventTs = ms
        }
      }
    } catch (err) {
      logger?.warn({ err: String(err?.message ?? err) }, 'iteration last-event scan failed')
    }

    res.json({
      iterationStartedAt: iterationMarker?.getIso() ?? null,
      // Always set: either the explicit marker or `now - 3 min`.
      effectiveStart: new Date(effectiveStartMs).toISOString(),
      // True when the user has explicitly closed an iteration before
      // — the panel uses this to choose between "Started HH:mm:ss"
      // and "3-min rolling window".
      isExplicit: explicitStart instanceof Date,
      lastEventTs: lastEventTs ? new Date(lastEventTs).toISOString() : null,
    })
  })

  router.get('/api/iteration/summary', async (req, res) => {
    const ctx = getRepoContext?.()
    if (!ctx) return res.status(STATUS_NEEDS_SETUP).json({ error: 'no_active_repo', needsSetup: true })
    try {
      const totalFiles = await ctx.treeScanner.countFiles()
      const treeFiles = await ctx.treeScanner.getFileSet()
      const graph = ctx.graphResolver.getGraph()
      const events = eventStore.getEventsForRepo(ctx.repoPath)
      const result = computeHeat({
        events,
        window: 'iteration',
        now: new Date(),
        totalFiles,
        graph,
        depth,
        iterationStartedAt: iterationMarker?.get() ?? null,
        treeFiles,
        platform: 'all',
      })

      const redFiles = Object.keys(result.files).filter((p) => result.files[p] === 'red')
      const greenFiles = Object.keys(result.files).filter((p) => result.files[p] === 'green')
      const yellowFiles = Object.keys(result.files).filter((p) => result.files[p] === 'yellow')

      res.json({
        msg: 'BlastRadius Iteration Summary for AI Agents',
        iterationStartedAt: iterationMarker?.getIso() ?? null,
        metrics: result.metrics,
        activities: {
          edited: redFiles.map((path) => ({
            path,
            lastAgent: result.attributions[path] || 'Unknown',
          })),
          read: greenFiles.map((path) => ({
            path,
            lastAgent: result.attributions[path] || 'Unknown',
          })),
          affected: yellowFiles.map((path) => ({
            path,
            impactedBy: (result.propagation[path] || []).map(
              (p) => `${p.path} (depth ${p.depth})`
            ),
          })),
        },
      })
    } catch (err) {
      logger?.warn({ err: String(err?.message ?? err) }, 'iteration summary failed')
      res.status(500).json({ error: 'summary_failed', message: String(err?.message ?? err) })
    }
  })

  router.post('/api/iteration/close', (req, res) => {
    if (!iterationMarker) {
      return res.status(503).json({ error: 'iteration_marker_unavailable' })
    }
    const at = iterationMarker.close()
    sse?.broadcast('iteration-update', { iterationStartedAt: at.toISOString() })
    res.json({ iterationStartedAt: at.toISOString() })
  })

  // ── Session report export (rc8.6) ────────────────────────────────────────
  //
  // GET /api/report.md   → Markdown digest (downloaded as a .md file)
  // GET /api/report.html → printable HTML (Ctrl+P → Save as PDF)
  //
  // Both read the same live heat result + knowledge-graph snapshot and
  // hand a plain data object to the pure formatters in reportBuilder.js.
  // No user-supplied paths to validate — the report is always scoped to
  // the active repo. `?window=` mirrors /api/heat (session|iteration|
  // hour|day), default session.

  /** Gather the report data object from the active repo context. */
  async function gatherReportData(ctx, windowName) {
    const totalFiles = await ctx.treeScanner.countFiles()
    const treeFiles = await ctx.treeScanner.getFileSet()
    const graph = ctx.graphResolver.getGraph()
    const events = eventStore.getEventsForRepo(ctx.repoPath)
    const result = computeHeat({
      events,
      window: windowName,
      now: new Date(),
      totalFiles,
      graph,
      depth,
      iterationStartedAt: iterationMarker?.get() ?? null,
      treeFiles,
      platform: 'all',
    })
    const colorFiles = (color) => Object.keys(result.files).filter((p) => result.files[p] === color)
    const edited = colorFiles('red').map((path) => ({ path, agent: result.attributions[path] || 'Unknown' }))
    const read = colorFiles('green').map((path) => ({ path, agent: result.attributions[path] || 'Unknown' }))
    const affected = colorFiles('yellow').map((path) => ({
      path,
      impactedBy: (result.propagation[path] || []).map((p) => `${p.path} (depth ${p.depth})`),
    }))

    // Knowledge-graph stats are optional (rc8+). Null when not built.
    let graphStats = null
    const snap = ctx.knowledgeGraph?.getSnapshot?.()
    if (snap && snap.builtAt !== 0) graphStats = snap.stats

    return {
      repoName: ctx.repoPath.split('/').filter(Boolean).pop() || ctx.repoPath,
      repoPath: ctx.repoPath,
      generatedAt: new Date().toISOString(),
      window: windowName,
      metrics: result.metrics,
      edited,
      read,
      affected,
      graph: graphStats,
    }
  }

  /** Filename-safe slug from the repo name + a date stamp. */
  function reportFilename(ctx, ext) {
    const base = (ctx.repoPath.split('/').filter(Boolean).pop() || 'report')
      .replace(/[^a-zA-Z0-9._-]/g, '-')
    const stamp = new Date().toISOString().slice(0, 10)
    return `blastradius-${base}-${stamp}.${ext}`
  }

  const REPORT_WINDOWS = new Set(['session', 'iteration', 'hour', 'day'])
  function reportWindow(req) {
    const w = typeof req.query.window === 'string' ? req.query.window : 'session'
    return REPORT_WINDOWS.has(w) ? w : 'session'
  }

  router.get('/api/report.md', async (req, res) => {
    const ctx = getRepoContext?.()
    if (!ctx) return res.status(STATUS_NEEDS_SETUP).json({ error: 'no_active_repo', needsSetup: true })
    try {
      const data = await gatherReportData(ctx, reportWindow(req))
      const md = buildMarkdownReport(data)
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${reportFilename(ctx, 'md')}"`)
      res.send(md)
    } catch (err) {
      logger?.warn({ err: String(err?.message ?? err) }, 'report.md failed')
      res.status(500).json({ error: 'report_failed', message: String(err?.message ?? err) })
    }
  })

  router.get('/api/report.html', async (req, res) => {
    const ctx = getRepoContext?.()
    if (!ctx) return res.status(STATUS_NEEDS_SETUP).json({ error: 'no_active_repo', needsSetup: true })
    try {
      const data = await gatherReportData(ctx, reportWindow(req))
      const html = buildHtmlReport(data)
      // Inline (not attachment) so the browser renders it for Ctrl+P.
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.send(html)
    } catch (err) {
      logger?.warn({ err: String(err?.message ?? err) }, 'report.html failed')
      res.status(500).json({ error: 'report_failed', message: String(err?.message ?? err) })
    }
  })

  // ── Days with activity (rc7+) ────────────────────────────────────────────
  //
  // Read-only enumeration of session-*.jsonl files under
  // BLASTRADIUS_LOG_DIR. Powers the dashboard's date-range picker
  // (so the UI can disable / dim dates that have no data behind them)
  // and the MCP `list_days_with_activity` tool. Capped at
  // MAX_RANGE_DAYS most-recent entries to keep the response small
  // and bounded.
  router.get('/api/days', async (req, res) => {
    try {
      const days = await eventStore.listDaysWithActivity()
      res.json({ days })
    } catch (err) {
      logger?.warn({ err: String(err?.message ?? err) }, 'list days failed')
      res.status(500).json({ error: 'list_days_failed', message: String(err?.message ?? err) })
    }
  })

  // ── Knowledge Graph (rc8+) ───────────────────────────────────────────────
  //
  // 6 endpoints under /api/graph/* that expose the KnowledgeGraph
  // snapshot maintained by RepoContext.knowledgeGraph. All paths
  // reaching this layer go through `validateRepoRelPath()` (a thin
  // wrapper around DiffProvider.validatePath — single source of truth
  // for path traversal defense).
  //
  // Caps:
  //   - default response cap        = 200 nodes
  //   - hard cap (via ?limit=)      = 1000 nodes
  //   - summary body                = 2000 chars  (enforced in store)
  //   - tags                        = 20 × 32     (enforced in store)
  //
  // Behaviour when no active repo or knowledge graph not yet built:
  //   503 + { error: 'no_active_repo' | 'graph_not_ready', needsSetup? }
  //
  // The structural reads (nodes / cycles / orphans) are O(1) lookups
  // on cached Maps — Express does no work the watcher hasn't already
  // amortised. The single write surface POST /api/graph/node performs
  // an atomic JSON-file replace via knowledgeStore.

  /**
   * Validate a repo-relative path against the active repo root using
   * the same validator that /api/diff has used since Phase 4. Throws
   * PathTraversalError on rejection; returns the absolute resolved
   * path on success. Callers map the throw to a 400 with the error's
   * `code` as the machine-readable reason.
   */
  function validateRepoRelPath(repoPath, raw) {
    return DiffProvider.validatePath(repoPath, raw)
  }

  /** Cap normalization for any endpoint accepting ?limit=. */
  function resolveLimit(rawLimit) {
    const n = Number(rawLimit)
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_RESPONSE_CAP
    return Math.min(Math.floor(n), HARD_RESPONSE_CAP)
  }

  /** GET /api/graph — vista global del grafo, capada a `limit` nodos.
   *  Filtros opcionales: ?kinds=source,test  ?minFanIn=1  ?withSummaryOnly=1 */
  router.get('/api/graph', (req, res) => {
    const ctx = getRepoContext?.()
    if (!ctx) return res.status(STATUS_NEEDS_SETUP).json({ error: 'no_active_repo', needsSetup: true })
    const snap = ctx.knowledgeGraph.getSnapshot()
    if (snap.builtAt === 0) {
      return res.status(STATUS_NEEDS_SETUP).json({ error: 'graph_not_ready' })
    }
    const limit = resolveLimit(req.query.limit)
    const kinds = typeof req.query.kinds === 'string' && req.query.kinds
      ? new Set(req.query.kinds.split(',').map((s) => s.trim()).filter(Boolean))
      : null
    const minFanIn = Number.isFinite(Number(req.query.minFanIn)) ? Number(req.query.minFanIn) : 0
    const withSummaryOnly = req.query.withSummaryOnly === '1' || req.query.withSummaryOnly === 'true'

    // Build the node list with filters applied, then cap.
    const nodesOut = []
    for (const node of snap.nodes.values()) {
      if (kinds && !kinds.has(node.kind)) continue
      if (node.fanIn < minFanIn) continue
      if (withSummaryOnly && !node.summary) continue
      nodesOut.push(node)
    }
    nodesOut.sort((a, b) => b.fanIn - a.fanIn || a.path.localeCompare(b.path))
    const truncated = nodesOut.length > limit
    const nodes = truncated ? nodesOut.slice(0, limit) : nodesOut

    // Build the edge list scoped to the (possibly truncated) node set
    // so the response is internally consistent — no edges pointing at
    // nodes the client doesn't see.
    const nodeSet = new Set(nodes.map((n) => n.path))
    const edges = []
    const graph = ctx.graphResolver.getGraph()
    if (graph?.forward instanceof Map) {
      for (const [from, outgoing] of graph.forward) {
        if (!nodeSet.has(from)) continue
        for (const to of outgoing) {
          if (!nodeSet.has(to)) continue
          edges.push({ from, to })
        }
      }
    }

    // rc8.2+: surface aggregate stats as TOP-LEVEL fields. The nodes/
    // edges arrays below are slice-and-capped (limit/truncated); the
    // total counters always describe the FULL snapshot so the dashboard
    // header and downstream agents can trust them as the single source
    // of truth — no client-side `nodes.length` math. `stats` stays as
    // a backwards-compatible alias so rc8.1 dashboard code (and any
    // third-party reader that already shipped) keeps working.
    const aggregate = snap.stats
    res.json({
      builtAt: new Date(snap.builtAt).toISOString(),
      totalNodes: aggregate.nodes,
      totalEdges: aggregate.edges,
      cycleCount: aggregate.cycles,
      orphanCount: aggregate.orphans,
      withSummary: aggregate.withSummary,
      // Backwards-compat alias (rc8.1 dashboard reads body.stats.*).
      stats: aggregate,
      nodes,
      edges,
      truncated,
      limit,
    })
  })

  /** GET /api/graph/neighbors?path=...&depth=2&direction=both */
  router.get('/api/graph/neighbors', (req, res) => {
    const ctx = getRepoContext?.()
    if (!ctx) return res.status(STATUS_NEEDS_SETUP).json({ error: 'no_active_repo', needsSetup: true })
    const snap = ctx.knowledgeGraph.getSnapshot()
    if (snap.builtAt === 0) return res.status(STATUS_NEEDS_SETUP).json({ error: 'graph_not_ready' })

    const rawPath = typeof req.query.path === 'string' ? req.query.path : ''
    if (!rawPath) return res.status(400).json({ error: 'invalid_path', message: 'query param `path` is required' })
    try {
      validateRepoRelPath(ctx.repoPath, rawPath)
    } catch (err) {
      if (err instanceof PathTraversalError) {
        return res.status(400).json({ error: err.code, message: err.message })
      }
      throw err
    }

    const depthRaw = Number(req.query.depth)
    const depth = Number.isInteger(depthRaw) && depthRaw > 0 ? Math.min(depthRaw, 10) : 2
    const direction = typeof req.query.direction === 'string' ? req.query.direction : 'both'
    if (!['consumers', 'dependencies', 'both'].includes(direction)) {
      return res.status(400).json({ error: 'invalid_direction', message: 'direction must be consumers | dependencies | both' })
    }

    const node = snap.nodes.get(rawPath)
    if (!node) {
      return res.json({ path: rawPath, depth, consumers: [], dependencies: [], reason: 'unknown_node' })
    }

    const graph = ctx.graphResolver.getGraph()
    const consumers = []
    const dependencies = []

    if (direction === 'consumers' || direction === 'both') {
      // BFS up the reverse graph using the existing consumersOfWithDepth
      // semantics, but inlined here so we can attach fanIn metadata.
      const visited = new Set([rawPath])
      let frontier = new Set([rawPath])
      for (let lvl = 0; lvl < depth; lvl++) {
        const next = new Set()
        for (const n of frontier) {
          const parents = graph.reverse?.get(n)
          if (!parents) continue
          for (const p of parents) {
            if (visited.has(p)) continue
            visited.add(p)
            next.add(p)
            consumers.push({ path: p, depth: lvl + 1, fanIn: snap.nodes.get(p)?.fanIn ?? 0 })
          }
        }
        if (next.size === 0) break
        frontier = next
      }
    }
    if (direction === 'dependencies' || direction === 'both') {
      // BFS down the forward graph.
      const visited = new Set([rawPath])
      let frontier = new Set([rawPath])
      for (let lvl = 0; lvl < depth; lvl++) {
        const next = new Set()
        for (const n of frontier) {
          const children = graph.forward?.get(n)
          if (!children) continue
          for (const c of children) {
            if (visited.has(c)) continue
            visited.add(c)
            next.add(c)
            dependencies.push({ path: c, depth: lvl + 1, fanOut: snap.nodes.get(c)?.fanOut ?? 0 })
          }
        }
        if (next.size === 0) break
        frontier = next
      }
    }

    res.json({ path: rawPath, depth, direction, consumers, dependencies })
  })

  /** GET /api/graph/node?path=... — single-node detail. */
  router.get('/api/graph/node', (req, res) => {
    const ctx = getRepoContext?.()
    if (!ctx) return res.status(STATUS_NEEDS_SETUP).json({ error: 'no_active_repo', needsSetup: true })
    const snap = ctx.knowledgeGraph.getSnapshot()
    if (snap.builtAt === 0) return res.status(STATUS_NEEDS_SETUP).json({ error: 'graph_not_ready' })

    const rawPath = typeof req.query.path === 'string' ? req.query.path : ''
    if (!rawPath) return res.status(400).json({ error: 'invalid_path', message: 'query param `path` is required' })
    try { validateRepoRelPath(ctx.repoPath, rawPath) }
    catch (err) {
      if (err instanceof PathTraversalError) return res.status(400).json({ error: err.code, message: err.message })
      throw err
    }

    const node = snap.nodes.get(rawPath)
    if (!node) return res.status(404).json({ error: 'unknown_node', path: rawPath })
    res.json({ node })
  })

  /** POST /api/graph/node — write summary + tags. The only mutation
   *  surface in /api/graph/*. Body shape: { path, summary, tags }. */
  router.post('/api/graph/node', async (req, res) => {
    const ctx = getRepoContext?.()
    if (!ctx) return res.status(STATUS_NEEDS_SETUP).json({ error: 'no_active_repo', needsSetup: true })

    const body = req.body ?? {}
    const rawPath = typeof body.path === 'string' ? body.path : ''
    if (!rawPath) return res.status(400).json({ error: 'invalid_path', message: 'body.path is required' })
    try { validateRepoRelPath(ctx.repoPath, rawPath) }
    catch (err) {
      if (err instanceof PathTraversalError) return res.status(400).json({ error: err.code, message: err.message })
      throw err
    }

    const summary = typeof body.summary === 'string' ? body.summary : ''
    const tags = Array.isArray(body.tags) ? body.tags : []
    try {
      const entry = await knowledgeStore.setNodeSummary(ctx.repoPath, rawPath, { summary, tags })
      // Refresh the in-memory snapshot's view of this single node so
      // a follow-up GET sees the new summary without waiting for a
      // full rebuild. Cheap mutation — single Map.set.
      const snap = ctx.knowledgeGraph.getSnapshot()
      const existing = snap.nodes.get(rawPath)
      if (existing) {
        existing.summary = entry.summary
        existing.tags = entry.tags
        existing.summaryUpdatedAt = entry.updatedAt
        snap.stats.withSummary = [...snap.nodes.values()].filter((n) => !!n.summary).length
      }
      sse?.broadcast('knowledge-graph-update', { at: new Date().toISOString(), path: rawPath, reason: 'summary-updated' })
      res.json({ ok: true, node: existing ?? null, entry })
    } catch (err) {
      // KnowledgeStore.setNodeSummary throws with a `code` field that
      // matches the documented NO-DATA reasons; surface verbatim.
      if (err?.code) {
        return res.status(400).json({ error: err.code, message: err.message })
      }
      logger?.warn({ err: String(err?.message ?? err) }, 'graph node write failed')
      res.status(500).json({ error: 'graph_node_write_failed', message: String(err?.message ?? err) })
    }
  })

  /** GET /api/graph/cycles — list of cyclic dependency chains. */
  router.get('/api/graph/cycles', (req, res) => {
    const ctx = getRepoContext?.()
    if (!ctx) return res.status(STATUS_NEEDS_SETUP).json({ error: 'no_active_repo', needsSetup: true })
    const snap = ctx.knowledgeGraph.getSnapshot()
    if (snap.builtAt === 0) return res.status(STATUS_NEEDS_SETUP).json({ error: 'graph_not_ready' })
    res.json({ cycles: snap.cycles, count: snap.cycles.length })
  })

  /** GET /api/graph/orphans — files with fanIn === 0 outside the
   *  entry-point allowlist. Candidates for dead-code review. */
  router.get('/api/graph/orphans', (req, res) => {
    const ctx = getRepoContext?.()
    if (!ctx) return res.status(STATUS_NEEDS_SETUP).json({ error: 'no_active_repo', needsSetup: true })
    const snap = ctx.knowledgeGraph.getSnapshot()
    if (snap.builtAt === 0) return res.status(STATUS_NEEDS_SETUP).json({ error: 'graph_not_ready' })
    res.json({ orphans: snap.orphans, count: snap.orphans.length })
  })

  // ── MCP usage stats ──────────────────────────────────────────────────────
  //
  // Read-only snapshot of the in-memory counter maintained by
  // src/mcp/stats.js. Surfaces total/tools/resources/other plus a
  // sorted byName breakdown and clientInfo.name aggregation. The
  // frontend polls this on a 5 s interval AND subscribes to the
  // SSE 'mcp-stats-update' event for sub-second updates during
  // bursts of agent activity.
  router.get('/api/mcp/stats', (req, res) => {
    res.json(getMcpStats())
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
    // Surface the in-memory snooze so the UI can paint the auto button
    // accordingly. Only forward future timestamps — past ones are dead
    // weight that would just confuse the client.
    const snoozedUntil = getAutoSwitchSnoozedUntil?.() ?? null
    const snoozedActiveUntil = snoozedUntil && snoozedUntil > Date.now()
      ? snoozedUntil
      : null
    res.json({
      parentDir: p.parentDir,
      autoSwitch: p.autoSwitch,
      currentRepo: p.currentRepo,
      iterationWindowMs: p.iterationWindowMs,
      // rc8+: surface the persisted view mode so the frontend can pick
      // Tree or Graph on boot instead of always starting on Tree.
      viewMode: p.viewMode,
      // rc8.4+: opt-out list for the hook auto-install banner.
      ignoredHookRepos: Array.isArray(p.ignoredHookRepos) ? p.ignoredHookRepos : [],
      needsSetup: !!p.needsSetup,
      autoSwitchSnoozedUntil: snoozedActiveUntil,
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
    // rc8+: viewMode is normalized by preferences.normalize() which
    // throws TypeError if the value isn't in VIEW_MODES — we let it
    // bubble down to the catch block below as `invalid_preferences`.
    if ('viewMode' in body) update.viewMode = body.viewMode
    // rc8.4+: ignoredHookRepos same pattern — normalize() validates
    // shape (array of non-empty strings), and lets TypeError bubble
    // as `invalid_preferences` on bad input.
    if ('ignoredHookRepos' in body) update.ignoredHookRepos = body.ignoredHookRepos

    try {
      const saved = await preferences.save(update)
      if ('parentDir' in update) {
        // 1. Repo detector cache is now stale; rebuild against the new
        //    parent dir on the next /api/repos hit.
        rebuildRepoDetector?.()
        // 2. The current repo may no longer be a descendant of the new
        //    parent. If so, detach the active repo (set null) so the
        //    UI nudges the user to pick a new one. switchRepo handles
        //    watcher repointing + iterationMarker reset.
        if (saved.currentRepo && !isInside(saved.parentDir, saved.currentRepo)) {
          await switchRepo?.(null, { reason: 'parent_dir_changed' })
        }
        // 3. Tell every connected client the repo list has changed even
        //    if the active one didn't — the dropdown must repopulate.
        sse?.broadcast('repos-updated', { at: new Date().toISOString() })
      }
      res.json({
        ok: true,
        preferences: {
          parentDir: saved.parentDir,
          autoSwitch: saved.autoSwitch,
          currentRepo: saved.currentRepo,
          iterationWindowMs: saved.iterationWindowMs,
          viewMode: saved.viewMode,
          ignoredHookRepos: Array.isArray(saved.ignoredHookRepos) ? saved.ignoredHookRepos : [],
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

  // ── /api/repo/hook-status + /api/repo/install-hook (rc8.4+) ──────────────
  //
  // The dashboard calls these to decide whether to show the
  // "Observability hook not installed" banner and to act on the user's
  // one-click activation.
  //
  // Security gates (POST only):
  //   - path must be a non-empty absolute string with no NUL bytes
  //   - path must resolve inside preferences.parentDir (or equal it)
  //     — that's the load-bearing rule. A path outside parentDir is
  //     rejected at the boundary, NEVER passed to the installer.
  //
  // GET is read-only and tolerates paths outside parentDir (the
  // installer module itself rejects them with reason='not_a_git_repo'
  // or similar), so the frontend can ask about any repo it pleases.

  router.get('/api/repo/hook-status', async (req, res) => {
    const rawPath = typeof req.query.path === 'string' ? req.query.path : ''
    if (!rawPath) {
      return res.status(400).json({ error: 'invalid_path', message: 'query param `path` is required' })
    }
    // Same early-validation pattern as the POST below, so traversal
    // gets a clean 400 instead of an inscrutable installer error.
    if (rawPath.includes('\0')) {
      return res.status(400).json({ error: 'nul_byte', message: 'path contains a NUL byte' })
    }
    if (rawPath.includes('..')) {
      return res.status(400).json({ error: 'escapes_root', message: 'path contains a `..` segment' })
    }
    const { getHookStatus } = await import('./hookInstaller.js')
    try {
      const status = await getHookStatus(rawPath, {
        logDir,
        blastRadiusRoot,
      })
      res.json(status)
    } catch (err) {
      logger?.warn({ err: String(err) }, 'hook-status failed')
      res.status(500).json({ error: 'hook_status_failed', message: String(err?.message ?? err) })
    }
  })

  router.post('/api/repo/install-hook', async (req, res) => {
    const body = req.body ?? {}
    const rawPath = typeof body.path === 'string' ? body.path : ''
    if (!rawPath) {
      return res.status(400).json({ error: 'invalid_path', message: 'body.path is required' })
    }
    if (rawPath.includes('\0')) {
      return res.status(400).json({ error: 'nul_byte', message: 'path contains a NUL byte' })
    }
    if (rawPath.includes('..')) {
      return res.status(400).json({ error: 'escapes_root', message: 'path contains a `..` segment' })
    }
    // parentDir gate — the load-bearing security check. The installer
    // can ONLY write to a `.claude/settings.json` under a repo the
    // user has explicitly declared as part of their workspace.
    const prefs = preferences.get()
    if (!prefs.parentDir) {
      return res.status(400).json({ error: 'no_parent_dir', message: 'preferences.parentDir is not configured' })
    }
    const absRepo = resolve(rawPath)
    if (!isInside(prefs.parentDir, absRepo)) {
      return res.status(400).json({
        error: 'repo_outside_parent_dir',
        message: `path is not inside preferences.parentDir (${prefs.parentDir})`,
      })
    }
    const { installHook } = await import('./hookInstaller.js')
    try {
      const result = await installHook(absRepo, {
        logDir,
        blastRadiusRoot,
      })
      if (!result.ok) {
        // Map installer's NO-DATA reasons to 400 — they're caller-input
        // failures (bad path, missing .git, etc.), not server bugs.
        return res.status(400).json({ error: result.reason, message: `install failed: ${result.reason}` })
      }
      sse?.broadcast('hook-installed', {
        at: new Date().toISOString(),
        path: result.settingsPath,
        action: result.action,
      })
      res.json(result)
    } catch (err) {
      logger?.warn({ err: String(err) }, 'install-hook failed')
      res.status(500).json({ error: 'install_failed', message: String(err?.message ?? err) })
    }
  })

  return router
}
