/**
 * BlastRadius MCP usage counter (singleton, in-memory).
 *
 * Tracks how many MCP requests have been handled since boot, broken
 * down by JSON-RPC method (tools/call, resources/read, others) and
 * by tool / resource name. Drives the live-update panel in the
 * dashboard and the GET /api/mcp/stats endpoint.
 *
 * Design constraints
 * ──────────────────
 *
 *   - In-memory only. Iteration counts are session-scoped and reset
 *     on every BlastRadius restart; this matches the iterationMarker
 *     contract and avoids touching disk on every MCP call (which on
 *     a chatty agent could easily be 5–30 writes per second).
 *
 *   - Defensive. The recorder is wrapped in try/catch at every call
 *     site in transport-http.js — counter failures must NEVER break
 *     an MCP request. The dashboard is observability for the
 *     observable, not a load-bearing part of the protocol.
 *
 *   - SSE-debounced. The bridge that broadcasts 'mcp-stats-update'
 *     to connected dashboards coalesces bursts within a 500 ms
 *     window to avoid flooding the SSE channel during heavy agent
 *     polling.
 *
 *   - Pure data, no side effects on read. `getStats()` is safe to
 *     call from any context.
 */

/** Singleton state — module-level so every importer sees the same counters. */
const state = {
  startedAt: new Date(),
  totals: { tools: 0, resources: 0, other: 0, total: 0 },
  /** Map<string, number> — key is `tool:<name>` or `resource:<uri>` */
  byName: new Map(),
  /** Map<string, number> — clientInfo.name from `initialize` calls */
  byClient: new Map(),
  /** Timestamp of the most recent request, ISO string */
  lastRequestAt: null,
}

/** SSE coalescing — buffer recent increments and flush at most every 500ms. */
const SSE_DEBOUNCE_MS = 500
let pendingFlush = null
let onFlush = null

/**
 * Subscribe to debounced stats updates. The handler receives the
 * full stats snapshot. Returns an unsubscribe function.
 */
export function onStatsUpdate(handler) {
  onFlush = handler
  return () => {
    if (onFlush === handler) onFlush = null
  }
}

function scheduleFlush() {
  if (pendingFlush || !onFlush) return
  pendingFlush = setTimeout(() => {
    pendingFlush = null
    try {
      onFlush?.(getStats())
    } catch {
      // SSE broadcast must never throw back into the recorder path.
    }
  }, SSE_DEBOUNCE_MS)
  pendingFlush.unref?.()
}

/**
 * Record one MCP request. The transport calls this AFTER the body
 * has been parsed by express.json, with the JSON-RPC method and an
 * optional name (tool name, resource URI, or client name).
 *
 * Wrapped in defensive try/catch at the call site — if anything in
 * this function throws, the MCP request still completes.
 */
export function recordCall({ method, name, clientName } = {}) {
  state.totals.total += 1
  state.lastRequestAt = new Date().toISOString()
  if (method === 'tools/call' && name) {
    state.totals.tools += 1
    bump(`tool:${name}`)
  } else if (method === 'resources/read' && name) {
    state.totals.resources += 1
    bump(`resource:${name}`)
  } else {
    state.totals.other += 1
    if (method) bump(`method:${method}`)
  }
  if (clientName) {
    state.byClient.set(clientName, (state.byClient.get(clientName) ?? 0) + 1)
  }
  scheduleFlush()
}

function bump(key) {
  state.byName.set(key, (state.byName.get(key) ?? 0) + 1)
}

/** Snapshot of the current counters — safe to JSON.stringify directly. */
export function getStats() {
  // Sort by count desc for deterministic, useful UI ordering.
  const byName = [...state.byName.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
  const byClient = [...state.byClient.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
  return {
    startedAt: state.startedAt.toISOString(),
    lastRequestAt: state.lastRequestAt,
    totals: { ...state.totals },
    byName,
    byClient,
  }
}

/** Test-only reset hook. Not exported to production callers. */
export function _resetForTests() {
  state.startedAt = new Date()
  state.totals = { tools: 0, resources: 0, other: 0, total: 0 }
  state.byName.clear()
  state.byClient.clear()
  state.lastRequestAt = null
  if (pendingFlush) {
    clearTimeout(pendingFlush)
    pendingFlush = null
  }
  onFlush = null
}
