#!/usr/bin/env node
/**
 * BlastRadius MCP stdio shim.
 *
 * A thin JSON-RPC proxy: speaks stdio (NDJSON) to a stdio-only MCP
 * client (Claude Desktop, older Antigravity, niche tooling) and
 * forwards every message as an HTTP POST to the BlastRadius
 * dashboard's `/mcp` endpoint. The actual MCP server lives inside
 * BlastRadius — this script is just plumbing.
 *
 * Why a shim and not a second McpServer:
 *   - Zero risk of the two surfaces drifting (no duplicated tool /
 *     resource handlers).
 *   - The dashboard's existing per-request rate limit, security
 *     headers, and event-store reads stay in one place.
 *   - Plain JSON-RPC tunneling is ~50 LOC and never needs the SDK.
 *
 * Wire protocol:
 *   stdin  — newline-delimited JSON-RPC messages, one per line
 *            (matches @modelcontextprotocol/sdk's StdioTransport).
 *   stdout — one JSON-RPC response per line.
 *   stderr — diagnostics ONLY (never a JSON-RPC frame; clients that
 *            also slurp stderr would otherwise misparse it).
 *
 * Transport upstream:
 *   POST $MCP_URL (default http://localhost:7842/mcp)
 *   Content-Type: application/json
 *   Accept:       application/json, text/event-stream
 *
 *   BlastRadius's StreamableHTTPServerTransport always responds with
 *   SSE-framed events (`event: message\ndata: <json>\n\n`) even
 *   when there is exactly one. We extract every `data:` payload and
 *   forward each as its own NDJSON line. JSON-RPC ids preserve
 *   ordering on the client side, so async race-conditions across
 *   in-flight requests are safe.
 *
 * Failure modes:
 *   - Upstream unreachable → write a JSON-RPC error response that
 *     mirrors the offending request's `id`, so the client gets a
 *     clean error instead of a hang. NEVER throw on the stdin loop
 *     — Claude Desktop kills the process if stdin closes
 *     unexpectedly.
 *   - Malformed line on stdin → log to stderr, skip, keep going.
 *
 * Environment variables:
 *   MCP_URL   override the upstream URL (default
 *             http://localhost:7842/mcp). Useful when the dashboard
 *             runs on a non-default port (BLASTRADIUS_PORT).
 *   MCP_DEBUG truthy → log every request/response pair to stderr.
 */

import readline from 'node:readline'

const MCP_URL = process.env.MCP_URL || 'http://localhost:7842/mcp'
const DEBUG = !!process.env.MCP_DEBUG && process.env.MCP_DEBUG !== '0' && process.env.MCP_DEBUG !== 'false'

function dbg(...args) {
  if (DEBUG) process.stderr.write('[blastradius-shim] ' + args.join(' ') + '\n')
}

function emit(payload) {
  // One JSON object per line. Match the SDK's StdioTransport framing
  // exactly so any LSP-style client also slots in.
  process.stdout.write(JSON.stringify(payload) + '\n')
}

