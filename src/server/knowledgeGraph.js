/**
 * KnowledgeGraph — composed structural + semantic view of the repo (rc8+).
 *
 * This module is a thin orchestrator that derives a richer per-node
 * picture from three already-existing sources, WITHOUT modifying any
 * of them:
 *
 *   1. graphResolver   → forward / reverse import Maps (the structural facts)
 *   2. knowledgeStore  → user / agent-provided summaries + tags (the semantic layer)
 *   3. eventStore      → recent touch activity per file (the temporal layer, optional)
 *
 * Lifecycle mirrors GraphResolver: one async rebuild at a time, last
 * good snapshot wins on failure, debounced trigger from the watcher.
 *
 * Derived per node (recomputed on every rebuild — cheap, deterministic):
 *
 *   - path, kind, sizeBytes, lastModifiedMs (from fs.stat — 'source' if it
 *     parses through the import graph, never throws on missing files)
 *   - fanIn   = reverseMap.get(path).size  (how many files import this one)
 *   - fanOut  = forwardMap.get(path).size  (how many files this one imports)
 *   - summary, tags, summaryUpdatedAt — hydrated from knowledgeStore
 *
 * Computed per graph (once per rebuild):
 *
 *   - cycles  — Tarjan's SCC on the forward Map. Each SCC of size > 1 is a
 *               cycle (and self-loops of size 1 if present).
 *   - orphans — nodes with fanIn === 0 AND not in the `entryPoints` allowlist
 *               (configurable; defaults to common entry filenames). These
 *               are candidates for dead code review.
 *
 * Caps + safety
 * ─────────────
 *   - Default response cap from queries: 200 nodes (DEFAULT_RESPONSE_CAP)
 *   - Hard ceiling: 1000 nodes per response (HARD_RESPONSE_CAP)
 *   - fs.stat batched at FS_STAT_CONCURRENCY=50 to avoid file-handle storms
 *   - Tarjan yields with setImmediate every YIELD_EVERY_N_NODES iterations
 *     so we never block the event loop more than ~50 ms continuously
 *   - All input paths go through normalize() — same forward-slash repo-relative
 *     contract as the rest of BlastRadius
 *   - The structural graph is consumed as-is from graphResolver; this module
 *     NEVER calls dependency-cruiser directly
 */

import { promises as fs } from 'node:fs'
import { join, extname } from 'node:path'

export const DEFAULT_RESPONSE_CAP = 200
export const HARD_RESPONSE_CAP = 1000

const FS_STAT_CONCURRENCY = 50
const YIELD_EVERY_N_NODES = 500

/**
 * Default "entry point" allowlist (rc8.2+ — full paths, not basenames).
 *
 * Why full paths
 * ──────────────
 * rc8.1 and earlier used basenames here ('index.js', 'app.js', …).
 * That had two failure modes:
 *
 *   1. False negatives. The basename `app.js` matched both
 *      src/server/app.js (legitimate entry) AND src/public/app.js
 *      (browser code dependency-cruiser cannot parse, so it surfaces
 *      with fanIn=0 fanOut=0 — a textbook orphan informativo). The
 *      basename collision silently excluded `src/public/app.js` from
 *      every orphan query. Confirmed against the live server:
 *      `/api/graph/orphans` returned an empty list even with the file
 *      sitting right there with both fans at zero.
 *
 *   2. False positives. ANY user-repo file named `index.js`
 *      anywhere in their tree would be treated as an entry point and
 *      hidden from orphan review. Not ideal for repos with multiple
 *      `index.js` files (one per package in a monorepo, for example).
 *
 * Full repo-relative paths fix both. A future per-repo override can
 * extend this set without ever falling back to basename heuristics.
 *
 * What's in the set
 * ─────────────────
 * Process entry points of THIS repo (BlastRadius). For agent
 * observability of OTHER repos, the active repo's RealEntryPoints
 * should ideally come from dependency-cruiser's own entry detection;
 * that's a future iteration. For now we ship the BlastRadius set as
 * the default so the orphan list is honest when self-observing.
 */
