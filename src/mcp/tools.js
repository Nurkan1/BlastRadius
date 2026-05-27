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
import { DEFAULT_RESPONSE_CAP, HARD_RESPONSE_CAP } from '../server/knowledgeGraph.js'
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
  // rc8+: multi-repo KnowledgeStore singleton used by set_node_summary
  // to persist agent-provided summaries. The other 4 graph tools read
  // through getRepoContext().knowledgeGraph; only the write needs the
  // store directly.
  knowledgeStore,
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

      // rc8.x+: when the caller asks for an explicit window (`since`
      // and/or `until`), route through the historical accessors so
      // past-day JSONLs are actually loaded. Without this branch
      // `getEvents()` / `getEventsForRepo()` only return today's
      // in-memory buffer, which makes any past-day window short-
      // circuit with `reason: "no_events_recorded"` regardless of
      // what sits on disk. `describe_node` already does this — the
      // asymmetry was the bug.
      //
      // When neither bound is provided we keep the original cheap
      // synchronous path so the default "active iteration" call
      // (used by every Claude Desktop "what am I touching right
      // now?" prompt) stays zero-overhead.
      const hasRange = Boolean(since || until)
      let events
      if (hasRange) {
        const fromDate = since
          ? new Date(since)
          : new Date(Date.now() - ITERATION_FALLBACK_MS)
        const toDate = until ? new Date(until) : new Date()
        try {
          await eventStore.loadDays({ from: fromDate, to: toDate })
        } catch (err) {
          // `loadDays()` is the only place that surfaces the
          // MAX_RANGE_DAYS=30 cap, and it does so via RangeError
          // (see src/server/eventStore.js — "range spans N days,
          // exceeds cap of 30"). Translate that into the documented
          // NO-DATA shape instead of letting it bubble as a protocol
          // error; same pattern get_file_diff uses for
          // PathTraversalError.
          if (err instanceof RangeError) {
            return noData.asMcpContent({
              since: fromDate.toISOString(),
              until: toDate.toISOString(),
              scope: useAll ? 'all_repos' : 'active_repo',
              repo: ctx?.repoPath ?? null,
              totals: null,
              files: null,
              reason: 'range_exceeds_max_days',
              maxDays: 30,
            })
          }
          throw err
        }
        events = useAll
          ? eventStore.getEventsInRange({ from: fromDate, to: toDate })
          : eventStore.getEventsForRepoInRange(ctx.repoPath, { from: fromDate, to: toDate })
      } else {
        events = useAll
          ? eventStore.getEvents()
          : eventStore.getEventsForRepo(ctx.repoPath)
      }

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

  // ── Knowledge Graph tools (rc8+) ───────────────────────────────────────
  //
  // All 5 share the same prelude: resolve the per-repo
  // KnowledgeGraph via getRepoContext(), bail with NO-DATA if it
  // hasn't been built yet, then read O(1) from the cached snapshot.
  // Path inputs go through DiffProvider.validatePath — same
  // validator the rc6+ /api/diff uses.

  /** Tiny prelude used by every graph tool. Returns either
   *  { ok: true, ctx, snap } or { ok: false, reason }. */
  function resolveGraph() {
    const ctx = getRepoContext?.()
    if (!ctx) {
      const prefs = preferences.get()
      return { ok: false, reason: prefs.needsSetup ? 'needs_setup' : 'no_active_repo' }
    }
    const snap = ctx.knowledgeGraph.getSnapshot()
    if (snap.builtAt === 0) return { ok: false, reason: 'graph_not_ready' }
    return { ok: true, ctx, snap }
  }

  // ── get_codebase_graph ─────────────────────────────────────────────────
  mcpServer.registerTool(
    'get_codebase_graph',
    {
      title: 'Get the structural codebase graph (capped)',
      description:
        'Returns the active repo as a graph: nodes (files) with fanIn/fanOut/' +
        'kind/sizeBytes/summary/tags, plus edges (imports) constrained to the ' +
        'returned node set. Capped at 200 nodes by default; ?limit up to 1000.',
      inputSchema: {
        limit: z.number().int().min(1).max(HARD_RESPONSE_CAP).optional()
          .describe(`Max nodes to return. Default ${DEFAULT_RESPONSE_CAP}, hard cap ${HARD_RESPONSE_CAP}.`),
        kinds: z.array(z.enum(['source', 'test', 'config', 'doc', 'other'])).optional()
          .describe('Filter nodes by classification. Omit to include all kinds.'),
        minFanIn: z.number().int().min(0).optional()
          .describe('Only include nodes with at least N consumers (fanIn).'),
        withSummaryOnly: z.boolean().optional()
          .describe('Only include nodes that have a persisted summary.'),
      },
    },
    async ({ limit, kinds, minFanIn, withSummaryOnly }) => {
      const r = resolveGraph()
      if (!r.ok) return noData.asMcpContent({ nodes: null, edges: null, reason: r.reason })
      const cap = Math.min(Math.max(Number(limit) || DEFAULT_RESPONSE_CAP, 1), HARD_RESPONSE_CAP)
      const kindSet = Array.isArray(kinds) && kinds.length ? new Set(kinds) : null
      const minIn = Number.isFinite(Number(minFanIn)) ? Number(minFanIn) : 0
      const onlySummary = !!withSummaryOnly

      const filtered = []
      for (const node of r.snap.nodes.values()) {
        if (kindSet && !kindSet.has(node.kind)) continue
        if (node.fanIn < minIn) continue
        if (onlySummary && !node.summary) continue
        filtered.push(node)
      }
      filtered.sort((a, b) => b.fanIn - a.fanIn || a.path.localeCompare(b.path))
      const truncated = filtered.length > cap
      const nodes = truncated ? filtered.slice(0, cap) : filtered
      const nodeSet = new Set(nodes.map((n) => n.path))
      const edges = []
      const fwd = r.ctx.graphResolver.getGraph()?.forward
      if (fwd instanceof Map) {
        for (const [from, outgoing] of fwd) {
          if (!nodeSet.has(from)) continue
          for (const to of outgoing) {
            if (nodeSet.has(to)) edges.push({ from, to })
          }
        }
      }
      return noData.asMcpContent({
        builtAt: new Date(r.snap.builtAt).toISOString(),
        stats: r.snap.stats,
        nodes,
        edges,
        truncated,
        limit: cap,
        reason: null,
      })
    },
  )

  // ── get_nearest_neighbors ──────────────────────────────────────────────
  mcpServer.registerTool(
    'get_nearest_neighbors',
    {
      title: 'BFS neighbors of a node — "what will my edit affect?"',
      description:
        'For a given file, walks the import graph up (consumers) and / or ' +
        'down (dependencies) up to `depth` levels. Path validation reuses ' +
        'DiffProvider.validatePath (same as /api/diff). Pure read.',
      inputSchema: {
        path: z.string().min(1).max(1024).describe('Repo-relative file path.'),
        depth: z.number().int().min(1).max(10).optional()
          .describe('BFS depth, clamped to [1, 10]. Default 2.'),
        direction: z.enum(['consumers', 'dependencies', 'both']).optional()
          .describe('Walk up, down, or both. Default both.'),
      },
    },
    async ({ path: rawPath, depth: depthIn, direction = 'both' }) => {
      const r = resolveGraph()
      if (!r.ok) return noData.asMcpContent({ path: rawPath, consumers: null, dependencies: null, reason: r.reason })
      try {
        DiffProvider.validatePath(r.ctx.repoPath, rawPath)
      } catch (err) {
        if (err instanceof PathTraversalError) {
          return noData.asMcpContent({ path: rawPath, consumers: null, dependencies: null, reason: err.code })
        }
        throw err
      }
      if (!r.snap.nodes.has(rawPath)) {
        return noData.asMcpContent({ path: rawPath, consumers: [], dependencies: [], reason: 'unknown_node' })
      }
      const d = Number.isInteger(depthIn) && depthIn > 0 ? Math.min(depthIn, 10) : 2
      const fwd = r.ctx.graphResolver.getGraph()?.forward
      const rev = r.ctx.graphResolver.getGraph()?.reverse
      const consumers = []
      const dependencies = []
      const walk = (startMap, push) => {
        const visited = new Set([rawPath])
        let frontier = new Set([rawPath])
        for (let lvl = 0; lvl < d; lvl++) {
          const next = new Set()
          for (const n of frontier) {
            const adj = startMap?.get(n)
            if (!adj) continue
            for (const m of adj) {
              if (visited.has(m)) continue
              visited.add(m)
              next.add(m)
              push(m, lvl + 1)
            }
          }
          if (next.size === 0) break
          frontier = next
        }
      }
      if (direction === 'consumers' || direction === 'both') {
        walk(rev, (p, lvl) => consumers.push({ path: p, depth: lvl, fanIn: r.snap.nodes.get(p)?.fanIn ?? 0 }))
      }
      if (direction === 'dependencies' || direction === 'both') {
        walk(fwd, (p, lvl) => dependencies.push({ path: p, depth: lvl, fanOut: r.snap.nodes.get(p)?.fanOut ?? 0 }))
      }
      return noData.asMcpContent({
        path: rawPath, depth: d, direction, consumers, dependencies, reason: null,
      })
    },
  )

  // ── describe_node ──────────────────────────────────────────────────────
  mcpServer.registerTool(
    'describe_node',
    {
      title: 'Detail of one node — structural + semantic + recent activity',
      description:
        'Returns full node metadata (kind, size, fanIn/fanOut, summary, tags) ' +
        'PLUS a cross-walk with the last 7 days of touch events from the ' +
        "JSONL log (Edit/Read/Write counts, last agent). Path validation " +
        'reused from /api/diff.',
      inputSchema: {
        path: z.string().min(1).max(1024).describe('Repo-relative file path.'),
      },
    },
    async ({ path: rawPath }) => {
      const r = resolveGraph()
      if (!r.ok) return noData.asMcpContent({ node: null, reason: r.reason })
      try {
        DiffProvider.validatePath(r.ctx.repoPath, rawPath)
      } catch (err) {
        if (err instanceof PathTraversalError) {
          return noData.asMcpContent({ node: null, reason: err.code })
        }
        throw err
      }
      const node = r.snap.nodes.get(rawPath)
      if (!node) return noData.asMcpContent({ node: null, path: rawPath, reason: 'unknown_node' })

      // Cross-walk with the live event store — 7-day window starting
      // at midnight of (today - 6). Cheap because eventStore already
      // caches per-day and per-repo.
      let recentActivity = { edits: 0, reads: 0, writes: 0, lastAgent: null, lastTs: null }
      try {
        const now = new Date()
        const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)
        await eventStore.loadDays?.({ from, to: now })
        const events = eventStore.getEventsForRepoInRange?.(r.ctx.repoPath, { from, to: now }) ?? []
        for (const ev of events) {
          if (ev.pathNorm !== rawPath) continue
          if (ev.tool === 'Edit') recentActivity.edits++
          else if (ev.tool === 'Read') recentActivity.reads++
          else if (ev.tool === 'Write') recentActivity.writes++
          const ts = Date.parse(ev.ts)
          if (Number.isFinite(ts) && (!recentActivity.lastTs || ts > Date.parse(recentActivity.lastTs))) {
            recentActivity.lastTs = ev.ts
            recentActivity.lastAgent = ev.agent ?? null
          }
        }
      } catch {
        // Cross-walk failure is non-fatal — return the structural part anyway.
      }

      return noData.asMcpContent({ node, recentActivity, reason: null })
    },
  )

  // ── find_nodes ─────────────────────────────────────────────────────────
  mcpServer.registerTool(
    'find_nodes',
    {
      title: 'Text search over path / summary / tags',
      description:
        'Substring search across the active repo graph. Scoring: path ' +
        'startsWith > tag exact > summary contains > path contains. ' +
        'Returns up to `limit` matches sorted by relevance desc.',
      inputSchema: {
        query: z.string().min(1).max(128).describe('Substring to look for (case-insensitive).'),
        fields: z.array(z.enum(['path', 'summary', 'tags'])).optional()
          .describe('Subset of fields to search. Default: all three.'),
        limit: z.number().int().min(1).max(HARD_RESPONSE_CAP).optional()
          .describe(`Max matches to return. Default ${DEFAULT_RESPONSE_CAP}.`),
      },
    },
    async ({ query, fields, limit }) => {
      const r = resolveGraph()
      if (!r.ok) return noData.asMcpContent({ matches: null, reason: r.reason })
      const q = String(query).toLowerCase().trim()
      if (!q) return noData.asMcpContent({ matches: [], reason: 'no_matches' })
      const searchFields = new Set(Array.isArray(fields) && fields.length ? fields : ['path', 'summary', 'tags'])
      const cap = Math.min(Math.max(Number(limit) || DEFAULT_RESPONSE_CAP, 1), HARD_RESPONSE_CAP)

      const scored = []
      for (const node of r.snap.nodes.values()) {
        let score = 0
        const pathLc = node.path.toLowerCase()
        if (searchFields.has('path')) {
          if (pathLc.startsWith(q)) score += 10
          else if (pathLc.includes(q)) score += 3
        }
        if (searchFields.has('tags') && Array.isArray(node.tags)) {
          for (const tag of node.tags) {
            const t = tag.toLowerCase()
            if (t === q) score += 8
            else if (t.includes(q)) score += 4
          }
        }
        if (searchFields.has('summary') && typeof node.summary === 'string') {
          const s = node.summary.toLowerCase()
          if (s.includes(q)) score += 5
        }
        if (score > 0) scored.push({ node, score })
      }
      if (scored.length === 0) {
        return noData.asMcpContent({ matches: [], query: q, reason: 'no_matches' })
      }
      scored.sort((a, b) => b.score - a.score || a.node.path.localeCompare(b.node.path))
      const matches = scored.slice(0, cap).map(({ node, score }) => ({
        path: node.path,
        kind: node.kind,
        fanIn: node.fanIn,
        fanOut: node.fanOut,
        summary: node.summary,
        tags: node.tags,
        score,
      }))
      return noData.asMcpContent({
        matches,
        query: q,
        truncated: scored.length > cap,
        reason: null,
      })
    },
  )

  // ── set_node_summary (WRITE — requires user consent) ───────────────────
  mcpServer.registerTool(
    'set_node_summary',
    {
      title: 'Persist a human / agent summary + tags for a node',
      description:
        'Writes to ~/.blastradius/knowledge.json (NOT to the repo). The ' +
        'agent calls this when it has understood a file and wants to ' +
        'leave a memory note for future sessions. Caps: summary ≤ 2000 ' +
        'chars, tags ≤ 20 × 32. Path validation reused from /api/diff.',
      inputSchema: {
        path: z.string().min(1).max(1024).describe('Repo-relative file path.'),
        summary: z.string().max(2000).optional()
          .describe('Short prose describing what the file does. ≤ 2000 chars.'),
        tags: z.array(z.string().max(32)).max(20).optional()
          .describe('Short labels for filtering (≤ 20 tags, each ≤ 32 chars).'),
      },
      annotations: {
        // Per Phase 3 contract: any mutation surface ships this hint
        // so MCP clients (Claude Code, Claude Desktop) can prompt the
        // user before invoking it.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        requiresConsent: true,
      },
    },
    async ({ path: rawPath, summary = '', tags = [] }) => {
      if (!knowledgeStore) {
        return noData.asMcpContent({ ok: false, reason: 'knowledge_store_unavailable' })
      }
      const r = resolveGraph()
      if (!r.ok) return noData.asMcpContent({ ok: false, reason: r.reason })
      try {
        DiffProvider.validatePath(r.ctx.repoPath, rawPath)
      } catch (err) {
        if (err instanceof PathTraversalError) {
          return noData.asMcpContent({ ok: false, path: rawPath, reason: err.code })
        }
        throw err
      }
      try {
        const entry = await knowledgeStore.setNodeSummary(r.ctx.repoPath, rawPath, { summary, tags })
        // Optimistic in-memory refresh — same shape the /api/graph/node
        // POST handler does. Keeps a follow-up describe_node consistent
        // without forcing a full KnowledgeGraph.rebuild().
        const existing = r.snap.nodes.get(rawPath)
        if (existing) {
          existing.summary = entry.summary
          existing.tags = entry.tags
          existing.summaryUpdatedAt = entry.updatedAt
          r.snap.stats.withSummary = [...r.snap.nodes.values()].filter((n) => !!n.summary).length
        }
        return noData.asMcpContent({
          ok: true,
          path: rawPath,
          entry,
          node: existing ?? null,
          reason: null,
        })
      } catch (err) {
        if (err?.code) {
          return noData.asMcpContent({ ok: false, path: rawPath, reason: err.code, message: err.message })
        }
        throw err
      }
    },
  )
}
