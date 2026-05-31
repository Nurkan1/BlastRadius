/**
 * BlastRadius MCP HTTP transport — Phase 1.
 *
 * Mounts the MCP server on the existing Express app at /mcp using
 * the SDK's StreamableHTTPServerTransport in **stateless mode**
 * (sessionIdGenerator: undefined). Stateless is intentional for
 * Phase 1:
 *
 *   - Each request gets a fresh transport bound to a freshly-created
 *     McpServer instance. No cross-request state to leak.
 *   - Matches the "Initialize → tools/call" loop most MCP clients
 *     issue today, including Claude Code's HTTP transport and
 *     Antigravity 2.0.
 *   - Eliminates the failure mode where a previous session ID gets
 *     stuck and locks out fresh clients until restart.
 *
 * Rate limiting (refinement #2): we mount a token-bucket separate
 * from /api/diff's limiter, sized for AI agent traffic:
 *   - 100 token burst (vs 30 on /api/diff)
 *   - 30/sec sustained refill (vs 12/sec on /api/diff)
 *   - 429 with Retry-After and a clear `error: 'rate_limited'` body
 *
 * Agents poll more aggressively than humans (they re-query on every
 * model turn during long tasks), so the budget is ~3× the human
 * dashboard's. Still bounded — a runaway agent gets cut off in well
 * under a second of pathological retrying.
 *
 * Express integration:
 *   - Uses `express.Router()` so callers mount us with `app.use(...)`.
 *   - Re-uses the host app's `express.json()` body parser via
 *     `req.body` (the SDK transport accepts a pre-parsed body to
 *     avoid double-reading the request stream).
 *   - Security headers from `securityHeaders()` still apply because
 *     they were attached at the app level before our router runs.
 *     The pre-check (Phase 0 of this work) confirmed they don't
 *     interfere with JSON-RPC POST.
 */

import { Router } from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { makeRateLimiter } from '../server/security.js'
import { createMcpServer } from './server.js'
import { recordCall } from './stats.js'

/**
 * Build the Express router that serves the MCP transport at /mcp.
 *
 * @param {object} deps Same dependency object as createMcpServer + a logger.
 */
/**
 * Extract the counter signal from a single JSON-RPC message body.
 *
 * Mapping:
 *   - `tools/call`     → name = body.params.name           (tool name)
 *   - `resources/read` → name = body.params.uri            (resource URI)
 *   - `initialize`     → clientName = body.params.clientInfo.name
 *
 * `userAgent` (the HTTP User-Agent header of the incoming request)
 * is forwarded to recordCall so that every subsequent call — which
 * does NOT carry clientInfo per MCP spec — still gets attributed to
 * the originating agent via a UA fingerprint. Without this, the
 * per-client breakdown would only reflect handshake counts, not
 * actual workload.
 */
function recordFromBody(body, userAgent) {
  if (!body || typeof body !== 'object') return
  const method = typeof body.method === 'string' ? body.method : null
  if (!method) return
  let name
  let clientName
  if (method === 'tools/call' && body.params?.name) {
    name = String(body.params.name)
  } else if (method === 'resources/read' && body.params?.uri) {
    name = String(body.params.uri)
  } else if (method === 'initialize') {
    const ci = body.params?.clientInfo
    if (ci && typeof ci.name === 'string') clientName = ci.name
  }
  recordCall({ method, name, clientName, userAgent })
}

/** rc9.20: the live MCP token-bucket limiter, captured at router-mount time so
 *  the system dashboard's health endpoint can report its state. */
let _mcpRateLimit = null

/** Read-only snapshot of the MCP rate limiter, or null if not mounted yet. */
export function mcpRateLimitSnapshot() {
  try {
    return _mcpRateLimit?.snapshot?.() ?? null
  } catch {
    return null
  }
}

