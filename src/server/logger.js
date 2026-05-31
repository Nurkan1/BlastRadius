/**
 * Structured logger (rc9.20) — meta-observability pipeline.
 *
 * BlastRadius's own system logs travel a pipeline that is COMPLETELY SEPARATE
 * from the repos' touch-event capture (eventStore.js / session-*.jsonl). This
 * module builds a pino logger with a `multistream` fan-out:
 *
 *   1. stdout            — the launcher / terminal view (unchanged behaviour).
 *   2. ~/.blastradius/system.log — an ASYNC file sink (`sync: false`, sonic-boom
 *      buffered) so writing a log line never blocks the request path and the
 *      hook's <100 ms budget is untouched.
 *   3. a tiny in-process "live tap" — keeps a bounded ring of recent entries
 *      and, once a broadcaster is registered, pushes each new entry to the
 *      System dashboard over SSE. Failures in the tap can NEVER break logging.
 *
 * Isolation guarantees:
 *   - Only ~/.blastradius/ is written (system.log lives next to logs/).
 *   - The repos' JSONL capture path is not imported or touched here.
 *   - The tap + broadcaster are wrapped in try/catch; a slow or throwing
 *     consumer degrades to a dropped line, never a stalled logger.
 */

import pino from 'pino'
import { mkdirSync, statSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

const RING_MAX = 500
// Boot-time single rotation: if the system log has grown past this, roll it to
// `<file>.1` so it can't grow unbounded across months of use.
const ROTATE_BYTES = 10 * 1024 * 1024

/** Best-effort one-shot rotation of an oversized system log on boot. */
function rotateIfLarge(path) {
  try {
    const st = statSync(path)
    if (st.size > ROTATE_BYTES) renameSync(path, `${path}.1`)
  } catch { /* missing file or rename race — ignore */ }
}

/**
 * Build the application logger.
 *
 * @param {{ level?: string, systemLogPath?: string|null }} [opts]
 * @returns {import('pino').Logger & {
 *   onSystemLog: (fn: ((entry: object) => void)|null) => void,
 *   getRecentSystemLogs: (n?: number) => object[],
 *   systemLogPath: string|null,
 * }}
 */
export function createLogger({ level = 'info', systemLogPath = null } = {}) {
  const ring = []
  let broadcaster = null
  let fileStream = null

  const streams = [{ level, stream: process.stdout }]

  if (systemLogPath) {
    rotateIfLarge(systemLogPath)
    try {
      mkdirSync(dirname(systemLogPath), { recursive: true })
      fileStream = pino.destination({ dest: systemLogPath, sync: false, mkdir: true })
      streams.push({ level, stream: fileStream })
    } catch {
      // File logging is best-effort; never let it block boot. stdout + the
      // live tap still work.
    }

    // Live tap — parse each emitted line (our own JSON), keep a ring, and
    // forward to the broadcaster if one is registered.
    const liveTap = {
      write(chunk) {
        const text = typeof chunk === 'string' ? chunk : String(chunk)
        let start = 0
        for (let i = 0; i < text.length; i += 1) {
          if (text[i] !== '\n') continue
          pushLine(text.slice(start, i))
          start = i + 1
        }
        if (start < text.length) pushLine(text.slice(start))
      },
    }
    streams.push({ level, stream: liveTap })

    function pushLine(line) {
      if (!line) return
      let entry
      try { entry = JSON.parse(line) } catch { return } // our own output; skip anything odd
      if (!entry || typeof entry !== 'object') return
      ring.push(entry)
      if (ring.length > RING_MAX) ring.shift()
      if (broadcaster) {
        try { broadcaster(entry) } catch { /* a consumer must never break logging */ }
      }
    }
  }

  const logger = pino({ level, base: { name: 'blastradius' } }, pino.multistream(streams))

  /** Register (or clear with null) the live SSE broadcaster. */
  logger.onSystemLog = (fn) => { broadcaster = typeof fn === 'function' ? fn : null }

  /** Most-recent N entries from the in-process ring (newest last). */
  logger.getRecentSystemLogs = (n = 200) => {
    const count = Math.max(0, Math.min(Number(n) || 0, ring.length))
    return ring.slice(ring.length - count)
  }

  /** Flush + close the async file sink (graceful shutdown / test cleanup).
   *  Best-effort; safe to call more than once. */
  logger.closeSystemLog = () => {
    try { fileStream?.flushSync?.() } catch { /* */ }
    try { fileStream?.end?.() } catch { /* */ }
    fileStream = null
  }

  logger.systemLogPath = systemLogPath || null
  return logger
}
