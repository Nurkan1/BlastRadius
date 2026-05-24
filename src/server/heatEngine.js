/**
 * BlastRadius heat engine.
 *
 * Pure function: takes an array of touch events (from the JSONL log), a
 * time window, an anchor `now`, the total file count of the target repo,
 * and an optional import graph + propagation depth, and returns:
 *
 *   {
 *     files:       { [pathNorm]: "red" | "orange" | "yellow" },
 *     propagation: { [yellowPath]: [{path: redPath, depth: number}, ...] },
 *     metrics:     { red, orange, yellow, total, blastRadius }
 *   }
 *
 * `propagation` only contains entries for YELLOW files, attributing each
 * to the red(s) that originated it and the shortest BFS depth at which
 * each red reaches it. Same red reaching a yellow at multiple depths
 * is kept once at its minimum depth. Sort order is `depth asc, path asc`
 * so the UI can render the list directly without re-sorting.
 *
 * Why no "cold" entries: the heat map is sparse. The frontend assumes any
 * file NOT in `files` is cold. That keeps the payload small for big repos.
 *
 * Color rules (per file, within window):
 *   - red    : at least one Edit or Write event
 *   - orange : Read events only, no Edit/Write
 *   - yellow : transitively imported (within `depth` levels) BY a red
 *              file in this window — only assigned when a `graph` is
 *              provided and the file isn't already red/orange (red and
 *              orange always win; reads do NOT propagate)
 *   - (cold) : no qualifying classification
 *
 * Windows (ms back from `now`):
 *   - iteration : 3 * 60 * 1000
 *   - hour      : 60 * 60 * 1000
 *   - session   : no time filter (caller supplies only today's events)
 *
 * blastRadius = round((red + orange + yellow) / totalFiles * 100).
 * Zero when totalFiles is 0 — never NaN, never Infinity.
 *
 * `total` keeps its Phase-2 meaning: count of files DIRECTLY touched in
 * the window (red + orange). Yellow files are not "touched"; they are
 * inferred.
 *
 * All inputs are validated defensively; the function never throws.
 */

import { consumersOfWithDepth } from './graphResolver.js'

const TARGET_TOOLS = new Set(['Edit', 'Write', 'Read'])
const WRITE_TOOLS = new Set(['Edit', 'Write'])

const WINDOW_MS = {
  iteration: 3 * 60 * 1000,
  hour: 60 * 60 * 1000,
  session: null, // no time filter
}

/** Normalize a path for use as a map key (forward slashes, trimmed). */
export function canonicalKey(p) {
  if (p == null) return ''
  return String(p).replace(/\\/g, '/').trim()
}

/** Resolve a window string to a millisecond budget. Unknown → session. */
export function resolveWindow(windowName) {
  if (windowName in WINDOW_MS) return WINDOW_MS[windowName]
  return WINDOW_MS.session
}

