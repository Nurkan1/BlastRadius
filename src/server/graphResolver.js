/**
 * Graph resolver — wraps `dependency-cruiser` to build a forward + reverse
 * import graph of the target repo, and exposes a BFS helper that finds the
 * consumers of a given file up to N levels deep.
 *
 * Exported surface:
 *   - `build(repoPath, opts)`      — pure async function. Returns a
 *                                    fresh { forward, reverse, builtAt } object.
 *                                    Loads dependency-cruiser dynamically so
 *                                    importing this module is cheap (heatEngine
 *                                    tests don't pay the ~12 MB load cost).
 *   - `consumersOf(graph, p, depth)` — pure synchronous BFS. Handles cycles,
 *                                    invalid input, and missing nodes.
 *   - `GraphResolver`              — stateful lifecycle class used by the
 *                                    server: holds the current graph, runs
 *                                    debounced async rebuilds, never returns
 *                                    null. Internally delegates to `build`.
 *
 * The reverse graph is intentionally constructed from `dependencies[].resolved`
 * (not from dep-cruiser's `dependents` field) so we control what gets in:
 *   - skip dependencies with `couldNotResolve: true` (dynamic / missing imports)
 *   - skip `coreModule: true` (node:fs, etc.)
 *   - skip anything inside node_modules (external deps)
 *
 * Paths are stored as forward-slashed, repo-relative strings so they
 * line up exactly with the `pathNorm` field on hook events.
 */

import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const DEFAULT_TTL_MS = 5 * 60 * 1000
const DEFAULT_DEBOUNCE_MS = 500
const DEFAULT_INCLUDE_ONLY = '^(src|lib|app)/'
const DEFAULT_EXCLUDE = 'node_modules|/dist/|/build/|\\.next|\\.cache|\\.turbo|\\.vercel|coverage|\\.vitest-cache'
const SOURCE_EXT_RE = /\.(js|jsx|ts|tsx|mjs|cjs)$/

const noopLogger = () => ({ debug() {}, info() {}, warn() {} })

