/**
 * BlastRadius MCP tools — Phase 1, read-only.
 *
 * Every tool delegates to the SAME services the HTTP /api/* routes
 * use (eventStore, iterationMarker, getRepoContext, preferences),
 * so the MCP surface stays consistent with the dashboard view by
 * construction. There is no parallel data model.
 *
 * Path/ref validation reuses DiffProvider.validatePath /
 * DiffProvider.validateRef — single source of truth (see
 * src/server/diffProvider.js). Tools never roll their own validation.
 *
 * NO-DATA contract: every tool returns a structured object with a
 * `reason` field when the answer is empty. Tools never throw on
 * "absence"; they only throw on protocol-level misuse (e.g. invalid
 * Zod input the SDK already rejects before our handler runs).
 *
 * Each handler returns `{ content, structuredContent }` via
 * `noData.asMcpContent(payload)` so both legacy and modern MCP
 * clients can consume the response.
 */

import { z } from 'zod'
import { computeHeat } from '../server/heatEngine.js'
import { DiffProvider, PathTraversalError, InvalidRefError } from '../server/diffProvider.js'
import * as noData from './noData.js'

const ITERATION_FALLBACK_MS = 3 * 60 * 1000 // mirrors heatEngine + /api/iteration

/**
 * Aggregate touch events in a time window into a per-file, per-tool,
 * per-agent breakdown. Used by `summarize_progress`.
 *
 * @param {Array} events    touch events
 * @param {number|null} sinceMs  lower bound in epoch ms (inclusive), null = no lower bound
 * @param {number|null} untilMs  upper bound in epoch ms (inclusive), null = now (no cap)
 */
function aggregateEvents(events, sinceMs, untilMs = null) {
  /** @type {Map<string, { reads:number, writes:number, edits:number, agents:Set<string>, lastTs:number }>} */
  const byFile = new Map()
  let totalRead = 0
  let totalWrite = 0
  let totalEdit = 0
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const ts = Date.parse(ev.ts)
    if (!Number.isFinite(ts)) continue
    if (sinceMs != null && ts < sinceMs) continue
    if (untilMs != null && ts > untilMs) continue
    const path = typeof ev.pathNorm === 'string' && ev.pathNorm
      ? ev.pathNorm
      : (typeof ev.path === 'string' ? ev.path : '')
    if (!path) continue
    let bucket = byFile.get(path)
    if (!bucket) {
      bucket = { reads: 0, writes: 0, edits: 0, agents: new Set(), lastTs: 0 }
      byFile.set(path, bucket)
    }
    if (ev.tool === 'Read') { bucket.reads += 1; totalRead += 1 }
    else if (ev.tool === 'Write') { bucket.writes += 1; totalWrite += 1 }
    else if (ev.tool === 'Edit') { bucket.edits += 1; totalEdit += 1 }
    if (typeof ev.agent === 'string' && ev.agent) bucket.agents.add(ev.agent)
    if (ts > bucket.lastTs) bucket.lastTs = ts
  }
  return { byFile, totals: { reads: totalRead, writes: totalWrite, edits: totalEdit } }
}

/**
 * Detect iteration boundaries by scanning event timestamps for gaps
 * larger than `gapMs`. Each contiguous burst of activity counts as
 * one iteration. Returns most-recent-first.
 *
 * This is a derived view — BlastRadius doesn't persist iteration
 * histories explicitly. We infer them from the JSONL log on demand.
 */
function deriveIterations(events, gapMs, limit) {
  const sorted = events
    .map((ev) => ({ ts: Date.parse(ev?.ts), tool: ev?.tool, agent: ev?.agent, path: ev?.pathNorm || ev?.path }))
    .filter((e) => Number.isFinite(e.ts))
    .sort((a, b) => a.ts - b.ts)
  if (sorted.length === 0) return []

  const out = []
  let cur = { startTs: sorted[0].ts, endTs: sorted[0].ts, events: 1, edits: 0, reads: 0, writes: 0, files: new Set() }
  const tally = (slot, e) => {
    if (e.tool === 'Edit') slot.edits += 1
    else if (e.tool === 'Read') slot.reads += 1
    else if (e.tool === 'Write') slot.writes += 1
    if (e.path) slot.files.add(e.path)
  }
  tally(cur, sorted[0])
  for (let i = 1; i < sorted.length; i++) {
    const e = sorted[i]
    if (e.ts - cur.endTs > gapMs) {
      out.push(cur)
      cur = { startTs: e.ts, endTs: e.ts, events: 0, edits: 0, reads: 0, writes: 0, files: new Set() }
    }
    cur.endTs = e.ts
    cur.events += 1
    tally(cur, e)
  }
  out.push(cur)

  // Newest first, truncate to `limit`.
  out.reverse()
  return out.slice(0, limit).map((it) => ({
    startedAt: new Date(it.startTs).toISOString(),
    endedAt: new Date(it.endTs).toISOString(),
    durationMs: it.endTs - it.startTs,
    events: it.events,
    edits: it.edits,
    reads: it.reads,
    writes: it.writes,
    filesTouched: it.files.size,
  }))
}

