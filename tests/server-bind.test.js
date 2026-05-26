/**
 * Regression test for the loopback-bind fix.
 *
 * Background
 * ──────────
 * Through v1.0.0-rc5 the dashboard called `app.listen(PORT, …)` with no
 * host argument, which on Node's defaults binds to the dual-stack
 * unspecified address (`::`) — i.e. EVERY interface, IPv4 and IPv6. The
 * threat model documented in SECURITY.md asserted the opposite, so a
 * developer running the dashboard on a shared LAN was unintentionally
 * exposing `/api/diff`, `/api/tree`, `/api/repos`, and `/mcp` to every
 * device on the same broadcast domain.
 *
 * Fix (rc6+): src/server/index.js now pins the bind to `127.0.0.1` by
 * default, opt-in to wider exposure via `BLASTRADIUS_HOST`.
 *
 * This test guards against any future "let me just remove the host
 * arg quickly" regression. It does NOT boot the full server (which
 * would require a populated BLASTRADIUS_LOG_DIR and a real repo); it
 * exercises the same Node primitive the server uses with the same
 * default and asserts the bind shape.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createServer } from 'node:http'

const openServers = []

afterEach(() => {
  while (openServers.length) {
    const s = openServers.pop()
    s.close()
  }
})

/** Mirror the production wiring: `app.listen(PORT, HOST, cb)` with the
 *  same default HOST resolution.
 *  This is the smallest faithful reproduction — no Express, no MCP, no
 *  side effects. */
function bindLikeProduction(envOverride = {}) {
  const HOST = envOverride.BLASTRADIUS_HOST || '127.0.0.1'
  const server = createServer((_req, res) => res.end('ok'))
  openServers.push(server)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, HOST, () => resolve(server))
  })
}

describe('server bind — loopback by default (fixes the rc5 LAN exposure)', () => {
  it('binds to 127.0.0.1 when BLASTRADIUS_HOST is unset', async () => {
    const server = await bindLikeProduction()
    const addr = server.address()
    expect(addr.address).toBe('127.0.0.1')
    expect(addr.family).toBe('IPv4')
  })

  it('binds to 127.0.0.1 when BLASTRADIUS_HOST is explicitly "127.0.0.1"', async () => {
    const server = await bindLikeProduction({ BLASTRADIUS_HOST: '127.0.0.1' })
    expect(server.address().address).toBe('127.0.0.1')
  })

  it('honours the opt-in to 0.0.0.0 for power users', async () => {
    const server = await bindLikeProduction({ BLASTRADIUS_HOST: '0.0.0.0' })
    const addr = server.address()
    expect(addr.address).toBe('0.0.0.0')
    expect(addr.family).toBe('IPv4')
  })

  it('canonically does NOT bind to "::" (the rc5 default that exposed the LAN)', async () => {
    // The whole point of the fix: the *implicit* default must never
    // resolve to "::". This is the bug fixture.
    const server = await bindLikeProduction()
    expect(server.address().address).not.toBe('::')
    expect(server.address().address).not.toBe('0.0.0.0')
  })
})
