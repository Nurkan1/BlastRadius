/**
 * Event store — keeps an in-memory array of touch events parsed from
 * today's JSONL log file.
 *
 * Strategy: read the full file once at boot (`loadInitial`), then on
 * every watcher notification, seek to the last known byte offset and
 * parse only the new bytes (`tail`). This keeps incremental reads
 * proportional to the delta, not to file size.
 *
 * The store is *not* a generic JSONL reader — it specifically targets
 * BlastRadius's daily log file at `${logDir}/session-YYYY-MM-DD.jsonl`.
 * Midnight rollover is handled by checking whether today's filename
 * has changed before each tail; if so, the store rolls over to the new
 * file and resets the byte offset.
 *
 * Robustness:
 *   - Missing log file at boot → empty store (the hook hasn't fired
 *     yet on a fresh day; no error).
 *   - Truncation or out-of-order writes → on next tail we detect that
 *     `stat.size < lastSize` and reload the file from scratch.
 *   - Malformed JSONL line → skipped silently (the line stays in the
 *     file; we just don't promote it to the in-memory array).
 */

import { createReadStream, promises as fs } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { logFilePath } from '../hook/log-touch.js'

/**
 * Canonicalize a repo path for comparison: forward slashes, no
 * trailing slash. Empty string when input is bad.
 */
function normalizeRepoPath(p) {
  if (typeof p !== 'string' || p.length === 0) return ''
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Heuristic absolute-path detector. Catches POSIX (`/foo`) and Windows
 * drive-letter (`C:/foo`, `c:/foo`) inputs. Used to tell apart legacy
 * `pathNorm` values that were already repo-relative from absolute ones
 * the new hook started emitting when running from outside the repo.
 */
function isAbsolutePathish(p) {
  if (typeof p !== 'string' || p.length === 0) return false
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p)
}

/**
 * Maximum number of distinct days a single loadDays() / getEventsInRange()
 * call can span. Defends against the obvious "give me last 5 years" footgun
 * that would let the process load gigabytes of historical JSONL into RAM.
 * 30 days is wide enough to cover any sensible "recent activity" report
 * yet keeps the pathological case bounded to ~30 file reads.
 *
 * Exported for tests that want to verify the cap behaviour without
 * generating MAX+N files.
 */
export const MAX_RANGE_DAYS = 30

/** Format a Date into the YYYY-MM-DD key the JSONL filename uses — in UTC,
 *  matching dayKey() in log-touch-shared.js (rc9.13). Both must agree, and
 *  UTC makes the day boundary timezone-independent. */
function dateKey(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Coerce any of (Date, ISO string, "YYYY-MM-DD") to a Date pinned at the
 * START of that **UTC** day (rc9.13 — matches the UTC daily-file key, so
 * date-range enumeration lines up with the filenames regardless of the
 * machine's timezone). Returns null on garbage input — callers check.
 */
function toUtcDayStart(input) {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null
    return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()))
  }
  if (typeof input !== 'string' || !input) return null
  // Match strict YYYY-MM-DD first; otherwise fall back to Date.parse.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input)
  if (m) {
    const [, y, mo, d] = m
    const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)))
    return Number.isNaN(date.getTime()) ? null : date
  }
  const fallback = new Date(input)
  if (Number.isNaN(fallback.getTime())) return null
  return new Date(Date.UTC(fallback.getUTCFullYear(), fallback.getUTCMonth(), fallback.getUTCDate()))
}

/** Enumerate every day from `from` to `to` (both inclusive, UTC) as
 *  YYYY-MM-DD strings. Returns [] when from > to. */
