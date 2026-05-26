#!/usr/bin/env node
/**
 * Manual regression harness — exercises the MCP server using the
 * SDK's real StreamableHTTPClientTransport over the wire. This is
 * exactly the code path Claude Code / Antigravity 2.0 use when they
 * speak to a remote MCP server.
 *
 * Why it lives outside the vitest suite: the in-memory transport
 * (used by tests/mcp/server.test.js) connects exactly one client
 * to one server per test, so it never reproduces the concurrent /
 * overlapping-request behavior of real HTTP. This script DID catch
 * a real bug during Phase 1: a single shared McpServer across
 * requests would throw "Already connected to a transport" the
 * moment a real client made two rapid calls. The unit tests
 * couldn't see it; this harness did.
 *
 * Run any time you change src/mcp/transport-http.js or upgrade the
 * SDK:
 *
 *   # Start the dashboard in another shell, then
 *   MCP_URL=http://127.0.0.1:7842/mcp node scripts/verify-mcp-http-client.mjs
 *
 * Exit 0 on success, 1 on any failure.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const URL_BASE = process.env.MCP_URL || 'http://127.0.0.1:7845/mcp'

function trunc(s, n = 600) {
  const str = typeof s === 'string' ? s : JSON.stringify(s, null, 2)
  return str.length > n ? str.slice(0, n) + ' …(truncated)' : str
}

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(URL_BASE))
  const client = new Client({ name: 'verify-mcp-http-client', version: '0.0.1' })

  console.log(`Connecting to ${URL_BASE} via StreamableHTTPClientTransport…`)
  await client.connect(transport)

  const serverVersion = client.getServerVersion()
  const caps = client.getServerCapabilities()
  console.log('Connected. Server says:', serverVersion)
  console.log('Capabilities:', Object.keys(caps || {}))

  const { tools } = await client.listTools()
  console.log(`Tools (${tools.length}):`, tools.map((t) => t.name))

  const { resources } = await client.listResources()
  console.log(`Resources (${resources.length}):`, resources.map((r) => r.uri))

  const { resourceTemplates } = await client.listResourceTemplates()
  console.log(`Resource templates (${resourceTemplates.length}):`, resourceTemplates.map((t) => t.uriTemplate))

  console.log('\n--- tools/call get_iteration_summary ---')
  const summary = await client.callTool({ name: 'get_iteration_summary', arguments: {} })
  console.log(trunc(summary.structuredContent ?? summary.content?.[0]?.text))

  console.log('\n--- resources/read blastradius://health ---')
  const health = await client.readResource({ uri: 'blastradius://health' })
  console.log(trunc(JSON.parse(health.contents[0].text)))

  console.log('\n--- resources/read blastradius://heat/iteration ---')
  const heat = await client.readResource({ uri: 'blastradius://heat/iteration' })
  console.log(trunc(JSON.parse(heat.contents[0].text)))

  await client.close()
  await transport.close()
  console.log('\nverify-mcp-http-client: PASS')
}

main().catch((err) => {
  console.error('verify-mcp-http-client: FAIL', err)
  process.exit(1)
})
