/**
 * System meta-observability router (rc9.20) — ISOLATED.
 *
 * BlastRadius observing itself. These endpoints are a separate channel from
 * the repos' event capture (eventStore.js) — they only read this process's own
 * system log + runtime metrics. Nothing here touches the JSONL capture path,
 * the polyglot resolvers, or atomic-write stores.
 *
 *   GET /api/system/logs?limit=N  — last N structured log lines (file tail,
 *                                   ring-buffer fallback). Malformed lines are
 *                                   skipped with a throttled warning.
 *   GET /api/system/health        — process memory, uptime, MCP per-tool stats,
 *                                   and the MCP rate-limiter (token-bucket) state.
 *
 * Realtime tailing is delivered on the EXISTING /api/events SSE channel as a
 * dedicated `system-log` event (wired in index.js via logger.onSystemLog), so
 * the dashboard never opens a second EventSource.
 *
 * @param {{
 *   logger: { systemLogPath: string|null, getRecentSystemLogs: (n:number)=>object[], warn: Function },
 *   getMcpStats: () => object,
 *   getMcpRateLimit: () => object|null,
 *   startedAtMs: number,
 * }} deps
 */

import { Router } from 'express'
import { promises as fs } from 'node:fs'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

export function makeSystemRouter({ logger, getMcpStats, getMcpRateLimit, startedAtMs } = {}) {
  const router = Router()
  const log = logger ?? { systemLogPath: null, getRecentSystemLogs: () => [], warn() {} }

  // Throttled corrupt-line counter (same discipline as eventStore): the system
  // log is our own JSON, so a malformed line is rare (a torn async flush) —
  // skip it, count it, warn occasionally, never throw.
  let corruptLines = 0
  const noteCorrupt = () => {
    corruptLines += 1
    if (corruptLines === 1 || corruptLines % 100 === 0) {
      try { log.warn?.({ corruptLines }, 'system-log: skipped a malformed line') } catch { /* never throw */ }
    }
  }

  function parseTail(text, limit) {
    const lines = text.split('\n')
    const out = []
    // Walk from the end so we keep the most-recent `limit` valid entries.
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const line = lines[i]
      if (!line) continue
      let entry
      try { entry = JSON.parse(line) } catch { noteCorrupt(); continue }
      if (entry && typeof entry === 'object') out.push(entry)
      else noteCorrupt()
    }
    out.reverse() // chronological (newest last), matching the live stream
    return out
  }

  router.get('/api/system/logs', async (req, res) => {
    const raw = Number(req.query.limit)
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_LIMIT) : DEFAULT_LIMIT
    const path = log.systemLogPath
    if (path) {
      try {
        const text = await fs.readFile(path, 'utf8')
        return res.json({ source: 'file', entries: parseTail(text, limit) })
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          try { log.warn?.({ err: String(err?.message ?? err) }, 'system-log read failed') } catch { /* */ }
        }
        // Fall through to the ring buffer (e.g. file not created yet).
      }
    }
    const ring = log.getRecentSystemLogs?.(limit) ?? []
    res.json({ source: 'ring', entries: ring.slice(-limit) })
  })

  router.get('/api/system/health', (req, res) => {
    const mem = process.memoryUsage()
    res.json({
      ok: true,
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
      uptimeSec: Math.round(process.uptime()),
      startedAtMs: startedAtMs ?? null,
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
      },
      mcp: safeCall(getMcpStats),
      mcpRateLimiter: safeCall(getMcpRateLimit),
    })
  })

  return router
}

/** Call a dep getter defensively — a metrics source must never 500 the panel. */
function safeCall(fn) {
  try { return typeof fn === 'function' ? fn() : null } catch { return null }
}
