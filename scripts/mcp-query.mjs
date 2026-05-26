#!/usr/bin/env node
/**
 * Quick MCP query utility — connects to a running BlastRadius MCP
 * server, runs a few representative read-only calls, and prints
 * structured output. Useful for ad-hoc verification and demos.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const URL_BASE = process.env.MCP_URL || 'http://127.0.0.1:7842/mcp'

function show(label, obj) {
  console.log(`\n=== ${label} ===`)
  console.log(JSON.stringify(obj, null, 2))
}

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(URL_BASE))
  const client = new Client({ name: 'mcp-query', version: '0.0.1' })
  await client.connect(transport)

  // 1. Summarize progress since today's midnight (no since arg = iteration window only)
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const summarize = await client.callTool({
    name: 'summarize_progress',
    arguments: { since: todayStart.toISOString() },
  })
  const sumPayload = summarize.structuredContent ?? JSON.parse(summarize.content[0].text)
  show('summarize_progress since midnight (active repo)', {
    since: sumPayload.since,
    scope: sumPayload.scope,
    repo: sumPayload.repo,
    totals: sumPayload.totals,
    reason: sumPayload.reason,
    files_count: Array.isArray(sumPayload.files) ? sumPayload.files.length : null,
    top_5_files: Array.isArray(sumPayload.files) ? sumPayload.files.slice(0, 5) : null,
  })

  // 2. List recent iterations (bursts inferred from event gaps)
  const iters = await client.callTool({
    name: 'list_recent_iterations',
    arguments: { limit: 5, gapMs: 180_000 },
  })
  const itersPayload = iters.structuredContent ?? JSON.parse(iters.content[0].text)
  show('list_recent_iterations (last 5, 3-min gap)', itersPayload)

  // 3. Read events/recent resource
  const events = await client.readResource({ uri: 'blastradius://events/recent' })
  const evBody = JSON.parse(events.contents[0].text)
  show('blastradius://events/recent (head 5)', {
    repo: evBody.repo,
    total: evBody.total,
    reason: evBody.reason,
    first_5: Array.isArray(evBody.events) ? evBody.events.slice(0, 5) : null,
  })

  // 4. Heat for session window
  const heat = await client.readResource({ uri: 'blastradius://heat/session' })
  const heatBody = JSON.parse(heat.contents[0].text)
  show('blastradius://heat/session', heatBody)

  await client.close()
  await transport.close()
}

main().catch((err) => {
  console.error('mcp-query FAIL:', err)
  process.exit(1)
})
