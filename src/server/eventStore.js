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

export class EventStore {
  /**
   * @param {string} logDir Directory holding daily session-YYYY-MM-DD.jsonl files.
   */
  constructor(logDir) {
    if (!logDir || typeof logDir !== 'string') {
      throw new Error('EventStore: logDir is required')
    }
    this.logDir = logDir
    /** @type {Array<object>} */
    this.events = []
    /** Absolute path of the file we're currently tailing. */
    this.currentFile = null
    /** Last byte offset we read up to in currentFile. */
    this.lastSize = 0
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
      this.lastSize = stat.size
      const text = buf.toString('utf8')
      const lines = text.split('\n').filter((l) => l.length > 0)
      const fresh = []
      for (const line of lines) {
        const parsed = safeParse(line)
        if (parsed) fresh.push(parsed)
      }
      this.events.push(...fresh)
      return fresh
    } finally {
      await fh.close()
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  /** Read the entire current file via streaming readline. Resilient to
   *  arbitrarily large files because we never load the whole buffer at
   *  once. Returns the array of events read. */
  async #loadEntireCurrentFile() {
    if (!this.currentFile) return []
    let exists = true
    try {
      const stat = await fs.stat(this.currentFile)
      this.lastSize = stat.size
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      exists = false
    }
    if (!exists) return []

    return new Promise((resolve, reject) => {
      const stream = createReadStream(this.currentFile, { encoding: 'utf8' })
      const rl = createInterface({ input: stream, crlfDelay: Infinity })
      const collected = []
      rl.on('line', (line) => {
        if (!line) return
        const parsed = safeParse(line)
        if (parsed) collected.push(parsed)
      })
      rl.on('close', () => {
        this.events.push(...collected)
        resolve(collected)
      })
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