export function makeMcpRouter(deps) {
  const router = Router()
  const logger = deps.logger ?? { debug() {}, info() {}, warn() {} }

  // Dedicated rate limiter for /mcp. Generous to accommodate agent
  // polling but still bounded against runaway loops.
  const mcpRateLimit = makeRateLimiter({
    maxTokens: 100,
    refillTokens: 30,
    refillIntervalMs: 1_000,
    onRateLimit: (req) => {
      logger.warn(
        { ip: req.ip || req.socket?.remoteAddress },
        'mcp rate-limited',
      )
    },
  })
  // rc9.20: expose this limiter to the system dashboard's health endpoint.
  // Single MCP router per process, so a module-level reference is fine.
  _mcpRateLimit = mcpRateLimit

  // Log once that the MCP module is wired up — useful for boot
  // diagnostics. Per-request servers below stay quiet.
  logger.info(
    { name: 'blastradius', version: deps.appVersion || '0.0.0' },
    'mcp transport mounted at /mcp',
  )

  /**
   * Stateless handler — creates a fresh `McpServer` AND a fresh
   * transport per request, then tears both down when the response
   * closes.
   *
   * Why per-request: the SDK's `Protocol` base class (which McpServer
   * extends) enforces a single active transport per instance. Sharing
   * one McpServer across overlapping requests yields the runtime
   * error "Already connected to a transport." This pattern matches
   * the official SDK example for `sessionIdGenerator: undefined`
   * (stateless) mode and lets us serve concurrent MCP clients
   * without contention.
   *
   * Cost: building an McpServer means re-running the synchronous
   * `registerTool` / `registerResource` calls in server.js. Zod
   * schemas are constructed at module load, so the per-request work
   * is just hash-map insertions — well under 1 ms in practice. The
   * eventStore / iterationMarker / preferences references are
   * passed by closure, so no state is duplicated.
   */
  async function handle(req, res) {
    let transport
    let mcpServer
    // Counter instrumentation — increment BEFORE invoking the SDK
    // transport so the stats panel reflects in-flight calls. Defensive
    // try/catch: a counter failure must NEVER break the MCP request
    // (e.g. malformed body, missing `params`, downstream Map error).
    try {
      const body = req.body
      const ua = req.headers?.['user-agent']
      if (body && typeof body === 'object') {
        if (Array.isArray(body)) {
          // JSON-RPC batch — record each member separately.
          for (const item of body) recordFromBody(item, ua)
        } else {
          recordFromBody(body, ua)
        }
      }
    } catch {
      // Swallow — never let counter logic surface as an MCP error.
    }

    try {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        // The MCP SDK auto-detects whether the client wants JSON
        // batch or SSE streaming via Accept headers — no extra
        // config needed here.
      })
      mcpServer = createMcpServer(deps)

      // Make sure both ends tear down if the client hangs up
      // mid-stream (Claude Code / Antigravity sometimes drop the
      // connection between turns). Without this, a long SSE stream
      // could keep handlers open after the client is gone.
      res.on('close', () => {
        try { transport.close() } catch { /* best effort */ }
        try { mcpServer.close?.() } catch { /* best effort */ }
      })

      await mcpServer.connect(transport)
      // Pass the pre-parsed body so we don't re-read the stream
      // (express.json already consumed it).
      await transport.handleRequest(req, res, req.body)
    } catch (err) {
      logger.warn({ err: String(err?.message ?? err) }, 'mcp request failed')
      // Only send a response if headers haven't been sent yet — the
      // transport may have already streamed something to the client.
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'internal_error' },
          id: null,
        })
      }
      try { transport?.close() } catch { /* best effort */ }
      try { mcpServer?.close?.() } catch { /* best effort */ }
    }
  }

  // Streamable HTTP uses POST for client→server requests and GET
  // for server-initiated SSE streams. The SDK handles both verbs;
  // we mount the same handler on both.
  router.post('/mcp', mcpRateLimit, handle)
  router.get('/mcp', mcpRateLimit, handle)
  // The DELETE endpoint terminates a session; in stateless mode
  // there is nothing to delete, so the SDK responds with a no-op.
  router.delete('/mcp', mcpRateLimit, handle)

  return router
}