function emitError(id, message, code = -32603) {
  // JSON-RPC 2.0 error envelope. id is `null` for notifications or
  // unparseable requests — anything else mirrors the request id so
  // the client can pair the error to the original call.
  emit({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
}

/**
 * Parse the upstream response into one or more JSON-RPC frames and
 * push each through `emit`. Handles both content types BlastRadius
 * may answer with (it currently always uses SSE, but plain JSON is
 * also valid per the MCP spec).
 */
async function forwardResponse(resp, requestId) {
  const contentType = resp.headers.get('content-type') || ''
  const text = await resp.text()

  if (contentType.includes('text/event-stream')) {
    // SSE frame format: blocks separated by blank lines; each block
    // may have multiple lines (`event: ...`, `data: ...`, `id: ...`).
    // We only care about `data:` — that's the JSON-RPC payload.
    for (const block of text.split(/\r?\n\r?\n/)) {
      if (!block.trim()) continue
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue
        // Strip "data:" + at most one space (per SSE spec).
        const raw = line.slice(5).replace(/^ /, '')
        if (!raw) continue
        try {
          // Validate it's actually JSON before forwarding — saves
          // the client from a parse error two layers up.
          JSON.parse(raw)
          process.stdout.write(raw + '\n')
        } catch (err) {
          dbg('non-JSON SSE data, skipping:', raw.slice(0, 80))
        }
      }
    }
    return
  }

  if (contentType.includes('application/json')) {
    if (!text.trim()) return
    try {
      JSON.parse(text)
      process.stdout.write(text + '\n')
    } catch (err) {
      emitError(requestId, `upstream returned malformed JSON: ${err.message}`)
    }
    return
  }

  // Non-JSON, non-SSE response (e.g. 502 HTML from a proxy in front
  // of the dashboard) — surface as a JSON-RPC error so the client
  // doesn't wait forever for a parseable reply.
  emitError(
    requestId,
    `upstream returned unexpected Content-Type "${contentType || '(none)'}": ${text.slice(0, 200)}`,
  )
}

async function handleLine(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch (err) {
    // We can't pair the error to an id because we couldn't parse the
    // request. Emit with id null — most clients log + drop these.
    emitError(null, `shim could not parse line: ${err.message}`)
    return
  }

  const requestId = (message && typeof message === 'object') ? message.id : null
  const isNotification = (requestId === undefined || requestId === null)

  let resp
  try {
    resp = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: line,
    })
  } catch (err) {
    // Network-level failure — almost always "BlastRadius dashboard
    // not running" or "wrong port". Tell the client.
    if (!isNotification) {
      emitError(
        requestId,
        `upstream unreachable at ${MCP_URL}: ${err.message}. Is the BlastRadius dashboard running?`,
      )
    } else {
      dbg(`notification dropped, upstream unreachable: ${err.message}`)
    }
    return
  }

  if (!resp.ok) {
    if (!isNotification) {
      const text = await resp.text().catch(() => '')
      emitError(
        requestId,
        `upstream HTTP ${resp.status} ${resp.statusText}: ${text.slice(0, 200)}`,
        resp.status === 429 ? -32000 : -32603,
      )
    }
    return
  }

  // For notifications the server typically returns 202 with no body;
  // we still drain to free the socket but don't emit anything.
  if (isNotification) {
    await resp.text().catch(() => {})
    return
  }

  await forwardResponse(resp, requestId)
}

// ─── Stdin loop ─────────────────────────────────────────────────────────────
//
// Concurrency model: we fire-and-forget each line's handler so a slow
// upstream doesn't block subsequent input on stdin (JSON-RPC ids
// preserve pairing on the client side). On 'close' we have to wait
// for any in-flight handlers to write their response to stdout —
// otherwise piped one-shot smoke tests like `echo ... | node shim.mjs`
// exit before the upstream POST resolves, swallowing the answer.

let inFlight = 0
let stdinClosed = false

function maybeExit() {
  if (stdinClosed && inFlight === 0) {
    dbg(`exiting cleanly (drained ${0} in-flight)`)
    process.exit(0)
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  // crlfDelay so that Windows CRLF clients are handled identically
  // to Unix LF clients.
  crlfDelay: Infinity,
  terminal: false,
})

rl.on('line', (line) => {
  if (!line.trim()) return
  inFlight++
  handleLine(line)
    .catch((err) => { dbg('unexpected handleLine error:', err?.message || err) })
    .finally(() => {
      inFlight--
      maybeExit()
    })
})

rl.on('close', () => {
  // Client closed stdin. If everything has already been answered,
  // we can exit immediately; otherwise wait for the last in-flight
  // upstream call to come back before tearing down stdout.
  dbg(`stdin closed (${inFlight} in-flight)`)
  stdinClosed = true
  maybeExit()
})

// Surface boot-time diagnostics to stderr so the user sees them
// in the Claude Desktop "Open Console" log if anything goes wrong.
dbg(`shim ready, upstream=${MCP_URL}, debug=${DEBUG}`)