/** YYYY-MM-DD-stable, single-source path normalization. */
function normPath(p) {
  if (p == null) return ''
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

/** Drop any leading `repoPath/` prefix from an absolute or repo-relative
 *  path so callers always see repo-relative paths. */
function stripRepoPrefix(rawPath, repoForward) {
  const p = normPath(rawPath)
  const repo = repoForward.replace(/\/+$/, '')
  if (p.startsWith(repo + '/')) return p.slice(repo.length + 1)
  return p
}

/**
 * Build the import graph for `repoPath` by running dependency-cruiser
 * with our standard options. Returns:
 *
 *   {
 *     forward: Map<string, Set<string>>,
 *     reverse: Map<string, Set<string>>,
 *     builtAt: number,
 *     stats: { modules: number, edges: number, unresolved: number }
 *   }
 *
 * Always returns a valid graph object even when the repo has zero source
 * files — empty Maps in that case.
 */
export async function build(repoPath, opts = {}) {
  if (!repoPath || typeof repoPath !== 'string') {
    throw new Error('graphResolver.build: repoPath is required')
  }
  const absRepo = resolve(repoPath)
  const repoForward = normPath(absRepo)
  const includeOnly = opts.includeOnly ?? DEFAULT_INCLUDE_ONLY
  const exclude = opts.exclude ?? DEFAULT_EXCLUDE

  // Dynamic import keeps the dep-cruiser module out of the load graph
  // until we actually need it (and out of unrelated test runs).
  const { cruise } = await import('dependency-cruiser')

  // dependency-cruiser interprets `source` paths relative to process.cwd().
  // We swap cwd to the target repo just for the duration of the cruise
  // call so the produced `source` and `resolved` paths come back
  // repo-relative — exactly matching the pathNorm convention the rest of
  // BlastRadius uses. The try/finally guarantees restoration even on
  // throw. The brief window of differing cwd doesn't race with anything
  // else because Express handlers never read cwd.
  // Only enable the TypeScript path-resolver when the repo actually has
  // a tsconfig.json. dependency-cruiser's tsconfig-paths loader does a
  // synchronous statSync on the file and THROWS if it's missing — so
  // passing this option blindly kills graph builds in any JS-only repo
  // (the failure is caught by rebuild() and silently logged as a warn,
  // which is how we lost the entire propagation feature in BlastRadius
  // itself for a long while). Same defensive check for jsconfig.json
  // for completeness.
  const tsconfigExists = existsSync(join(absRepo, 'tsconfig.json'))
  const jsconfigExists = existsSync(join(absRepo, 'jsconfig.json'))
  const cruiseOptions = {
    includeOnly,
    exclude: { path: exclude },
    doNotFollow: { path: 'node_modules' },
    // Default outputType returns parsed objects on res.output.
    // outputType: 'json' instead would return a JSON STRING, which
    // we'd have to re-parse — measurable but pointless overhead.
  }
  if (tsconfigExists) cruiseOptions.tsConfig = { fileName: 'tsconfig.json' }
  if (jsconfigExists) cruiseOptions.babelConfig = { fileName: 'jsconfig.json' }

  const previousCwd = process.cwd()
  let result
  try {
    process.chdir(absRepo)
    result = await cruise(['.'], cruiseOptions)
  } finally {
    process.chdir(previousCwd)
  }

  const forward = /** @type {Map<string, Set<string>>} */ (new Map())
  const reverse = /** @type {Map<string, Set<string>>} */ (new Map())
  let unresolved = 0
  let edges = 0

  const modules = result?.output?.modules ?? []
  for (const mod of modules) {
    const src = stripRepoPrefix(mod.source, repoForward)
    if (!src) continue
    // Skip external sources that snuck in through transitive follow:
    if (src.startsWith('node_modules/') || src.includes('/node_modules/')) continue

    const deps = new Set()
    for (const dep of (mod.dependencies || [])) {
      if (dep.couldNotResolve) {
        unresolved += 1
        continue
      }
      if (dep.coreModule) continue
      const target = stripRepoPrefix(dep.resolved ?? dep.module, repoForward)
      if (!target) continue
      if (target.startsWith('node_modules/') || target.includes('/node_modules/')) continue
      // Self-imports would corrupt the reverse map; ignore them.
      if (target === src) continue
      deps.add(target)
      const incoming = reverse.get(target)
      if (incoming) incoming.add(src)
      else reverse.set(target, new Set([src]))
      edges += 1
    }
    forward.set(src, deps)
  }

  return {
    forward,
    reverse,
    builtAt: Date.now(),
    stats: { modules: forward.size, edges, unresolved },
  }
}

/**
 * Return the set of files that (transitively) import `path`, up to
 * `depth` levels of indirection in the reverse graph. The starting file
 * is excluded from the result. Cycles are guarded by a visited set so
 * we never loop. `depth` is clamped to a safe range [1, 10].
 *
 * Pure function — no IO, no module loading. Safe to call from tests
 * with hand-built graph objects.
 */
export function consumersOf(graph, path, depth = 2) {
  const out = new Set()
  if (!graph || !(graph.reverse instanceof Map)) return out
  const start = normPath(path)
  if (!start) return out
  const safeDepth = Number.isInteger(depth) && depth > 0
    ? Math.min(depth, 10)
    : 2

  const visited = new Set([start])
  let frontier = new Set([start])
  for (let level = 0; level < safeDepth; level += 1) {
    const next = new Set()
    for (const node of frontier) {
      const parents = graph.reverse.get(node)
      if (!parents) continue
      for (const parent of parents) {
        if (visited.has(parent)) continue
        visited.add(parent)
        next.add(parent)
        out.add(parent)
      }
    }
    if (next.size === 0) break
    frontier = next
  }
  return out
}

/** True iff this file path should trigger a graph rebuild when changed. */
export function isSourceFile(p) {
  return SOURCE_EXT_RE.test(normPath(p))
}

/**
 * Stateful wrapper for the live server. Owns:
 *   - the current graph (always non-null after construction)
 *   - rebuild lifecycle: one in-flight at a time; failures keep previous
 *   - debounced rebuild triggers from the file watcher
 *   - TTL-based forced rebuild for safety (default 5 min)
 */
export class GraphResolver {
  /**
   * @param {{
   *   repoPath: string,
   *   includeOnly?: string,
   *   exclude?: string,
   *   ttlMs?: number,
   *   debounceMs?: number,
   *   logger?: { debug: Function, info: Function, warn: Function },
   * }} opts
   */
  constructor(opts) {
    if (!opts?.repoPath) throw new Error('GraphResolver: repoPath required')
    this.repoPath = opts.repoPath
    this.includeOnly = opts.includeOnly ?? DEFAULT_INCLUDE_ONLY
    this.exclude = opts.exclude ?? DEFAULT_EXCLUDE
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.logger = opts.logger ?? noopLogger()

    /** @type {{ forward: Map<string,Set<string>>, reverse: Map<string,Set<string>>, builtAt: number, stats?: object }} */
    this.current = { forward: new Map(), reverse: new Map(), builtAt: 0 }
    /** @type {Promise<void> | null} */
    this.inflight = null
    /** @type {NodeJS.Timeout | null} */
    this.debounceTimer = null
  }

  /** Return the current graph. Never null. May be stale during a rebuild. */
  getGraph() {
    return this.current
  }

  /**
   * Force-build the graph immediately (await). If a rebuild is already
   * in flight, returns the same promise so we never run two cruises in
   * parallel. On error: keeps the previous graph, logs the failure.
   */
  async rebuild() {
    if (this.inflight) return this.inflight
    const promise = (async () => {
      const t0 = Date.now()
      try {
        const fresh = await build(this.repoPath, {
          includeOnly: this.includeOnly,
          exclude: this.exclude,
        })
        // Atomic swap — only happens on success.
        this.current = fresh
        this.logger.info(
          { modules: fresh.stats?.modules, edges: fresh.stats?.edges, ms: Date.now() - t0 },
          'graph rebuilt',
        )
      } catch (err) {
        // Escalate to `error` level on the FIRST failure (graph went
        // from "never built" → "broken") so the user sees the actual
        // reason in the launcher output instead of having to chase a
        // silent `warn` line. Subsequent failures stay at `warn` to
        // avoid log spam during a sustained outage.
        const severity = this.current.builtAt === 0 ? 'error' : 'warn'
        this.logger[severity](
          {
            err: String(err?.message ?? err),
            repo: this.repoPath,
            ms: Date.now() - t0,
          },
          severity === 'error'
            ? 'graph rebuild FAILED (propagation will be disabled); see error above'
            : 'graph rebuild failed; keeping previous graph',
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

  /**
   * Schedule a debounced rebuild. Multiple calls within `debounceMs`
   * coalesce into one rebuild. Bursts from `git checkout` / `npm
   * install` won't trigger a storm.
   */
  scheduleRebuild() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.rebuild().catch(() => { /* already logged */ })
    }, this.debounceMs)
    this.debounceTimer.unref?.()
  }

  /** Stop pending timers. Used by graceful shutdown. */
  stop() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = null
  }
}
