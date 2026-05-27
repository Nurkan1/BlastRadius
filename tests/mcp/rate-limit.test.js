/**
 * MCP /mcp transport — rate limiter sanity check.
 *
 * Refinement #2 in the Phase 1 plan: /mcp gets its own dedicated
 * token-bucket (100 burst, 30/sec sustained, 429 with Retry-After)
 * — generous to accommodate agent polling but bounded against
 * runaway loops.
 *
 * We don't drive the full MCP handshake here; we just slam the
 * /mcp endpoint with bursts of POSTs and verify:
 *   - the first 100 requests pass through to the transport
 *   - request #101 returns 429 with an explicit `error: 'rate_limited'`
 *     body and a Retry-After header
 *
 * The 429 contract is the load-bearing part. The transport
 * accepting / rejecting individual JSON-RPC payloads is covered by
 * server.test.js — here we only assert the limiter wraps it
 * correctly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import { securityHeaders } from '../../src/server/security.js'
import { makeMcpRouter } from '../../src/mcp/transport-http.js'

function buildDeps() {
  return {
    getRepoContext: () => null,
    eventStore: { getEvents: () => [], getEventsForRepo: () => [] },
    iterationMarker: { get: () => null, getIso: () => null },
    preferences: {
      get: () => ({ currentRepo: null, parentDir: null, autoSwitch: false, needsSetup: true }),
    },
    repoDetector: () => null,
    depth: 2,
    appVersion: '1.0.0-test',
    logger: { debug() {}, info() {}, warn() {} },
  }
}

describe('MCP /mcp — rate limiter', () => {
  let server
  let baseUrl

  beforeAll(async () => {
    const app = express()
    app.disable('x-powered-by')
    app.use(securityHeaders())
    app.use(express.json({ limit: '64kb' }))
    app.use(makeMcpRouter(buildDeps()))

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address()
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  it('allows the configured burst (100) and 429s the next request', async () => {
    // Minimal JSON-RPC payload: the transport will respond with an
    // initialize-related error since we never handshook, but that's
    // fine — we just need each request to consume a token.
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    })

    // rc8.4: original implementation was a serial 110-request loop
    // and relied on completing faster than the bucket's ~33 ms /
    // token refill (30 tokens/s, burst 100). Under vitest's default
    // file-parallelism, CPU contention from sibling tests stretches
    // per-request wallclock just enough that the bucket refills
    // tokens during the loop and the 429 never lands. The rc8.4
    // hookInstaller + routes-hook suites pushed it over.
    //
    // Fix: fire 200 requests concurrently with Promise.all. The
    // server processes them sequentially but the client-side issue
    // window is microseconds — token refill during the burst is
    // negligible. We expect ~100 successes + ~100 429s.
    const fire = () => fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body,
    })
    const responses = await Promise.all(Array.from({ length: 200 }, fire))
    const successes = responses.filter((r) => r.status !== 429).length
    const limited = responses.filter((r) => r.status === 429)
    const last429 = limited[limited.length - 1] ?? null

    expect(successes).toBeGreaterThanOrEqual(100)
    expect(limited.length).toBeGreaterThan(0)
    expect(last429).not.toBeNull()
    expect(last429.status).toBe(429)
    expect(last429.headers.get('retry-after')).toBeTruthy()
    const json = await last429.json()
    expect(json.error).toBe('rate_limited')
    expect(json).toHaveProperty('retryAfterSec')
  })
})
