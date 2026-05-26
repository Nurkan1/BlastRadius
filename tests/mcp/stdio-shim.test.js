/**
 * BlastRadius MCP stdio shim — integration tests.
 *
 * Spawns `node bin/blastradius-mcp.cjs` as a child process, writes
 * JSON-RPC messages to its stdin, reads the responses from stdout,
 * and asserts the shim correctly proxies them to a local HTTP MCP
 * server that we stand up just for the test.
 *
 * Why we test the .cjs wrapper rather than the .mjs source:
 *   - Claude Desktop 1.8555.x only accepts entries whose `command +
 *     args` reference a .cjs / .js file (the .mjs extension is
 *     filtered out by its config validator). Production traffic
 *     therefore always goes through the wrapper. We test the same
 *     path users actually run.
 *
 * The fake upstream is a minimal Express app that mimics the SDK's
 * Streamable HTTP transport: it responds with `event: message\ndata:
 * <json>\n\n` (SSE-framed) so the shim's SSE parser sees the same
 * shape it sees in real life.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import express from 'express'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SHIM_PATH = join(__dirname, '..', '..', 'bin', 'blastradius-mcp.cjs')

// ─── Fake upstream MCP server ──────────────────────────────────────────────

function buildUpstream({ onRequest, port = 0 } = {}) {
  const app = express()
  app.use(express.json())
  app.post('/mcp', (req, res) => {
    const body = req.body
    const replyPayload = onRequest(body) // synchronous: easier to reason about
    if (replyPayload === undefined) {
      res.status(202).end() // notification, no body
      return
    }
    // Match the SDK's wire format: SSE with a single `data:` line.
    res.set('Content-Type', 'text/event-stream')
    res.set('Cache-Control', 'no-cache')
    res.write(`event: message\ndata: ${JSON.stringify(replyPayload)}\n\n`)
    res.end()
  })
  return new Promise((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

// ─── spawnShim helper ──────────────────────────────────────────────────────

function spawnShim({ url, debug = false } = {}) {
  const child = spawn(process.execPath, [SHIM_PATH], {
    env: { ...process.env, MCP_URL: url, MCP_DEBUG: debug ? '1' : '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  /** Aggregate stdout into a per-line queue so tests can `await next()`. */
  const lines = []
  let pendingResolvers = []
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (!line.trim()) continue
      if (pendingResolvers.length > 0) {
        pendingResolvers.shift()(line)
      } else {
        lines.push(line)
      }
    }
  })
  return {
    child,
    send(obj) {
      child.stdin.write(JSON.stringify(obj) + '\n')
    },
    nextLine(timeoutMs = 5000) {
      if (lines.length > 0) return Promise.resolve(lines.shift())
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingResolvers = pendingResolvers.filter((r) => r !== onLine)
          reject(new Error(`shim did not emit a line within ${timeoutMs}ms`))
        }, timeoutMs)
        const onLine = (line) => {
          clearTimeout(timer)
          resolve(line)
        }
        pendingResolvers.push(onLine)
      })
    },
    async closeAndWait() {
      child.stdin.end()
      await new Promise((resolve) => {
        if (child.exitCode !== null) resolve()
        else child.once('exit', () => resolve())
      })
    },
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('stdio shim — happy path', () => {
  let upstream

  beforeAll(async () => {
    upstream = await buildUpstream({
      onRequest: (body) => {
        if (body.method === 'initialize') {
          return {
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {}, resources: {} },
              serverInfo: { name: 'fake-upstream', version: '0.0.1' },
            },
          }
        }
        if (body.method === 'tools/list') {
          return {
            jsonrpc: '2.0',
            id: body.id,
            result: { tools: [{ name: 'foo' }, { name: 'bar' }] },
          }
        }
        return { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } }
      },
    })
  })

  afterAll(async () => {
    await new Promise((r) => upstream.server.close(r))
  })

  it('forwards an initialize handshake and parses the SSE response back to NDJSON', async () => {
    const shim = spawnShim({ url: `http://127.0.0.1:${upstream.port}/mcp` })
    shim.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    })
    const lineRaw = await shim.nextLine()
    const reply = JSON.parse(lineRaw)
    expect(reply.id).toBe(1)
    expect(reply.result.protocolVersion).toBe('2025-03-26')
    expect(reply.result.serverInfo.name).toBe('fake-upstream')
    await shim.closeAndWait()
  })

  it('forwards multiple back-to-back calls without dropping responses', async () => {
    const shim = spawnShim({ url: `http://127.0.0.1:${upstream.port}/mcp` })
    shim.send({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
    shim.send({ jsonrpc: '2.0', id: 11, method: 'tools/list' })

    const ids = new Set()
    const lineA = JSON.parse(await shim.nextLine())
    const lineB = JSON.parse(await shim.nextLine())
    ids.add(lineA.id)
    ids.add(lineB.id)
    expect(ids).toEqual(new Set([10, 11]))
    await shim.closeAndWait()
  })

  it('exits cleanly on stdin close even with in-flight requests', async () => {
    const shim = spawnShim({ url: `http://127.0.0.1:${upstream.port}/mcp` })
    shim.send({
      jsonrpc: '2.0',
      id: 99,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    })
    // Close stdin immediately. The shim must still emit the
    // in-flight response BEFORE exiting (the drain logic in the
    // shim's 'close' handler).
    shim.child.stdin.end()
    const lineRaw = await shim.nextLine()
    const reply = JSON.parse(lineRaw)
    expect(reply.id).toBe(99)
    await new Promise((resolve) => {
      if (shim.child.exitCode !== null) resolve()
      else shim.child.once('exit', () => resolve())
    })
    expect(shim.child.exitCode).toBe(0)
  })
})

describe('stdio shim — error paths', () => {
  it('emits a JSON-RPC error when the upstream is unreachable', async () => {
    // Bind a port, immediately close it. The shim will then fail to
    // reach it — exactly the "BlastRadius dashboard not running"
    // scenario.
    const { server, port } = await buildUpstream({ onRequest: () => null })
    await new Promise((r) => server.close(r))

    const shim = spawnShim({ url: `http://127.0.0.1:${port}/mcp` })
    shim.send({
      jsonrpc: '2.0',
      id: 42,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    })
    const lineRaw = await shim.nextLine()
    const reply = JSON.parse(lineRaw)
    expect(reply.id).toBe(42)
    expect(reply.error).toBeDefined()
    expect(reply.error.message).toMatch(/upstream unreachable/i)
    await shim.closeAndWait()
  })

  it('does not write any malformed lines on stdout when the upstream returns garbage', async () => {
    // Stand up an upstream that ignores SSE framing and returns plain
    // text with the wrong content-type. The shim must surface this
    // as a JSON-RPC error, not as a raw stdout dump.
    const app = express()
    app.use(express.json())
    app.post('/mcp', (req, res) => {
      res.set('Content-Type', 'text/plain')
      res.send('this is not JSON-RPC')
    })
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    const port = server.address().port

    try {
      const shim = spawnShim({ url: `http://127.0.0.1:${port}/mcp` })
      shim.send({
        jsonrpc: '2.0',
        id: 7,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      })
      const lineRaw = await shim.nextLine()
      const reply = JSON.parse(lineRaw) // must be valid JSON
      expect(reply.id).toBe(7)
      expect(reply.error).toBeDefined()
      expect(reply.error.message).toMatch(/unexpected Content-Type/i)
      await shim.closeAndWait()
    } finally {
      await new Promise((r) => server.close(r))
    }
  })
})
