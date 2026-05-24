/**
 * BlastRadius heat engine.
 *
 * Pure function: takes an array of touch events (from the JSONL log), a
 * time window, an anchor `now`, and the total file count of the target
 * repo, and returns:
 *
 *   {
 *     files:   { [pathNorm]: "red" | "orange" },     // never "yellow" or "cold"
 *     metrics: { red, orange, yellow, total, blastRadius }
 *   }
 *
 * Why no "cold" entries: the heat map is sparse. The frontend assumes any
 * file NOT in `files` is cold. That keeps the payload small for big repos.
 *
 * Why no "yellow": Phase 2 placeholder. The metric stays at 0 until Phase 3
 * adds the prediction layer.
 *
 * Color rules (per file, within window):
 *   - red    : at least one Edit or Write event
 *   - orange : Read events only, no Edit/Write
 *   - (cold) : no qualifying events
 *
 * Windows (ms back from `now`):
 *   - iteration : 3 * 60 * 1000
 *   - hour      : 60 * 60 * 1000
 *   - session   : no time filter (caller supplies only today's events)
 *
 * blastRadius = round((red + orange) / totalFiles * 100). Zero when
 * totalFiles is 0 — never NaN, never Infinity.
 *
 * All inputs are validated defensively; the function never throws.
 */

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
 * @param {Array}   [opts.events=[]]    Array of touch events.
 * @param {string}  [opts.window='session']  iteration | hour | session
 * @param {Date}    [opts.now=new Date()]
 * @param {number}  [opts.totalFiles=0]  Total files in repo tree.
 * @returns {{ files: Record<string,string>, metrics: object }}
 */
export function computeHeat({
  events,
  window: windowName = 'session',
  now = new Date(),
  totalFiles = 0,
} = {}) {
  const safeEvents = Array.isArray(events) ? events : []
  const windowMs = resolveWindow(windowName)
  const nowMs = (now instanceof Date && !Number.isNaN(now.getTime()))
    ? now.getTime()
    : Date.now()
  const cutoff = windowMs == null ? null : nowMs - windowMs

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
  let red = 0
  let orange = 0
  for (const [path, st] of fileStatus) {
    if (st.write) {
      files[path] = 'red'
      red += 1
    } else if (st.read) {
      files[path] = 'orange'
      orange += 1
    }
    // Yellow placeholder: never assigned in Phase 2.
  }

  const total = fileStatus.size
  const safeTotalFiles = Number.isFinite(totalFiles) && totalFiles > 0 ? totalFiles : 0
  const blastRadius = safeTotalFiles > 0
    ? Math.round(((red + orange) / safeTotalFiles) * 100)
    : 0

  return {
    files,
    metrics: { red, orange, yellow: 0, total, blastRadius },
  }
}
