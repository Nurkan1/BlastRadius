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

/**
 * Memory caps. Each Map will not grow past this many distinct keys —
 * once at cap, recordCall still bumps EXISTING keys but stops creating
 * new ones. Defends against a hostile client sending unique tool /
 * resource / client names to inflate dashboard memory. The current
 * cap fits comfortably in <100 KB per Map (the longest realistic key
 * is a resource URI under ~120 bytes).
 *
 * 200 distinct keys is far above any plausible legitimate use:
 *  - 4 tools + 6 resources + 1 method (initialize) = 11 keys in
 *    steady state.
 *  - Even a fleet of dozens of agents won't exceed 30 distinct
 *    clientInfo.name values.
 *
 * Exported for tests; tweak with care.
 */
export const MAX_DISTINCT_KEYS = 200

/**
 * Per-key count ceiling. Defends against integer drift if the dashboard
 * runs for years with the same hot key. Number.MAX_SAFE_INTEGER is the
 * formal limit; we cap an order of magnitude below that so the JSON
 * remains pretty-printable.
 */
const MAX_COUNT_PER_KEY = 1_000_000_000 // 1B requests on a single key — practically unreachable

/** Singleton state — module-level so every importer sees the same counters. */
const state = {
  startedAt: new Date(),
  totals: { tools: 0, resources: 0, other: 0, total: 0 },
  /** Map<string, number> — key is `tool:<name>` or `resource:<uri>` */
  byName: new Map(),
  /** Map<string, number> — clientInfo.name OR derived from User-Agent. */
  byClient: new Map(),
  /** Per-tool/resource per-client cross-tab. Map<clientName, Map<key, count>>.
   *  Bounded by MAX_DISTINCT_KEYS on each axis to keep memory finite. */
  byClientByName: new Map(),
  /** Timestamp of the most recent request, ISO string */
  lastRequestAt: null,
  /** Aggregate count of recordCall invocations that were dropped by
   *  the memory cap. Surfaced in /api/mcp/stats so the dashboard can
   *  flag "your byName breakdown is incomplete because we hit the
   *  cap". This is the canary for either heavy legitimate traffic or
   *  a unique-name DoS attempt. */
  droppedKeys: { byName: 0, byClient: 0 },
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
 * Best-effort User-Agent → clean client name mapping. The MCP spec
 * only carries `clientInfo.name` on the `initialize` call, so every
 * subsequent `tools/call` and `resources/read` would otherwise be
 * unattributable. We use the HTTP User-Agent header as a fallback
 * fingerprint so the per-client breakdown reflects ACTUAL workload,
 * not just handshake counts.
 *
 * Pattern matching is intentional and conservative — if the UA does
 * not match a known prefix, we surface a redacted "other / <vendor>"
 * label rather than persisting the raw UA (which can be long, may
 * contain version churn, and on rare occasions leaks deployment
 * details about the agent's host).
 */
function deriveClientFromUA(userAgent) {
  if (!userAgent || typeof userAgent !== 'string') return null
  const ua = userAgent.toLowerCase()
  // Known agents (order matters — more specific patterns first).
  if (ua.includes('claude-ai')) return 'claude-ai'
  if (ua.includes('claude-code') || ua.includes('claudecode')) return 'claude-code'
  if (ua.includes('claude') && ua.includes('desktop')) return 'claude-desktop'
  if (ua.includes('antigravity') || ua.includes('gemini')) return 'antigravity'
  if (ua.includes('modelcontextprotocol')) return 'mcp-sdk-client'
  // Node's default fetch UA is "node" — surfaces custom Node-based
  // clients without leaking version.
  if (ua.startsWith('node')) return 'node-client'
  if (ua.startsWith('curl/') || ua.startsWith('powershell')) return 'manual-cli'
  return 'unknown'
}

/**
 * Record one MCP request. The transport calls this AFTER the body
 * has been parsed by express.json, with the JSON-RPC method and an
 * optional name (tool name, resource URI). `clientName` comes from
 * `initialize.params.clientInfo.name` when available; `userAgent` is
 * the HTTP User-Agent header used as a fallback fingerprint for
 * subsequent calls that don't carry clientInfo.
 *
 * Resolution order for the client identity:
 *   1. Explicit `clientName` (only present on `initialize` calls).
 *   2. UA-derived fallback for known vendors (claude-ai, antigravity,
 *      claude-desktop, claude-code, mcp-sdk-client, node-client,
 *      manual-cli, unknown).
 *   3. If neither is available, the request is still counted in the
 *      method / byName totals but NOT in byClient. This keeps the
 *      per-client breakdown clean — only attributable traffic shows.
 *
 * Wrapped in defensive try/catch at the call site — if anything in
 * this function throws, the MCP request still completes.
 */
export function recordCall({ method, name, clientName, userAgent } = {}) {
  state.totals.total += 1
  state.lastRequestAt = new Date().toISOString()

  let key = null
  if (method === 'tools/call' && name) {
    state.totals.tools += 1
    key = `tool:${name}`
  } else if (method === 'resources/read' && name) {
    state.totals.resources += 1
    key = `resource:${name}`
  } else {
    state.totals.other += 1
    if (method) key = `method:${method}`
  }
  if (key) bump(state.byName, key, 'byName')

  // Per-client attribution — derive from UA when clientInfo wasn't
  // sent (i.e. every request except initialize).
  const resolvedClient = clientName || deriveClientFromUA(userAgent)
  if (resolvedClient) {
    bump(state.byClient, resolvedClient, 'byClient')
    // Cross-tab: count per (client, key) so the dashboard can answer
    // "how many times did claude-ai vs antigravity call get_iteration_
    // summary?". Cross-tab caps follow the same MAX_DISTINCT_KEYS
    // rule on each axis.
    if (key) {
      let sub = state.byClientByName.get(resolvedClient)
      if (!sub) {
        if (state.byClientByName.size < MAX_DISTINCT_KEYS) {
          sub = new Map()
          state.byClientByName.set(resolvedClient, sub)
        }
      }
      if (sub) bump(sub, key, 'byName') // counted under byName's cap policy
    }
  }

  scheduleFlush()
}

/** Bounded-Map bump. New keys only created while size < cap. Existing
 *  keys always increment (capped at MAX_COUNT_PER_KEY against drift).
 *  Records into state.droppedKeys when the cap rejects a new key. */
function bump(map, key, capBucket) {
  if (map.has(key)) {
    const cur = map.get(key)
    if (cur < MAX_COUNT_PER_KEY) map.set(key, cur + 1)
    return
  }
  if (map.size >= MAX_DISTINCT_KEYS) {
    if (capBucket && state.droppedKeys[capBucket] !== undefined) {
      state.droppedKeys[capBucket] += 1
    }
    return
  }
  map.set(key, 1)
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
  // byClientByName: array of { client, breakdown: [{key, count}, …] }.
  // Lets the dashboard answer "which agent called which tool how often".
  const byClientByName = [...state.byClientByName.entries()].map(([client, sub]) => ({
    client,
    breakdown: [...sub.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count),
  })).sort((a, b) => {
    const totalA = a.breakdown.reduce((s, e) => s + e.count, 0)
    const totalB = b.breakdown.reduce((s, e) => s + e.count, 0)
    return totalB - totalA
  })
  return {
    startedAt: state.startedAt.toISOString(),
    lastRequestAt: state.lastRequestAt,
    totals: { ...state.totals },
    byName,
    byClient,
    byClientByName,
    droppedKeys: { ...state.droppedKeys },
    caps: { maxDistinctKeys: MAX_DISTINCT_KEYS },
  }
}

/** Test-only reset hook. Not exported to production callers. */
export function _resetForTests() {
  state.startedAt = new Date()
  state.totals = { tools: 0, resources: 0, other: 0, total: 0 }
  state.byName.clear()
  state.byClient.clear()
  state.byClientByName.clear()
  state.droppedKeys = { byName: 0, byClient: 0 }
  state.lastRequestAt = null
  if (pendingFlush) {
    clearTimeout(pendingFlush)
    pendingFlush = null
  }
  onFlush = null
}
