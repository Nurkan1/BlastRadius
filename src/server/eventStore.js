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
   * Filter events to those whose `cwd` matches `repoPath` exactly
   * (after forward-slash normalization). Returns a NEW array — safe
   * to mutate / consume.
   *
   * Phase 5: each repo gets its own per-repo heat slice from the shared
   * day's log. Events whose cwd doesn't match any known repo (deleted
   * repos, sub-checkouts, etc.) are silently excluded.
   */
  getEventsForRepo(repoPath) {
    if (typeof repoPath !== 'string' || repoPath.length === 0) return []
    const target = repoPath.replace(/\\/g, '/').replace(/\/+$/, '')
    const out = []
    for (const ev of this.events) {
      if (!ev || typeof ev !== 'object') continue
      const cwd = typeof ev.cwd === 'string'
        ? ev.cwd.replace(/\\/g, '/').replace(/\/+$/, '')
        : ''
      if (cwd === target) out.push(ev)
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
