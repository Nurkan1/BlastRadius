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
import { createHash } from 'node:crypto'
import { buildMarkdownReport, buildHtmlReport, buildReportFragment } from './reportBuilder.js'
import { buildAiContextText } from './ai/context.js'

// The agent/platform filter is a closed set (mirrors the dashboard's
// platform toggle). ?platform= is clamped against it so an arbitrary value
// can never flow into heat filtering or the exported report (injection
// defense). Matching is case-insensitive and resolves to a CANONICAL
// display label: the dashboard sends lowercase (`claude`), but the report
// header should read "Claude". Anything outside the set falls back to
// 'all' (= no filter). The heat engine lowercases again before comparing,
// so the display casing here never affects which events match.
const PLATFORM_CANON = new Map([
  ['all', 'all'],
  ['claude', 'Claude'],
  ['antigravity', 'Antigravity'],
  ['manual', 'Manual'],
])

const STATUS_NEEDS_SETUP = 503

// Default context budget reported to the UI when the AI client doesn't
// expose one (e.g. a test fake). Mirrors ollama.js DEFAULT_NUM_CTX.
const DEFAULT_CONTEXT_LIMIT = 8192

/**
 * Rough token estimate for an outgoing chat prompt. We have no tokenizer on
 * the server, so we approximate at ~4 chars/token and add a flat budget per
 * attached image (vision tiles are expensive). It only drives a "context
 * getting full" hint in the UI — being approximate is fine; it must never be
 * presented as exact.
 */