function enumerateDays(from, to) {
  const out = []
  if (!from || !to || from > to) return out
  const cursor = new Date(from)
  while (cursor <= to) {
    out.push(dateKey(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}

export class EventStore {
  /**
   * @param {string} logDir Directory holding daily session-YYYY-MM-DD.jsonl files.
   * @param {{ warn?: Function }} [logger] Optional logger. When provided, the
   *        store emits a THROTTLED warning whenever it skips a corrupt JSONL
   *        line, so a misbehaving agent's malformed output is observable
   *        without flooding the log. Defaults to a no-op (silent, as before).
   */
  constructor(logDir, logger = null) {
    if (!logDir || typeof logDir !== 'string') {
      throw new Error('EventStore: logDir is required')
    }
    this.logDir = logDir
    this.logger = logger && typeof logger.warn === 'function' ? logger : { warn() {} }
    /** Running count of corrupt lines skipped this process (rc9.15). */
    this.corruptLineCount = 0
    /** @type {Array<object>} */
    this.events = []
    /** Absolute path of the file we're currently tailing. */
    this.currentFile = null
    /** Last byte offset we read up to in currentFile. */
    this.lastSize = 0
    /**
     * Historical-day cache. Map keyed by "YYYY-MM-DD" → array of events
     * parsed from the corresponding session-*.jsonl. Populated lazily by
     * loadDays() and queried by getEventsInRange() /
     * getEventsForRepoInRange(). Kept INTENTIONALLY SEPARATE from the
     * live `this.events` array so the current-day tail() path is
     * completely undisturbed by historical queries.
     *
     * Missing files (no activity on that day) are cached as an empty
     * array — that way a second range query for the same window
     * doesn't re-stat the disk for nothing.
     *
     * The cache is in-memory only; on server restart it rebuilds on
     * demand. Iteration count for a 30-day window with ~5 MB / day of
     * JSONL is roughly 150 MB peak — within budget, and the cache is
     * also dropped naturally when the process exits.
     * @type {Map<string, Array<object>>}
     */
    this.historicalEvents = new Map()
  }

  /** All events parsed so far. The returned array is the live one — do
   *  not mutate. heatEngine reads it as input. */
  getEvents() {
    return this.events
  }

  /**
   * Return all events whose touched file lives inside `repoPath`,
   * regardless of which directory Claude Code was launched from.
   *
   * Why path-based and not cwd-based: a user can have one Claude Code
   * session open in `~/projects/ideablast` and edit a file in
   * `~/projects/blastradius` from that same session — the hook records
   * `cwd: ideablast` but the touched path is in blastradius. The
   * earlier `cwd === repoPath` filter dropped those events on the
   * floor, which made the heat map go silent the moment the user
   * switched away from one repo's directory.
   *
   * Strategy:
   *   - Primary signal: `ev.path` (always an absolute, forward-slashed
   *     path written by the hook). When that path is inside `repoPath`,
   *     the event belongs to this repo. We also rewrite `pathNorm` to
   *     be repo-relative so the heat engine, tree set, and diff modal
   *     all line up on the same key.
   *   - Legacy fallback: older log entries from before this fix may
   *     have `pathNorm` already relative to `cwd` and rely on the
   *     cwd-match filter. Keep that path so we don't break historical
   *     log replay.
   *
   * Returns a NEW array — safe to mutate / consume.
   */
  getEventsForRepo(repoPath) {
    if (typeof repoPath !== 'string' || repoPath.length === 0) return []
    const target = normalizeRepoPath(repoPath)
    if (!target) return []
    const targetPrefix = target + '/'
    const out = []
    for (const ev of this.events) {
      if (!ev || typeof ev !== 'object') continue
      const absPath = typeof ev.path === 'string'
        ? ev.path.replace(/\\/g, '/')
        : ''
      // Primary path: file lives inside the repo by absolute path.
      if (absPath && (absPath === target || absPath.startsWith(targetPrefix))) {
        const repoRelative = absPath === target ? '' : absPath.slice(targetPrefix.length)
        // Spread carefully so we don't keep a stale pathNorm.
        out.push({ ...ev, pathNorm: repoRelative })
        continue
      }
      // Legacy fallback: pre-fix events whose pathNorm is already
      // repo-relative and whose cwd matches the repo. We keep them so
      // historical log replay shows the same heat as it did before.
      const cwd = typeof ev.cwd === 'string'
        ? ev.cwd.replace(/\\/g, '/').replace(/\/+$/, '')
        : ''
      const pathNorm = typeof ev.pathNorm === 'string' ? ev.pathNorm : ''
      if (cwd === target && pathNorm && !isAbsolutePathish(pathNorm)) {
        out.push(ev)
      }
    }
    return out
  }

  /** Force the store to point at today's file and load everything in it. */
  async loadInitial(now = new Date()) {
    this.currentFile = logFilePath(this.logDir, now)
    this.events = []
    this.lastSize = 0
    await this.#loadEntireCurrentFile()
  }

  /**
   * Sync the store with the disk file. Returns the array of *new* events
   * appended since the last sync (may be empty). Callers use the return
   * value to decide whether to broadcast an SSE update.
   */
  async tail(now = new Date()) {
    const expected = logFilePath(this.logDir, now)
    if (expected !== this.currentFile) {
      // Day rolled over — switch to the new file and reset.
      this.currentFile = expected
      this.events = []
      this.lastSize = 0
      return this.#loadEntireCurrentFile()
    }

    let stat
    try {
      stat = await fs.stat(this.currentFile)
    } catch (err) {
      if (err.code === 'ENOENT') return []
      throw err
    }

    if (stat.size < this.lastSize) {
      // File truncated/replaced — reload from scratch.
      this.events = []
      this.lastSize = 0
      return this.#loadEntireCurrentFile()
    }
    if (stat.size === this.lastSize) return []

    const newBytes = stat.size - this.lastSize
    const fh = await fs.open(this.currentFile, 'r')
    try {
      const buf = Buffer.alloc(newBytes)
      await fh.read(buf, 0, newBytes, this.lastSize)
      // rc9.15: consume only up to the last COMPLETE line. The hook (or the OS)
      // may have flushed a half-written final line; advancing past it would
      // make the next tail() start mid-line and silently drop that event. We
      // leave the trailing partial bytes unread so the next tail() re-reads
      // them once the newline arrives — never split, never lost, never duped.
      // '\n' is 0x0A, a byte that can't occur inside a UTF-8 multibyte
      // sequence, so locating it in the raw buffer is safe.
      const lastNl = buf.lastIndexOf(0x0a)
      if (lastNl === -1) return [] // no complete line yet — keep lastSize, wait
      const completeBytes = lastNl + 1
      this.lastSize += completeBytes
      const text = buf.subarray(0, completeBytes).toString('utf8')
      const lines = text.split('\n').filter((l) => l.length > 0)
      const fresh = []
      for (const line of lines) {
        const parsed = safeParse(line)
        if (parsed) fresh.push(parsed)
        else this.#noteCorruptLine()
      }
      this.events.push(...fresh)
      return fresh
    } finally {
      await fh.close()
    }
  }

  // ─── Historical multi-day API (rc7+) ──────────────────────────────────
  //
  // The methods below let callers query past days WITHOUT affecting the
  // live current-day tail/loadInitial path. The current-day live array
  // (`this.events`) is never written by these methods — they populate a
  // separate `this.historicalEvents` Map keyed by YYYY-MM-DD.
  //
  // Contract:
  //   - `from` and `to` accept Date or "YYYY-MM-DD" strings.
  //   - Range is inclusive on both ends, bounded by MAX_RANGE_DAYS.
  //   - Missing JSONL files inside the range = empty events for that day,
  //     not an error.
  //   - The current day, if included in the range, is read from the
  //     live `this.events` array (which the watcher keeps up to date)
  //     instead of re-reading the disk — avoids racing against tail().

  /**
   * Load events for every day in the [from, to] inclusive range. Days
   * already in `historicalEvents` are served from the cache; days
   * missing from the cache are read from disk and cached. Today (if
   * present in the range) always serves from the live `this.events`
   * array.
   *
   * @param {{ from: Date|string, to: Date|string }} range
   * @returns {Promise<Array<object>>} flattened, ts-sorted events
   * @throws {RangeError} if the range exceeds MAX_RANGE_DAYS or is invalid
   */
  async loadDays({ from, to } = {}) {
    const start = toUtcDayStart(from)
    const end = toUtcDayStart(to)
    if (!start || !end) {
      throw new RangeError('loadDays: invalid from/to (expect YYYY-MM-DD or Date)')
    }
    if (end < start) {
      throw new RangeError('loadDays: "to" must be on or after "from"')
    }
    const days = enumerateDays(start, end)
    if (days.length > MAX_RANGE_DAYS) {
      throw new RangeError(`loadDays: range spans ${days.length} days, exceeds cap of ${MAX_RANGE_DAYS}`)
    }

    const todayKey = dateKey(new Date())
    const out = []
    for (const key of days) {
      if (key === todayKey) {
        // Live day — serve from the actively-tailed array. Push a
        // shallow copy of each event so callers can't mutate the
        // live store by ref.
        out.push(...this.events)
        continue
      }
      let cached = this.historicalEvents.get(key)
      if (cached === undefined) {
        // logFilePath() expects a Date, so build the path directly
        // from the key string. join() handles path separators
        // cross-platform.
        const filePath = join(this.logDir, `session-${key}.jsonl`)
        cached = await this.#readJsonlFile(filePath)
        this.historicalEvents.set(key, cached)
      }
      out.push(...cached)
    }
    // Sort once at the end — within-day order is already correct
    // (append-only writes), but the day boundary needs a global sort to
    // handle clock skew across days.
    out.sort((a, b) => {
      const ta = Date.parse(a?.ts ?? '')
      const tb = Date.parse(b?.ts ?? '')
      return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0)
    })
    return out
  }

  /**
   * Sync wrapper that returns whatever's already in the historical
   * cache for the given range plus the live current-day slice. Does
   * NOT touch disk — callers must have already awaited loadDays() at
   * least once for the days they want. Mirror of `getEvents()`.
   *
   * @param {{ from: Date|string, to: Date|string }} range
   * @returns {Array<object>} flattened, ts-sorted events
   */
  getEventsInRange({ from, to } = {}) {
    const start = toUtcDayStart(from)
    const end = toUtcDayStart(to)
    if (!start || !end || end < start) return []
    const days = enumerateDays(start, end)
    const todayKey = dateKey(new Date())
    const out = []
    for (const key of days) {
      if (key === todayKey) {
        out.push(...this.events)
        continue
      }
      const cached = this.historicalEvents.get(key)
      if (cached) out.push(...cached)
    }
    out.sort((a, b) => {
      const ta = Date.parse(a?.ts ?? '')
      const tb = Date.parse(b?.ts ?? '')
      return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0)
    })
    return out
  }

  /**
   * Repo-filtered version of getEventsInRange. Combines the per-repo
   * filtering logic from getEventsForRepo() with the historical range
   * lookup. Returns a NEW array — safe to mutate.
   *
   * @param {string} repoPath
   * @param {{ from: Date|string, to: Date|string }} range
   * @returns {Array<object>} events scoped to the repo + range
   */
  getEventsForRepoInRange(repoPath, { from, to } = {}) {
    if (typeof repoPath !== 'string' || !repoPath) return []
    const target = normalizeRepoPath(repoPath)
    if (!target) return []
    const targetPrefix = target + '/'
    const everything = this.getEventsInRange({ from, to })
    const out = []
    for (const ev of everything) {
      if (!ev || typeof ev !== 'object') continue
      const absPath = typeof ev.path === 'string' ? ev.path.replace(/\\/g, '/') : ''
      if (absPath && (absPath === target || absPath.startsWith(targetPrefix))) {
        const repoRelative = absPath === target ? '' : absPath.slice(targetPrefix.length)
        out.push({ ...ev, pathNorm: repoRelative })
        continue
      }
      // Legacy fallback mirrors getEventsForRepo(): pre-fix events
      // whose pathNorm is already repo-relative and cwd matches.
      const cwd = typeof ev.cwd === 'string'
        ? ev.cwd.replace(/\\/g, '/').replace(/\/+$/, '')
        : ''
      const pathNorm = typeof ev.pathNorm === 'string' ? ev.pathNorm : ''
      if (cwd === target && pathNorm && !isAbsolutePathish(pathNorm)) {
        out.push(ev)
      }
    }
    return out
  }

  /**
   * Enumerate every day with a session-*.jsonl on disk under logDir.
   * Used by the MCP `list_days_with_activity` tool and by the UI's
   * date-range picker to know which dates have data behind them.
   *
   * Returns at most MAX_RANGE_DAYS most-recent entries, sorted desc.
   * Does NOT populate the cache — purely a filename scan.
   *
   * @returns {Promise<Array<{ date: string, sizeBytes: number }>>}
   */
  async listDaysWithActivity() {
    let entries
    try {
      entries = await fs.readdir(this.logDir, { withFileTypes: true })
    } catch (err) {
      if (err.code === 'ENOENT') return []
      throw err
    }
    const re = /^session-(\d{4}-\d{2}-\d{2})\.jsonl$/
    const out = []
    for (const e of entries) {
      if (!e.isFile()) continue
      const m = re.exec(e.name)
      if (!m) continue
      try {
        const stat = await fs.stat(join(this.logDir, e.name))
        out.push({ date: m[1], sizeBytes: stat.size })
      } catch {
        // Race with rotation/cleanup — skip silently.
      }
    }
    out.sort((a, b) => (a.date < b.date ? 1 : -1))
    return out.slice(0, MAX_RANGE_DAYS)
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  /**
   * Record that a corrupt (non-empty, unparseable, or non-object) JSONL line
   * was skipped. Throttled: warn on the first occurrence and then once every
   * 100, so a flood of garbage from a misbehaving agent is observable but
   * never drowns the log (and never blocks the tail/SSE path — this is fire
   * and forget). rc9.15.
   */
  #noteCorruptLine() {
    this.corruptLineCount += 1
    if (this.corruptLineCount === 1 || this.corruptLineCount % 100 === 0) {
      this.logger.warn(
        { corruptLines: this.corruptLineCount, logDir: this.logDir },
        'BlastRadius eventStore skipped a corrupt JSONL line',
      )
    }
  }

  /** Read the entire current file via streaming readline. Resilient to
   *  arbitrarily large files because we never load the whole buffer at
   *  once. Returns the array of events read AND mutates `this.events`
   *  for the live tail path. */
  async #loadEntireCurrentFile() {
    if (!this.currentFile) return []
    const collected = await this.#readJsonlFile(this.currentFile, true)
    this.events.push(...collected)
    return collected
  }

  /**
   * Stream-read one JSONL file and return its parsed events. Shared
   * between the live-tail path and the historical loader so both
   * follow identical parse rules (skip blank lines, skip malformed
   * lines silently — same as before).
   *
   * @param {string} filePath  absolute path to the .jsonl
   * @param {boolean} updateLastSize  when true (live path), captures
   *        the file size in `this.lastSize` so subsequent tail() calls
   *        seek from there. Historical reads pass false.
   * @returns {Promise<Array<object>>}
   */
  async #readJsonlFile(filePath, updateLastSize = false) {
    let exists = true
    try {
      const stat = await fs.stat(filePath)
      if (updateLastSize) this.lastSize = stat.size
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      exists = false
    }
    if (!exists) return []

    return new Promise((resolve, reject) => {
      const stream = createReadStream(filePath, { encoding: 'utf8' })
      const rl = createInterface({ input: stream, crlfDelay: Infinity })
      const collected = []
      rl.on('line', (line) => {
        if (!line) return
        const parsed = safeParse(line)
        if (parsed) collected.push(parsed)
        else this.#noteCorruptLine()
      })
      rl.on('close', () => resolve(collected))
      rl.on('error', reject)
      stream.on('error', reject)
    })
  }
}

function safeParse(line) {
  try {
    const v = JSON.parse(line)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}