/**
 * Factory: registers all read-only tools on the given McpServer.
 *
 * @param {object} opts
 * @param {object} opts.mcpServer        @modelcontextprotocol/sdk McpServer instance
 * @param {Function} opts.getRepoContext () => RepoContext | null
 * @param {object} opts.eventStore       EventStore singleton
 * @param {object} opts.iterationMarker  IterationMarker singleton
 * @param {object} opts.preferences      PreferencesStore singleton
 * @param {number} [opts.depth=2]        Propagation depth (matches /api/heat)
 */
export function registerTools({
  mcpServer,
  getRepoContext,
  eventStore,
  iterationMarker,
  preferences,
  depth = 2,
}) {
  // ── get_iteration_summary ──────────────────────────────────────────────
  mcpServer.registerTool(
    'get_iteration_summary',
    {
      title: 'Get current iteration summary',
      description:
        'Returns a structured summary of the current BlastRadius iteration: ' +
        'edited files (red), read files (green), and propagation-affected files (yellow), ' +
        'each with the agent that last touched it. Equivalent to GET /api/iteration/summary.',
      inputSchema: {}, // no arguments
    },
    async () => {
      const ctx = getRepoContext?.()
      if (!ctx) {
        const prefs = preferences.get()
        return noData.asMcpContent(
          noData.iteration(prefs.needsSetup ? 'needs_setup' : 'no_active_repo'),
        )
      }
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

      const isEmpty = redFiles.length === 0 && greenFiles.length === 0 && yellowFiles.length === 0
      if (isEmpty) {
        return noData.asMcpContent(
          noData.iteration('no_events_in_window', {
            iterationStartedAt: iterationMarker?.getIso() ?? null,
          }),
        )
      }
      return noData.asMcpContent({
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
              (p) => `${p.path} (depth ${p.depth})`,
            ),
          })),
        },
        reason: null,
      })
    },
  )

  // ── summarize_progress ─────────────────────────────────────────────────
  mcpServer.registerTool(
    'summarize_progress',
    {
      title: 'Summarize touch activity in a time window',
      description:
        'Aggregates JSONL events into per-file Edit/Write/Read counts ' +
        'and per-agent attribution. Defaults to the active iteration ' +
        'window (or the 3-minute fallback). Scoped to the active repo ' +
        "unless `allRepos: true` is set. Optionally bounded by `until`.",
      inputSchema: {
        since: z.string().datetime({ offset: true }).optional()
          .describe('ISO timestamp lower bound. Defaults to the iteration marker or now − 3 min.'),
        until: z.string().datetime({ offset: true }).optional()
          .describe('ISO timestamp upper bound (inclusive). Defaults to now. Combined with since it produces a precise time-window — useful for "end-of-day digests" or post-mortem analysis.'),
        allRepos: z.boolean().optional()
          .describe('When true, includes events from every repo, not just the active one.'),
      },
    },
    async ({ since, until, allRepos }) => {
      const ctx = getRepoContext?.()
      const useAll = allRepos === true || !ctx
      const events = useAll
        ? eventStore.getEvents()
        : eventStore.getEventsForRepo(ctx.repoPath)

      if (events.length === 0) {
        return noData.asMcpContent({
          since: since || null,
          until: until || null,
          scope: useAll ? 'all_repos' : 'active_repo',
          repo: ctx?.repoPath ?? null,
          totals: null,
          files: null,
          reason: 'no_events_recorded',
        })
      }

      let sinceMs = null
      if (since) {
        sinceMs = Date.parse(since)
        if (!Number.isFinite(sinceMs)) sinceMs = null
      }
      if (sinceMs == null) {
        const marker = iterationMarker?.get()
        sinceMs = marker instanceof Date
          ? marker.getTime()
          : Date.now() - ITERATION_FALLBACK_MS
      }

      // rc7+: optional upper bound. null/missing = now (no cap).
      let untilMs = null
      if (until) {
        untilMs = Date.parse(until)
        if (!Number.isFinite(untilMs)) untilMs = null
        // Validation: inverted ranges silently fall back to "since
        // only" rather than throw, mirroring the lenient parsing of
        // since itself. The structured response surfaces both bounds
        // so the caller can detect it.
        if (untilMs != null && untilMs < sinceMs) {
          untilMs = null
        }
      }

      const { byFile, totals } = aggregateEvents(events, sinceMs, untilMs)
      if (byFile.size === 0) {
        return noData.asMcpContent({
          since: new Date(sinceMs).toISOString(),
          until: untilMs ? new Date(untilMs).toISOString() : null,
          scope: useAll ? 'all_repos' : 'active_repo',
          repo: ctx?.repoPath ?? null,
          totals: { reads: 0, writes: 0, edits: 0 },
          files: [],
          reason: 'no_events_in_window',
        })
      }
      const files = [...byFile.entries()]
        .map(([path, b]) => ({
          path,
          reads: b.reads,
          writes: b.writes,
          edits: b.edits,
          agents: [...b.agents],
          lastTs: new Date(b.lastTs).toISOString(),
        }))
        .sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1)) // most recent first
      return noData.asMcpContent({
        since: new Date(sinceMs).toISOString(),
        until: untilMs ? new Date(untilMs).toISOString() : null,
        scope: useAll ? 'all_repos' : 'active_repo',
        repo: ctx?.repoPath ?? null,
        totals,
        files,
        reason: null,
      })
    },
  )

  // ── list_days_with_activity ────────────────────────────────────────────
  mcpServer.registerTool(
    'list_days_with_activity',
    {
      title: 'List days with recorded touch events',
      description:
        'Returns a list of dates (YYYY-MM-DD) that have a session-*.jsonl ' +
        'file under BLASTRADIUS_LOG_DIR, sorted most-recent-first. Useful ' +
        "as a discovery primitive: agents can call this first to learn " +
        'which days have data before asking summarize_progress for a ' +
        'specific window. Capped at 30 most-recent entries.',
      inputSchema: {},
    },
    async () => {
      const days = await eventStore.listDaysWithActivity()
      if (days.length === 0) {
        return noData.asMcpContent({
          days: [],
          reason: 'no_events_recorded',
        })
      }
      return noData.asMcpContent({
        days,
        count: days.length,
        reason: null,
      })
    },
  )

  // ── list_recent_iterations ────────────────────────────────────────────
  mcpServer.registerTool(
    'list_recent_iterations',
    {
      title: 'List recent iteration windows (derived from event gaps)',
      description:
        'Iterations are inferred by detecting activity bursts separated by ' +
        'gaps > `gapMs`. Returns the N most-recent iterations with start, ' +
        'end, duration, and aggregate counts. Scoped to the active repo.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional()
          .describe('Max iterations to return. Default 10.'),
        gapMs: z.number().int().min(30_000).max(60 * 60 * 1000).optional()
          .describe('Inactivity gap (ms) that ends one iteration and starts the next. Default 180000 (3 min).'),
      },
    },
    async ({ limit, gapMs }) => {
      const ctx = getRepoContext?.()
      if (!ctx) {
        const prefs = preferences.get()
        return noData.asMcpContent({
          iterations: null,
          reason: prefs.needsSetup ? 'needs_setup' : 'no_active_repo',
        })
      }
      const events = eventStore.getEventsForRepo(ctx.repoPath)
      const its = deriveIterations(events, gapMs ?? ITERATION_FALLBACK_MS, limit ?? 10)
      if (its.length === 0) {
        return noData.asMcpContent({
          iterations: [],
          repo: ctx.repoPath,
          reason: 'no_events_recorded',
        })
      }
      return noData.asMcpContent({
        iterations: its,
        repo: ctx.repoPath,
        gapMs: gapMs ?? ITERATION_FALLBACK_MS,
        reason: null,
      })
    },
  )

  // ── get_file_diff ─────────────────────────────────────────────────────
  mcpServer.registerTool(
    'get_file_diff',
    {
      title: 'Get the git diff of a single file in the active repo',
      description:
        'Returns the validated git diff of one repo-relative file. ' +
        '`against` defaults to "auto": uncommitted changes if any, otherwise ' +
        'the last commit that touched the file. Path validation is reused ' +
        'verbatim from /api/diff (DiffProvider.validatePath).',
      inputSchema: {
        path: z.string().min(1).max(1024).describe('Repo-relative file path.'),
        against: z.string().min(1).max(100).optional()
          .describe('Git ref or "auto". Defaults to "auto".'),
      },
    },
    async ({ path, against }) => {
      const ctx = getRepoContext?.()
      if (!ctx) {
        const prefs = preferences.get()
        return noData.asMcpContent({
          diff: null,
          reason: prefs.needsSetup ? 'needs_setup' : 'no_active_repo',
        })
      }
      // Single source of truth: reuse DiffProvider's validator exactly
      // (path traversal + NUL byte + absolute path defense). Surface
      // validation failures as structured errors via the NO-DATA shape
      // instead of throwing, so the MCP client gets a reason it can
      // explain to the user.
      try {
        DiffProvider.validatePath(ctx.repoPath, path)
        DiffProvider.validateRef(against || 'auto')
      } catch (err) {
        if (err instanceof PathTraversalError || err instanceof InvalidRefError) {
          return noData.asMcpContent({
            diff: null,
            path,
            reason: err.code, // 'path_traversal' | 'nul_byte' | 'absolute_path' | 'escapes_root' | 'invalid_ref'
          })
        }
        throw err
      }
      const result = await ctx.diffProvider.getDiff(path, against || 'auto')
      return noData.asMcpContent({
        diff: result,
        path,
        against: against || 'auto',
        reason: null,
      })
    },
  )
}
