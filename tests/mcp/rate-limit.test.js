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

    let successes = 0
    let last429 = null
    // Fire 110 requests serially. The bucket starts at 100; with no
    // measurable time spent between requests the refill (~30/s) will
    // add at most a handful of tokens during the loop, so we expect
    // ~100 successes and a clean 429 around request 101-104.
    for (let i = 0; i < 110; i++) {
      const resp = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body,
      })
      if (resp.status === 429) {
        last429 = resp
        break
      }
      successes += 1
    }

    expect(successes).toBeGreaterThanOrEqual(100)
    expect(last429).not.toBeNull()
    expect(last429.status).toBe(429)
    expect(last429.headers.get('retry-after')).toBeTruthy()
    const json = await last429.json()
    expect(json.error).toBe('rate_limited')
    expect(json).toHaveProperty('retryAfterSec')
  })
})