export const DEFAULT_ENTRY_POINTS = new Set([
  // Backend boot
  'src/server/index.js',
  // Hooks — each is its own process entry (PostToolUse → Node)
  'src/hook/log-touch.js',
  'src/hook/log-touch-antigravity.js',
  // MCP stdio shim entries (rc5+)
  'bin/blastradius-mcp.mjs',
  'bin/blastradius-mcp.cjs',
  // Tooling configs that import + run code at the top level
  'vitest.config.js',
  'playwright.config.js',
])

/** Single source of truth for path normalization in this module. */
function normPath(p) {
  if (p == null) return ''
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

/** Classify a node by its path extension + location. Conservative —
 *  defaults to 'source' when in doubt, since graphResolver only feeds
 *  us files it considered importable in the first place. */
function classifyKind(pathNorm) {
  const ext = extname(pathNorm).toLowerCase()
  if (pathNorm.startsWith('tests/') || pathNorm.includes('/tests/') || pathNorm.endsWith('.test.js') || pathNorm.endsWith('.test.ts')) {
    return 'test'
  }
  if (ext === '.json' || ext === '.yaml' || ext === '.yml' || ext === '.toml') return 'config'
  if (ext === '.md' || ext === '.mdx' || ext === '.txt') return 'doc'
  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) return 'source'
  return 'other'
}

/** Simple async batch limiter — Promise.all over chunks of N. */
async function batched(items, concurrency, worker) {
  const out = new Array(items.length)
  let cursor = 0
  async function next() {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await worker(items[i], i)
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, next)
  await Promise.all(workers)
  return out
}

/** Yield to the event loop. Used inside long synchronous loops. */
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Tarjan's strongly-connected-components algorithm — iterative
 * implementation so we don't risk a stack overflow on deep graphs.
 *
 * Returns an array of SCCs (each itself an array of node paths).
 * SCCs of size > 1 are cycles; SCCs of size 1 are NOT cycles UNLESS
 * the node has a self-edge (a → a). We surface self-edges in the
 * output too, because they're equally problematic.
 *
 * @param {Map<string, Set<string>>} forward
 * @returns {Promise<Array<string[]>>} cycles
 */
async function findCycles(forward) {
  /** @type {Map<string, number>} */
  const index = new Map()
  /** @type {Map<string, number>} */
  const lowlink = new Map()
  const onStack = new Set()
  const stack = []
  const cycles = []
  let counter = 0
  let processed = 0

  // Iterative Tarjan using an explicit work stack. Each work item is
  // a tuple [node, neighborIterator]. We process neighbors one at a
  // time, pushing the descendant onto the work stack when we need to
  // recurse, then resuming the parent when control returns.
  async function strongconnect(start) {
    const work = [[start, forward.get(start)?.values() ?? [].values()]]
    index.set(start, counter)
    lowlink.set(start, counter)
    counter++
    stack.push(start)
    onStack.add(start)

    while (work.length > 0) {
      const top = work[work.length - 1]
      const [u, iter] = top
      let advanced = false
      let next = iter.next()
      while (!next.done) {
        const v = next.value
        if (!index.has(v)) {
          // Descend into v.
          index.set(v, counter)
          lowlink.set(v, counter)
          counter++
          stack.push(v)
          onStack.add(v)
          work.push([v, forward.get(v)?.values() ?? [].values()])
          advanced = true
          break
        } else if (onStack.has(v)) {
          lowlink.set(u, Math.min(lowlink.get(u), index.get(v)))
        }
        next = iter.next()
      }
      if (!advanced) {
        // Backtrack from u to its parent (if any).
        if (lowlink.get(u) === index.get(u)) {
          const scc = []
          while (true) {
            const w = stack.pop()
            onStack.delete(w)
            scc.push(w)
            if (w === u) break
          }
          if (scc.length > 1) {
            cycles.push(scc)
          } else {
            // Self-loop detection.
            const self = forward.get(u)
            if (self && self.has(u)) cycles.push([u])
          }
        }
        work.pop()
        if (work.length > 0) {
          const parent = work[work.length - 1][0]
          lowlink.set(parent, Math.min(lowlink.get(parent), lowlink.get(u)))
        }
      }
      processed++
      if (processed % YIELD_EVERY_N_NODES === 0) await yieldToEventLoop()
    }
  }

  for (const node of forward.keys()) {
    if (!index.has(node)) {
      await strongconnect(node)
    }
  }
  return cycles
}

