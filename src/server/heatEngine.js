/**
 * BlastRadius heat engine.
 *
 * Pure function: takes an array of touch events (from the JSONL log), a
 * time window, an anchor `now`, the total file count of the target repo,
 * and an optional import graph + propagation depth, and returns:
 *
 *   {
 *     files:   { [pathNorm]: "red" | "orange" | "yellow" },
 *     metrics: { red, orange, yellow, total, blastRadius }
 *   }
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

import { consumersOf } from './graphResolver.js'

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
  /** @type {Map<string, { write: boolean, read: boolean }>} */
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
    const status = prev ?? { write: false, read: false }
    if (WRITE_TOOLS.has(tool)) status.write = true
    else status.read = true // tool === 'Read' (others filtered above)
    if (!prev) fileStatus.set(key, status)
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
  let yellow = 0
  if (graph && graph.reverse instanceof Map && redPaths.length > 0) {
    const yellowSet = new Set()
    for (const seed of redPaths) {
      const consumers = consumersOf(graph, seed, depth)
      for (const consumer of consumers) {
        if (files[consumer]) continue        // already red or orange — leave alone
        if (yellowSet.has(consumer)) continue // already marked yellow this pass
        yellowSet.add(consumer)
      }
    }
    for (const path of yellowSet) {
      files[path] = 'yellow'
      yellow += 1
    }
  }

  // `total` keeps the Phase-2 meaning: files DIRECTLY touched in the
  // window. Yellow files are inferred, not touched, so they don't count.
  const total = fileStatus.size
  const safeTotalFiles = Number.isFinite(totalFiles) && totalFiles > 0 ? totalFiles : 0
  const blastRadius = safeTotalFiles > 0
    ? Math.round(((red + orange + yellow) / safeTotalFiles) * 100)
    : 0

  return {
    files,
    metrics: { red, orange, yellow, total, blastRadius },
  }
}