/** Parse a timestamp string defensively. Returns null when unusable. */
function parseTs(ts) {
  if (typeof ts !== 'string') return null
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Build the heat map.
 *
 * @param {object}  opts
 * @param {Array}   [opts.events=[]]            Array of touch events.
 * @param {string}  [opts.window='session']     iteration | hour | session
 * @param {Date}    [opts.now=new Date()]
 * @param {number}  [opts.totalFiles=0]         Total files in repo tree.
 * @param {object}  [opts.graph=null]           Import graph from graphResolver.
 *                                              When null, no yellow propagation.
 * @param {number}  [opts.depth=2]              BFS depth for yellow propagation
 *                                              over the reverse import graph.
 *                                              Clamped to [1, 10].
 * @param {Date|null} [opts.iterationStartedAt=null]
 *                                              When set, the "iteration"
 *                                              window means "events at or
 *                                              after this timestamp" instead
 *                                              of the default 3-minute
 *                                              heuristic. Unused for other
 *                                              windows.
 * @param {Set<string>|null} [opts.treeFiles=null]
 *                                              When provided, drop any
 *                                              touched/propagated file
 *                                              whose canonical path isn't
 *                                              in this set. Used to keep
 *                                              metrics and the tree view
 *                                              in sync (events for
 *                                              .gitignored or deleted
 *                                              files would otherwise
 *                                              inflate the counters
 *                                              without ever appearing in
 *                                              the rendered tree).
 * @returns {{ files: Record<string,string>, metrics: object }}
 */
export function computeHeat({
  events,
  window: windowName = 'session',
  now = new Date(),
  totalFiles = 0,
  graph = null,
  depth = 2,
  iterationStartedAt = null,
  treeFiles = null,
} = {}) {
  const safeEvents = Array.isArray(events) ? events : []
  const windowMs = resolveWindow(windowName)
  const nowMs = (now instanceof Date && !Number.isNaN(now.getTime()))
    ? now.getTime()
    : Date.now()
  // For the "iteration" window, prefer the explicit marker (set by the
  // user via POST /api/iteration/close). Falls back to the 3-min heuristic
  // when no marker exists yet — preserves Phase 2 behavior on a fresh boot.
  let cutoff = windowMs == null ? null : nowMs - windowMs
  if (windowName === 'iteration' && iterationStartedAt instanceof Date
      && !Number.isNaN(iterationStartedAt.getTime())) {
    cutoff = iterationStartedAt.getTime()
  }

  // Per-file state: which kind of touch did we see?
  /** @type {Map<string, { write: boolean, read: boolean, lastTs: number, lastSessionId: string }>} */
  const fileStatus = new Map()

  for (const ev of safeEvents) {
    if (!ev || typeof ev !== 'object') continue
    const tool = ev.tool
    if (!TARGET_TOOLS.has(tool)) continue

    const key = canonicalKey(ev.pathNorm)
    if (!key) continue

    const tsMs = parseTs(ev.ts)
    if (tsMs == null) continue

    // Lower-bound window filter only; future timestamps (clock skew) pass.
    if (cutoff != null && tsMs < cutoff) continue

    const prev = fileStatus.get(key)
    const status = prev ?? { write: false, read: false, lastTs: 0, lastSessionId: '' }
    if (WRITE_TOOLS.has(tool)) status.write = true
    else status.read = true // tool === 'Read' (others filtered above)

    if (tsMs > status.lastTs) {
      status.lastTs = tsMs
      status.lastSessionId = ev.sessionId || ''
    }

    if (!prev) fileStatus.set(key, status)
  }

  // Drop touched files that don't exist in the rendered tree (e.g.
  // .gitignored builds, deleted files, paths under node_modules/).
  // Without this, the counter would say "6 red" but only 2 actually
  // appear in the tree pane, leaving the user confused.
  if (treeFiles instanceof Set && treeFiles.size > 0) {
    for (const key of [...fileStatus.keys()]) {
      if (!treeFiles.has(key)) fileStatus.delete(key)
    }
  }

  const files = {}
  /** Paths that ended up red — used as propagation seeds below. */
  const redPaths = []
  let red = 0
  let orange = 0
  for (const [path, st] of fileStatus) {
    if (st.write) {
      files[path] = 'red'
      red += 1
      redPaths.push(path)
    } else if (st.read) {
      files[path] = 'orange'
      orange += 1
    }
  }

  // Yellow propagation: for every red file, walk the REVERSE import graph
  // up to `depth` levels and mark each unique consumer that isn't already
  // red or orange. Reds and oranges never get downgraded to yellow — the
  // direct color always wins. Reads do NOT propagate (no change occurred,
  // so consumers aren't impacted).
  //
  // Per-yellow attribution: we also build `propagation`, a map from each
  // yellow path to the list of red paths that originated it AND the BFS
  // depth at which each red reaches it. When two reds reach the same
  // yellow we keep BOTH origins (with their respective depths) so the
  // UI can answer "why is this file yellow?" without re-running BFS.
  // When the SAME red reaches a yellow at multiple depths via different
  // paths, BFS naturally records the shortest (level-by-level expansion),
  // which is the answer we want.
  let yellow = 0
  /** @type {Record<string, Array<{path: string, depth: number}>>} */
  const propagation = {}
  if (graph && graph.reverse instanceof Map && redPaths.length > 0) {
    const yellowSet = new Set()
    /** @type {Map<string, Map<string, number>>}  yellow → (red → depth) */
    const yellowOrigins = new Map()
    for (const seed of redPaths) {
      const consumersWithDepth = consumersOfWithDepth(graph, seed, depth)
      for (const [consumer, hopCount] of consumersWithDepth) {
        if (files[consumer]) continue        // already red or orange — leave alone
        // Same tree-intersection rule applies to propagation: don't
        // surface yellow consumers that aren't in the tree.
        if (treeFiles instanceof Set && treeFiles.size > 0 && !treeFiles.has(consumer)) continue
        yellowSet.add(consumer)
        let origins = yellowOrigins.get(consumer)
        if (!origins) {
          origins = new Map()
          yellowOrigins.set(consumer, origins)
        }
        // Record (or improve) this red's distance to this yellow.
        const prev = origins.get(seed)
        if (prev == null || hopCount < prev) origins.set(seed, hopCount)
      }
    }
    for (const path of yellowSet) {
      files[path] = 'yellow'
      yellow += 1
      const origins = yellowOrigins.get(path)
      if (origins && origins.size > 0) {
        // Sort by depth asc, then path asc so the UI list is stable
        // across requests and reads naturally ("closest red first").
        propagation[path] = [...origins]
          .map(([redPath, redDepth]) => ({ path: redPath, depth: redDepth }))
          .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
      }
    }
  }

  // `total` keeps the Phase-2 meaning: files DIRECTLY touched in the
  // window. Yellow files are inferred, not touched, so they don't count.
  const total = fileStatus.size
  const safeTotalFiles = Number.isFinite(totalFiles) && totalFiles > 0 ? totalFiles : 0
  const blastRadius = safeTotalFiles > 0
    ? Math.round(((red + orange + yellow) / safeTotalFiles) * 100)
    : 0

  const attributions = {}
  for (const [path, status] of fileStatus) {
    let agent = 'Claude Code'
    if (status.lastSessionId === 'antigravity-session') {
      agent = 'Antigravity'
    } else if (!status.lastSessionId) {
      agent = 'Manual / CLI'
    }
    attributions[path] = agent
  }

  return {
    files,
    propagation,
    attributions,
    metrics: { red, orange, yellow, total, blastRadius },
  }
}