/**
 * KnowledgeGraph — per-repo composed view. Lifecycle:
 *
 *   1. graphResolver finishes a rebuild and calls knowledgeGraph.rebuild()
 *   2. knowledgeGraph reads forward/reverse Maps, fs.stat's each node,
 *      hydrates summaries from knowledgeStore, computes cycles + orphans.
 *   3. The result is atomically swapped into this.current — readers
 *      see the previous snapshot until the new one is fully built.
 */
export class KnowledgeGraph {
  /**
   * @param {{
   *   repoPath: string,
   *   graphResolver: object,                // provides getGraph()
   *   knowledgeStore: object,               // load(), getRepoNodes(), setNodeSummary()
   *   logger?: object,
   *   entryPoints?: Set<string>,
   * }} opts
   */
  constructor(opts) {
    if (!opts?.repoPath) throw new Error('KnowledgeGraph: repoPath required')
    if (!opts?.graphResolver) throw new Error('KnowledgeGraph: graphResolver required')
    if (!opts?.knowledgeStore) throw new Error('KnowledgeGraph: knowledgeStore required')
    this.repoPath = opts.repoPath
    this.graphResolver = opts.graphResolver
    this.knowledgeStore = opts.knowledgeStore
    this.logger = opts.logger ?? { debug() {}, info() {}, warn() {} }
    this.entryPoints = opts.entryPoints ?? DEFAULT_ENTRY_POINTS
    this.debounceMs = opts.debounceMs ?? 500

    /** Last successful snapshot. Always non-null after construction. */
    this.current = this._emptySnapshot()
    /** @type {Promise<void> | null} */
    this.inflight = null
    /** @type {NodeJS.Timeout | null} */
    this.debounceTimer = null
  }

  /** Empty starting snapshot. Used until the first rebuild completes. */
  _emptySnapshot() {
    return {
      nodes: new Map(),   // pathNorm → node object
      cycles: [],
      orphans: [],
      builtAt: 0,
      stats: { nodes: 0, edges: 0, cycles: 0, orphans: 0, withSummary: 0 },
    }
  }

  /** Return the current snapshot. Never null. May be stale while
   *  rebuild is in flight. */
  getSnapshot() {
    return this.current
  }

  /** Convenience accessor for a single node — null if not in the graph. */
  getNode(pathNorm) {
    return this.current.nodes.get(normPath(pathNorm)) ?? null
  }

  /**
   * Full rebuild. Reads from graphResolver (must already be built)
   * and knowledgeStore (must already be loaded), stats files on
   * disk, classifies, computes cycles + orphans. Atomic swap on
   * success. On failure: keeps the previous snapshot, logs warn.
   */
  async rebuild() {
    if (this.inflight) return this.inflight
    const promise = (async () => {
      const t0 = Date.now()
      try {
        const fresh = await this._buildSnapshot()
        this.current = fresh
        this.logger.info(
          {
            repo: this.repoPath,
            nodes: fresh.stats.nodes,
            cycles: fresh.stats.cycles,
            orphans: fresh.stats.orphans,
            withSummary: fresh.stats.withSummary,
            ms: Date.now() - t0,
          },
          'knowledge graph rebuilt',
        )
      } catch (err) {
        this.logger.warn(
          { err: String(err?.message ?? err), repo: this.repoPath, ms: Date.now() - t0 },
          'knowledge graph rebuild failed; keeping previous snapshot',
        )
      }
    })()
    this.inflight = promise
    try {
      await promise
    } finally {
      this.inflight = null
    }
  }