function estimateAiTokens(messages) {
  let chars = 0
  let images = 0
  for (const m of messages || []) {
    chars += String(m?.content ?? '').length
    if (Array.isArray(m?.images)) images += m.images.length
  }
  return Math.ceil(chars / 4) + images * 700
}

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
  // rc9+: local Ollama client for the planning assistant. Optional —
  // when absent the /api/ai/* routes report Ollama as unavailable
  // instead of crashing. Injected so tests can pass a fake.
  aiClient,
  // rc9.1+: persists AI conversations + the per-project advice counter
  // under ~/.blastradius/conversations/. Optional — when absent the chat
  // still works, it just isn't saved.
  conversationStore,
  // rc9.4+: token-bucket parameters for the /api/ai/chat limiter. Defaults
  // are tuned for a human (small burst, then ~1 every 5s). Injectable so
  // tests can widen the bucket for functional cases or shrink it to assert
  // the 429 path deterministically.
  aiChatRateLimitOptions,
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

  // ── Shared heat/report filters ───────────────────────────────────────────
  //
  // Both /api/heat AND the report exports (/api/report.md|html) must
  // apply the SAME filters — window, platform/agent, and the rc7+
  // date range — or the exported report silently diverges from what the
  // dashboard shows (the bug rc8.6 fixes). parseHeatFilters() validates
  // the query once; computeHeatForFilters() turns those filters into a
  // heat result. Single source of truth for both surfaces.

  /**
   * Parse + validate the shared filter query params.
   *
   * Validation order (date range only applies when since/until present):
   *   1. Both must be present together (one without the other is a bad
   *      request — be explicit instead of silently defaulting).
   *   2. Both must match /^\d{4}-\d{2}-\d{2}$/ and round-trip through
   *      Date construction (rejects 2025-02-30 etc.).
   *   3. until >= since.
   *   4. Range must fit within MAX_RANGE_DAYS (the EventStore cap;
   *      re-validated here so the user gets a 400 rather than a 500
   *      wrapping a RangeError).
   *
   * @returns {{ ok: true, filters: {
   *     windowName: string, platform: string, isRangeRequest: boolean,
   *     sinceRaw: string, untilRaw: string, from: Date|null, to: Date|null,
   *   } } | { ok: false, status: number, body: object }}
   */
  function parseHeatFilters(req, source) {
    // The filter values normally come from the query string (/api/heat,
    // /api/report). rc9.8: the AI chat sends the SAME filter shape in its
    // JSON body (so the assistant is grounded in what the dashboard is
    // showing), so accept an explicit source object too.
    const q = source || req?.query || {}
    const windowName = typeof q.window === 'string' ? q.window : 'session'
    // Clamp the agent filter to the known set (case-insensitive) and resolve
    // to its canonical display label. Anything else → 'all'. This also stops
    // an arbitrary ?platform=… string from being interpolated into the
    // exported report (the Markdown variant isn't HTML-escaped).
    const rawPlatform = typeof q.platform === 'string' ? q.platform.trim().toLowerCase() : 'all'
    const platform = PLATFORM_CANON.get(rawPlatform) || 'all'
    const sinceRaw = typeof q.since === 'string' ? q.since : ''
    const untilRaw = typeof q.until === 'string' ? q.until : ''
    const isRangeRequest = sinceRaw !== '' || untilRaw !== ''
    let from = null
    let to = null
    if (isRangeRequest) {
      if (!sinceRaw || !untilRaw) {
        return { ok: false, status: 400, body: {
          error: 'date_range_incomplete',
          message: '`since` and `until` must be provided together (YYYY-MM-DD).',
        } }
      }
      from = parseYmd(sinceRaw)
      to = parseYmd(untilRaw)
      if (!from || !to) {
        return { ok: false, status: 400, body: {
          error: 'date_range_invalid',
          message: '`since` and `until` must be valid YYYY-MM-DD dates.',
        } }
      }
      if (to < from) {
        return { ok: false, status: 400, body: {
          error: 'date_range_inverted',
          message: '`until` must be on or after `since`.',
        } }
      }
      // Cap check (mirrors EventStore.MAX_RANGE_DAYS = 30).
      const MAX_DAYS = 30
      const spanDays = Math.round((to - from) / 86400000) + 1
      if (spanDays > MAX_DAYS) {
        return { ok: false, status: 400, body: {
          error: 'date_range_too_wide',
          message: `Range spans ${spanDays} days; the maximum allowed is ${MAX_DAYS}.`,
        } }
      }
    }
    return { ok: true, filters: { windowName, platform, isRangeRequest, sinceRaw, untilRaw, from, to } }
  }

  /**
   * Select the event slice for the given filters and run computeHeat.
   * When a date range is active the events are pre-filtered by range and
   * the time-window is neutralized to 'session' (no further time filter)
   * — identical to the rc7 heat path. Otherwise it's the original rc6
   * per-repo slice, byte-identical.
   */
  async function computeHeatForFilters(ctx, filters) {
    const { windowName, platform, isRangeRequest, from, to } = filters
    const totalFiles = await ctx.treeScanner.countFiles()
    // The tree set is the source of truth for "renderable files" —
    // anything not in here would be invisible in the tree pane and
    // shouldn't pollute the counters.
    const treeFiles = await ctx.treeScanner.getFileSet()
    const graph = ctx.graphResolver.getGraph()

    let events
    let effectiveWindow = windowName
    if (isRangeRequest) {
      await eventStore.loadDays({ from, to })
      events = eventStore.getEventsForRepoInRange(ctx.repoPath, { from, to })
      // 'session' = "no time filter" inside computeHeat — exactly what we
      // want once events are already pre-filtered by the date range.
      effectiveWindow = 'session'
    } else {
      events = eventStore.getEventsForRepo(ctx.repoPath)
    }

    return computeHeat({
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
  }

  router.get('/api/heat', async (req, res) => {
    const ctx = getRepoContext?.()
    if (!ctx) return res.status(STATUS_NEEDS_SETUP).json({ error: 'no_active_repo', needsSetup: true })

    const parsed = parseHeatFilters(req)
    if (!parsed.ok) return res.status(parsed.status).json(parsed.body)

    try {
      const result = await computeHeatForFilters(ctx, parsed.filters)
      // Surface the resolved range in the response so the frontend can
      // label the heat map ("heat for 2026-05-20 → 2026-05-26").
      if (parsed.filters.isRangeRequest) {
        result.range = { from: parsed.filters.sinceRaw, to: parsed.filters.untilRaw }
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
    // rc9.11: `commit=<sha>` shows what THAT commit changed (sha^..sha) — the
    // commit-investigation panel. Takes precedence over `against`.
    const commit = typeof req.query.commit === 'string' && req.query.commit ? req.query.commit : ''
    try {
      const result = commit
        ? await ctx.diffProvider.getCommitDiff(filePath, commit)
        : await ctx.diffProvider.getDiff(filePath, against)
      // `patch` (the raw unified diff, rc9.6) is for the in-process AI
      // "explain this file" flow only — strip it here so the diff modal's
      // HTTP payload isn't doubled by a plain-text copy of the HTML.
      const { patch, ...forModal } = result
      void patch
      res.json(forModal)
    } catch (err) {
      if (err instanceof PathTraversalError || err instanceof InvalidRefError) {
        return res.status(400).json({ error: err.code, message: err.message })
      }
      logger?.warn({ err: String(err?.message ?? err), path: filePath }, 'diff failed')
      res.status(500).json({ error: 'diff_failed', message: 'failed to render diff' })
    }
  })

  // ── Commits (rc9.11) ───────────────────────────────────────────────────────
  //
  // Read-only git-history investigation: list recent commits and the files
  // each touched, so the user can explore "what did this commit change?"
  // without dropping to a terminal. Per-file diffs reuse /api/diff?against=
  // <sha> (DiffProvider already supports an explicit ref). Same loopback +
  // rate-limit posture as /api/diff.
  router.get('/api/commits', diffRateLimit, async (req, res) => {
    const ctx = getRepoContext?.()
    if (!ctx) return res.status(STATUS_NEEDS_SETUP).json({ error: 'no_active_repo', needsSetup: true })
    try {
      const commits = await ctx.diffProvider.listCommits(req.query.limit)
      res.json({ commits })
    } catch (err) {
      logger?.warn({ err: String(err?.message ?? err) }, 'list commits failed')
      res.status(500).json({ error: 'commits_failed', message: 'failed to list commits' })
    }
  })

  router.get('/api/commits/:sha/files', diffRateLimit, async (req, res) => {
    const ctx = getRepoContext?.()
    if (!ctx) return res.status(STATUS_NEEDS_SETUP).json({ error: 'no_active_repo', needsSetup: true })
    try {
      const files = await ctx.diffProvider.commitFiles(req.params.sha)
      res.json({ sha: req.params.sha, files })
    } catch (err) {
      if (err instanceof InvalidRefError) {
        return res.status(400).json({ error: err.code, message: err.message })
      }
      logger?.warn({ err: String(err?.message ?? err), sha: req.params.sha }, 'commit files failed')
      res.status(500).json({ error: 'commit_files_failed', message: 'failed to read commit files' })
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
  // the active repo. The query honors the SAME filters as /api/heat
  // (window | platform | since/until date range) through the shared
  // parseHeatFilters() + computeHeatForFilters(), so an exported report
  // always matches what the dashboard is showing.

  /**
   * Gather the report data object from the active repo context, applying
   * the SAME filters as the dashboard (window / platform / date range)
   * via the shared computeHeatForFilters(). This is what makes the
   * exported report match what the user is actually looking at.
   */
  async function gatherReportData(ctx, filters) {
    const result = await computeHeatForFilters(ctx, filters)
    const colorFiles = (color) => Object.keys(result.files).filter((p) => result.files[p] === color)
    const edited = colorFiles('red').map((path) => ({ path, agent: result.attributions[path] || 'Unknown' }))
    const read = colorFiles('green').map((path) => ({ path, agent: result.attributions[path] || 'Unknown' }))
    const affected = colorFiles('yellow').map((path) => ({
      path,
      impactedBy: (result.propagation[path] || []).map((p) => `${p.path} (depth ${p.depth})`),
    }))

    // Knowledge-graph stats + annotations are optional (rc8+). Null /
    // empty when the graph isn't built. Annotations are the summaries +
    // tags persisted via set_node_summary (rc8.6 includes them so the
    // report carries the agent/human notes, not just raw activity).
    let graphStats = null
    const annotations = []
    const snap = ctx.knowledgeGraph?.getSnapshot?.()
    if (snap && snap.builtAt !== 0) {
      graphStats = snap.stats
      if (snap.nodes instanceof Map) {
        for (const node of snap.nodes.values()) {
          const hasTags = Array.isArray(node.tags) && node.tags.length > 0
          if (node.summary || hasTags) {
            annotations.push({
              path: node.path,
              summary: node.summary || '',
              tags: hasTags ? node.tags : [],
            })
          }
        }
        annotations.sort((a, b) => a.path.localeCompare(b.path))
      }
    }

    // rc9.2/rc9.6: session timeline + per-agent effort, so the AI grounding
    // can answer "when did the session start/end?" and "how much did the
    // agent do?". Only meaningful for the live (non-range) view; ISO strings
    // compare chronologically.
    let firstActivityAt = null
    let lastActivityAt = null
    const agentActivity = {} // { agentLabel: actionCount }
    if (!filters.isRangeRequest) {
      for (const e of eventStore.getEventsForRepo(ctx.repoPath)) {
        if (e && typeof e.ts === 'string') {
          if (!lastActivityAt || e.ts > lastActivityAt) lastActivityAt = e.ts
          if (!firstActivityAt || e.ts < firstActivityAt) firstActivityAt = e.ts
        }
        const agent = e && e.agent ? String(e.agent) : 'Unknown'
        agentActivity[agent] = (agentActivity[agent] || 0) + 1
      }
    }

    return {
      repoName: ctx.repoPath.split('/').filter(Boolean).pop() || ctx.repoPath,
      repoPath: ctx.repoPath,
      generatedAt: new Date().toISOString(),
      window: filters.windowName,
      platform: filters.platform,
      // When a date range is active the report header shows it instead
      // of the (then-meaningless) time-window. null otherwise.
      range: filters.isRangeRequest ? { from: filters.sinceRaw, to: filters.untilRaw } : null,
      firstActivityAt,
      lastActivityAt,
      agentActivity,
      metrics: result.metrics,
      edited,
      read,
      affected,
      graph: graphStats,
      annotations,
    }
  }

  /** Filename-safe slug from the repo name + a date stamp. */
  function reportFilename(ctx, ext) {
    const base = (ctx.repoPath.split('/').filter(Boolean).pop() || 'report')
      .replace(/[^a-zA-Z0-9._-]/g, '-')
    const stamp = new Date().toISOString().slice(0, 10)
    return `blastradius-${base}-${stamp}.${ext}`
  }

  router.get('/api/report.md', async (req, res) => {
    const ctx = getRepoContext?.()
    if (!ctx) return res.status(STATUS_NEEDS_SETUP).json({ error: 'no_active_repo', needsSetup: true })
    const parsed = parseHeatFilters(req)
    if (!parsed.ok) return res.status(parsed.status).json(parsed.body)
    try {
      const data = await gatherReportData(ctx, parsed.filters)
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
    const parsed = parseHeatFilters(req)
    if (!parsed.ok) return res.status(parsed.status).json(parsed.body)
    try {
      const data = await gatherReportData(ctx, parsed.filters)
      // ?embed=1 → an HTML fragment (scoped <style> + <div>) that the
      // dashboard injects into its in-app report modal. Otherwise → a
      // full standalone document for direct viewing / Ctrl+P.
      const html = req.query.embed === '1'
        ? buildReportFragment(data)
        : buildHtmlReport(data)
      // Inline (not attachment) so the browser renders it for Ctrl+P.
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.send(html)
    } catch (err) {
      logger?.warn({ err: String(err?.message ?? err) }, 'report.html failed')
      res.status(500).json({ error: 'report_failed', message: String(err?.message ?? err) })
    }
  })

  // ── AI planning assistant (rc9+) ─────────────────────────────────────────
  //
  // Local-only Ollama proxy. The webview can't reach 127.0.0.1:11434
  // directly (CSP connect-src 'self'), so the server proxies. No repo is
  // required — the assistant is general planning help (grounding in repo
  // activity arrives in rc9.2). Nothing leaves the machine.
  //
  //   GET  /api/ai/models             → installed Ollama models
  //   POST /api/ai/chat               → non-streaming completion (+persist)
  //   GET  /api/ai/conversations      → recent saved conversations + counter
  //   GET  /api/ai/conversations/:id  → one full conversation

  // English code-language prompt that instructs the model to MIRROR the
  // user's language in its replies (BlastRadius is BG/ES/EN multilingual).
  const AI_SYSTEM_PROMPT = [
    'You are BlastRadius\'s local planning assistant for a software developer.',
    'Always reply in the SAME language the user writes in.',
    'Help with: planning the next steps, security considerations, which',
    'libraries to use and trade-offs, and the best way to proceed.',
    'When the user shares a file diff or asks about a change, explain WHAT',
    'changed and WHY in plain terms so they learn — call out anything risky.',
    'Be concise and practical. Prefer concrete, actionable advice over theory.',
  ].join(' ')

  const MAX_AI_MESSAGES = 40
  const MAX_AI_CONTENT = 8_000
  const MAX_IMAGES_PER_MSG = 4
  const MAX_IMAGE_B64 = 8_000_000 // ~6 MB decoded per image
  // rc9.6: cap the diff we attach to an "explain this file" turn so a huge
  // diff can't blow the model's context window (it's clamped further by the
  // diff provider's own MAX_DIFF_BYTES, but be explicit here too).
  const MAX_EXPLAIN_DIFF_CHARS = 12_000
  const MODEL_RE = /^[A-Za-z0-9._:/-]{1,128}$/

  // Conversations are bucketed per project. The on-disk bucket is the repo's
  // basename PLUS a short hash of the FULL path, so two different repos that
  // happen to share a basename (e.g. ~/work/api and ~/oss/api) never collide
  // into the same history + advice counter. No repo → "general".
  function aiProject(ctx) {
    if (!ctx?.repoPath) return 'general'
    const base = aiProjectLabel(ctx)
    const hash = createHash('sha1').update(ctx.repoPath).digest('hex').slice(0, 8)
    return `${base}-${hash}`
  }

  // Human-friendly project label for API responses / the UI heading. The
  // path hash is purely an on-disk disambiguator — never surface it to the
  // user, who only ever sees the one active repo at a time.
  function aiProjectLabel(ctx) {
    if (!ctx?.repoPath) return 'general'
    return ctx.repoPath.split(/[\\/]/).filter(Boolean).pop() || 'repo'
  }

  // /api/ai/chat is the most expensive endpoint (a 120s Ollama generation
  // that pins CPU/GPU). Defense-in-depth limiter, like /api/diff: a small
  // burst, then ~1 every 5s — plenty for a human, but cuts a runaway loop
  // (or a no-cors POST from another tab) short.
  const aiChatRateLimit = makeRateLimiter({
    maxTokens: 6,
    refillTokens: 1,
    refillIntervalMs: 5_000,
    onRateLimit: (req) => logger?.warn({ ip: req.ip || req.socket?.remoteAddress }, 'ai chat rate-limited'),
    ...(aiChatRateLimitOptions || {}),
  })

  router.get('/api/ai/models', async (req, res) => {
    if (!aiClient) return res.json({ available: false, models: [], error: 'AI client not configured' })
    const out = await aiClient.listModels()
    res.json(out)
  })

  router.post('/api/ai/chat', aiChatRateLimit, async (req, res) => {
    if (!aiClient) {
      return res.status(503).json({ error: 'ai_unavailable', message: 'AI client not configured' })
    }
    const body = req.body || {}
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!MODEL_RE.test(model)) {
      return res.status(400).json({ error: 'invalid_model', message: 'model is required and must be a valid Ollama model name' })
    }
    // rc9.6: optional — attach a file's diff to this turn so the assistant
    // can teach the user what changed. The path is validated inside the
    // diff provider (traversal-safe); an invalid/empty path is just ignored.
    const explainPath = typeof body.explainPath === 'string' ? body.explainPath : ''
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({ error: 'invalid_messages', message: 'messages must be a non-empty array' })
    }
    if (body.messages.length > MAX_AI_MESSAGES) {
      return res.status(400).json({ error: 'too_many_messages', message: `messages capped at ${MAX_AI_MESSAGES}` })
    }
    const messages = []
    for (const msg of body.messages) {
      const role = msg && typeof msg.role === 'string' ? msg.role : ''
      const content = msg && typeof msg.content === 'string' ? msg.content : ''
      if (role !== 'user' && role !== 'assistant') {
        return res.status(400).json({ error: 'invalid_message', message: 'each message needs role user|assistant' })
      }
      // rc9.2: optional image attachments (vision models like gemma3/4).
      // Ollama wants base64 (no data: prefix) in a per-message `images`
      // array; ollama.chat() forwards `messages` verbatim, so we just
      // validate + preserve them here.
      let images
      if (Array.isArray(msg.images) && msg.images.length) {
        if (msg.images.length > MAX_IMAGES_PER_MSG) {
          return res.status(400).json({ error: 'too_many_images', message: `at most ${MAX_IMAGES_PER_MSG} images per message` })
        }
        images = []
        for (const raw of msg.images) {
          if (typeof raw !== 'string' || !raw) {
            return res.status(400).json({ error: 'invalid_image', message: 'each image must be a base64 string' })
          }
          // Strip a stray data: prefix, then ALL whitespace, then validate
          // strictly: base64 charset, proper padding, length a multiple of
          // 4. (A loose charset let an 8 MB whitespace blob pass.)
          const b64 = raw.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '')
          if (b64.length > MAX_IMAGE_B64) {
            return res.status(400).json({ error: 'image_too_large', message: 'an attached image exceeds the size limit' })
          }
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
            return res.status(400).json({ error: 'invalid_image', message: 'image is not valid base64' })
          }
          images.push(b64)
        }
      }
      if (!content && !(images && images.length)) {
        return res.status(400).json({ error: 'invalid_message', message: 'each message needs content or an image' })
      }
      // No silent truncation — reject over-long content explicitly so a
      // pasted snippet is never quietly cut mid-line (CLAUDE.md §2).
      if (content.length > MAX_AI_CONTENT) {
        return res.status(400).json({ error: 'content_too_long', message: `message content exceeds ${MAX_AI_CONTENT} characters` })
      }
      const out = { role, content }
      if (images && images.length) out.images = images
      messages.push(out)
    }
    // System prompt is prepended server-side (the client can't drop it).
    // rc9.2: when a repo is active, ground the assistant in BlastRadius's
    // live state (edited / propagated files + graph + annotations) so it
    // stops answering blind. Reuses gatherReportData (same data the
    // report export uses) → buildAiContextText. Best-effort: a failure to
    // build context must not block the chat.
    let systemContent = AI_SYSTEM_PROMPT
    const ctx = getRepoContext?.()
    // Resolve the storage bucket once: used for the prior-usage line below
    // and for persisting + counting after the reply.
    const project = conversationStore ? aiProject(ctx) : null
    // rc9.8: ground the assistant in the SAME slice the dashboard is showing.
    // The client sends its active filters (window / agent / date range) in
    // body.filters; we run them through the shared validator. A bad filter
    // must never block the chat — fall back to the full session.
    const SESSION_FILTERS = { windowName: 'session', platform: 'all', isRangeRequest: false, from: null, to: null, sinceRaw: '', untilRaw: '' }
    let groundFilters = SESSION_FILTERS
    if (body.filters && typeof body.filters === 'object') {
      const parsedF = parseHeatFilters(null, body.filters)
      if (parsedF.ok) groundFilters = parsedF.filters
      else logger?.warn({ err: parsedF.body?.error }, 'ai grounding filters invalid; using full session')
    }
    if (ctx) {
      try {
        const data = await gatherReportData(ctx, groundFilters)
        // rc9.6: honest local-assistant usage so the AI can answer "how many
        // tokens have I used?" — these are THIS assistant's tokens, never the
        // coding agent's (we don't capture those). Prior turns only.
        if (conversationStore && project) {
          try { data.assistantUsage = await conversationStore.usage(project) } catch { /* best effort */ }
        }
        systemContent += '\n\n' + buildAiContextText(data)
      } catch (err) {
        logger?.warn({ err: String(err?.message ?? err) }, 'ai grounding context build failed')
      }
    }
    // rc9.6: when the user clicked "explain this file", attach its diff so
    // the model teaches them what changed. Best-effort — a bad path or no
    // diff just falls through to a normal answer.
    if (explainPath && ctx?.diffProvider) {
      try {
        const d = await ctx.diffProvider.getDiff(explainPath, 'auto')
        const patch = (d?.patch || '').slice(0, MAX_EXPLAIN_DIFF_CHARS)
        if (patch) {
          systemContent += `\n\n[The user is asking you to explain this file's latest diff — file: ${explainPath}]\n` +
            'Explain what changed and why, teaching them; flag anything risky.\n' +
            '```diff\n' + patch + '\n```'
        } else {
          systemContent += `\n\n[The user asked about ${explainPath}, but it has no current diff (unchanged or unavailable). Say so and offer to help another way.]`
        }
      } catch (err) {
        logger?.warn({ err: String(err?.message ?? err) }, 'ai explain-diff fetch failed')
      }
    }
    const withSystem = [{ role: 'system', content: systemContent }, ...messages]
    // rc9.5: report a rough context budget so the UI can warn before Ollama
    // silently drops the oldest turns. The estimate covers the FULL outgoing
    // prompt (system + grounding + history), which is why it's computed here
    // rather than on the client (which never sees the grounding block).
    const usage = {
      estimatedTokens: estimateAiTokens(withSystem),
      contextLimit: aiClient.contextLimit || DEFAULT_CONTEXT_LIMIT,
    }
    // rc9.3: if the user presses Stop (or the client disconnects), abort
    // the Ollama call too so the local model stops generating — don't burn
    // compute on an answer nobody is waiting for. NB: use res 'close' with
    // a writableFinished guard — req 'close' fires on EVERY completed
    // request (after the body is read) in modern Node, which would falsely
    // mark a normal request as aborted.
    const ac = new AbortController()
    let clientGone = false
    res.on('close', () => {
      if (!res.writableFinished) { clientGone = true; ac.abort() }
    })
    try {
      const reply = await aiClient.chat({ model, messages: withSystem, signal: ac.signal })
      if (clientGone) return // user stopped — nothing to send or persist
      // rc9.1: persist the turn (client history + this reply) per project
      // and bump the advice counter. Best-effort — a save failure must not
      // fail the chat the user already got an answer to.
      let conversationId = typeof body.conversationId === 'string' ? body.conversationId : null
      let adviceCount
      if (conversationStore && project) {
        try {
          // rc9.6: accumulate this turn's estimated tokens into the project's
          // honest local-assistant total (reported back in future grounding).
          const conv = await conversationStore.save(project, conversationId, [...messages, reply], { tokens: usage.estimatedTokens })
          conversationId = conv.id
          adviceCount = await conversationStore.counter(project)
        } catch (err) {
          logger?.warn({ err: String(err?.message ?? err) }, 'conversation save failed')
        }
      }
      // Re-check: the client may have disconnected DURING the save above
      // (the inner catch swallows its error), and writing to a torn socket
      // throws "headers already sent". The save still completed.
      if (clientGone) return
      res.json({ message: reply, conversationId, adviceCount, usage })
    } catch (err) {
      if (clientGone) return // client already disconnected; don't write
      const code = err?.code
      const status = code === 'unreachable' ? 503
        : code === 'model_not_found' ? 404
        : (code === 'model_unsupported' || code === 'bad_request') ? 400
        : 502
      logger?.warn({ err: String(err?.message ?? err), code }, 'ai chat failed')
      res.status(status).json({ error: code || 'ai_chat_failed', message: String(err?.message ?? err) })
    }
  })

  router.get('/api/ai/conversations', async (req, res) => {
    if (!conversationStore) return res.json({ project: null, conversations: [], adviceCount: 0 })
    const ctx = getRepoContext?.()
    const project = aiProject(ctx)
    try {
      const [conversations, adviceCount] = await Promise.all([
        conversationStore.list(project),
        conversationStore.counter(project),
      ])
      // Surface the friendly label (basename), not the hashed on-disk bucket.
      res.json({ project: aiProjectLabel(ctx), conversations, adviceCount })
    } catch (err) {
      logger?.warn({ err: String(err?.message ?? err) }, 'list conversations failed')
      res.status(500).json({ error: 'list_failed', message: String(err?.message ?? err) })
    }
  })

  router.get('/api/ai/conversations/:id', async (req, res) => {
    if (!conversationStore) return res.status(503).json({ error: 'ai_unavailable' })
    const id = req.params.id
    if (!conversationStore.constructor.isValidId(id)) {
      return res.status(400).json({ error: 'invalid_id' })
    }
    const project = aiProject(getRepoContext?.())
    const conversation = await conversationStore.load(project, id)
    if (!conversation) return res.status(404).json({ error: 'not_found' })
    res.json({ conversation })
  })

  router.delete('/api/ai/conversations/:id', async (req, res) => {
    if (!conversationStore) return res.status(503).json({ error: 'ai_unavailable' })
    const id = req.params.id
    if (!conversationStore.constructor.isValidId(id)) {
      return res.status(400).json({ error: 'invalid_id' })
    }
    const project = aiProject(getRepoContext?.())
    const deleted = await conversationStore.delete(project, id)
    if (!deleted) return res.status(404).json({ error: 'not_found' })
    res.json({ deleted: true })
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

  // rc9.13: self-diagnostics — surface SILENT misconfigurations (e.g. the
  // hook logging to a folder the dashboard doesn't read) for the ACTIVE repo.
  // Reuses getHookStatus, which already reports an outdated/mismatched hook
  // command. Reported regardless of the ignore list — a broken hook is a
  // problem, not an optional install nudge. Never throws (best-effort).
  router.get('/api/diagnostics', async (req, res) => {
    const ctx = getRepoContext?.()
    if (!ctx) return res.json({ checks: [] })
    try {
      const { getHookStatus } = await import('./hookInstaller.js')
      const { buildDiagnostics } = await import('./diagnostics.js')
      const hookStatus = await getHookStatus(ctx.repoPath, { logDir, blastRadiusRoot })
      res.json({ repoPath: ctx.repoPath, checks: buildDiagnostics({ hookStatus, serverLogDir: logDir }) })
    } catch (err) {
      logger?.warn({ err: String(err?.message ?? err) }, 'diagnostics failed')
      res.json({ checks: [] })
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