  /** Internal builder. Pure logic — no side effects on `this` until
   *  the caller swaps `current`. */
  async _buildSnapshot() {
    const graph = this.graphResolver.getGraph()
    const forward = graph?.forward ?? new Map()
    const reverse = graph?.reverse ?? new Map()

    // Universe of nodes: union of forward keys, reverse keys, and
    // anything that appears as a target of some import.
    const universe = new Set()
    for (const k of forward.keys()) universe.add(k)
    for (const k of reverse.keys()) universe.add(k)

    // fs.stat each path in batches. Missing files are tolerated —
    // they go into the snapshot with sizeBytes=0, lastModifiedMs=0.
    const paths = [...universe]
    const stats = await batched(paths, FS_STAT_CONCURRENCY, async (rel) => {
      try {
        const s = await fs.stat(join(this.repoPath, rel))
        return { sizeBytes: s.size, lastModifiedMs: s.mtimeMs | 0 }
      } catch {
        return { sizeBytes: 0, lastModifiedMs: 0 }
      }
    })

    // Hydrate persisted summaries (one call → object lookup).
    const persistedByPath = this.knowledgeStore.getRepoNodes(this.repoPath) || {}

    const nodes = new Map()
    let edges = 0
    let withSummary = 0
    for (let i = 0; i < paths.length; i++) {
      const pathNorm = paths[i]
      const fanOut = forward.get(pathNorm)?.size ?? 0
      const fanIn = reverse.get(pathNorm)?.size ?? 0
      edges += fanOut
      const persisted = persistedByPath[pathNorm] ?? null
      if (persisted) withSummary++
      nodes.set(pathNorm, {
        path: pathNorm,
        kind: classifyKind(pathNorm),
        sizeBytes: stats[i].sizeBytes,
        lastModifiedMs: stats[i].lastModifiedMs,
        fanIn,
        fanOut,
        summary: persisted?.summary ?? null,
        tags: persisted?.tags ?? [],
        summaryUpdatedAt: persisted?.updatedAt ?? null,
      })
    }

    const cycles = await findCycles(forward)

    // rc8.2+: an orphan is a node BOTH no one imports AND that imports
    // nothing — i.e. genuinely isolated from the import graph and not a
    // legitimate entry point. Previously the rule was only `fanIn === 0`,
    // which mis-classified every real entry point (server boot, hook
    // CLIs, vitest config) as an orphan unless the basename happened to
    // match the allowlist — and the basename allowlist had its own
    // false-negative problem with `src/public/app.js`. Both failure
    // modes are gone with the stricter rule + full-path allowlist.
    //
    // Note `entryPoints.has(pathNorm)` — match the full repo-relative
    // path, not the basename. The allowlist is intentionally explicit
    // about which files are legitimate roots.
    const orphans = []
    for (const [pathNorm, node] of nodes) {
      if (node.fanIn === 0 && node.fanOut === 0 && !this.entryPoints.has(pathNorm)) {
        orphans.push(pathNorm)
      }
    }
    orphans.sort()

    return {
      nodes,
      cycles,
      orphans,
      builtAt: Date.now(),
      stats: {
        nodes: nodes.size,
        edges,
        cycles: cycles.length,
        orphans: orphans.length,
        withSummary,
      },
    }
  }

  /**
   * Schedule a debounced rebuild. Same pattern as GraphResolver — the
   * watcher fires this on every source-file change; bursts coalesce
   * into a single rebuild after `debounceMs` of quiet.
   *
   * Note: this fires INDEPENDENTLY of GraphResolver's own
   * scheduleRebuild — both run on the same trigger. Because
   * GraphResolver.getGraph() always returns the last known-good
   * snapshot (atomic swap on success), the worst case is that one
   * KnowledgeGraph rebuild reads a structural snapshot one tick
   * stale; the next file change brings it current. We accept that
   * staleness — synchronizing would require knowledgeGraph to peek
   * at graphResolver's private inflight Promise, which couples the
   * two modules unnecessarily.
   */
  scheduleRebuild() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.rebuild().catch(() => { /* already logged */ })
    }, this.debounceMs)
    this.debounceTimer.unref?.()
  }

  /** Cancel any pending debounced rebuild. RepoContext.stop() calls
   *  this during shutdown so the process can exit cleanly. */
  stop() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = null
  }
}
