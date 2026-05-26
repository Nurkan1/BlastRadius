/**
 * BlastRadius MCP server — end-to-end integration tests.
 *
 * Uses the SDK's `InMemoryTransport.createLinkedPair()` to connect an
 * MCP client and the real server in the same process. Verifies the
 * initialize handshake, capability advertisement, tool/resource
 * discovery, and a representative call on each side.
 *
 * The deps passed to createMcpServer are minimal fakes — just enough
 * structure to exercise the read paths. Each test seeds the fakes
 * with the synthetic data it needs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../../src/mcp/server.js'

// ─── Test doubles ──────────────────────────────────────────────────────────

function fakePreferences({ currentRepo = '/repo/active', parentDir = '/repo', needsSetup = false } = {}) {
  return {
    get: () => ({ currentRepo, parentDir, autoSwitch: true, iterationWindowMs: 180_000, needsSetup }),
  }
}

function fakeEventStore(events = []) {
  return {
    getEvents: () => events,
    getEventsForRepo: () => events.map((e) => ({ ...e })),
  }
}

function fakeIterationMarker(date = null) {
  return {
    get: () => date,
    getIso: () => (date ? date.toISOString() : null),
  }
}

function fakeRepoContext(repoPath = '/repo/active', { fileCount = 10, files = ['src/a.js'], graph = null } = {}) {
  return {
    repoPath,
    treeScanner: {
      countFiles: async () => fileCount,
      getFileSet: async () => new Set(files),
    },
    graphResolver: {
      getGraph: () => graph,
    },
    diffProvider: {
      getDiff: async (path) => ({ ok: true, file: path, raw: '--- a\n+++ b\n', html: '<div/>' }),
    },
  }
}

function buildDeps(overrides = {}) {
  return {
    getRepoContext: () => fakeRepoContext(),
    eventStore: fakeEventStore(),
    iterationMarker: fakeIterationMarker(),
    preferences: fakePreferences(),
    repoDetector: () => ({ getRepos: async () => [] }),
    depth: 2,
    appVersion: '1.0.0-test',
    serverInfo: { name: 'blastradius', version: '1.0.0-test' },
    ...overrides,
  }
}

// ─── Connect helper ────────────────────────────────────────────────────────

async function connectClient(deps) {
  const server = createMcpServer(deps)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)
  return { client, server }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('MCP server — handshake + discovery', () => {
  it('initialize handshake exposes name, version and read-only capabilities', async () => {
    const { client } = await connectClient(buildDeps())
    const serverVersion = client.getServerVersion()
    const caps = client.getServerCapabilities()

    expect(serverVersion).toEqual({ name: 'blastradius', version: '1.0.0-test' })
    expect(caps).toMatchObject({
      tools: expect.any(Object),
      resources: expect.any(Object),
    })
  })

  it('lists exactly the 4 Phase 1 tools', async () => {
    const { client } = await connectClient(buildDeps())
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'get_file_diff',
      'get_iteration_summary',
      'list_recent_iterations',
      'summarize_progress',
    ])
  })

  it('lists the 5 static resources + 1 templated resource', async () => {
    const { client } = await connectClient(buildDeps())
    const { resources } = await client.listResources()
    const uris = resources.map((r) => r.uri).sort()
    expect(uris).toEqual([
      'blastradius://events/recent',
      'blastradius://health',
      'blastradius://iteration/current',
      'blastradius://repo/active',
      'blastradius://repos',
    ])
    const { resourceTemplates } = await client.listResourceTemplates()
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain('blastradius://heat/{window}')
  })
})

describe('MCP server — NO-DATA contract (no active repo)', () => {
  const noRepoDeps = buildDeps({
    getRepoContext: () => null,
    preferences: fakePreferences({ currentRepo: null, needsSetup: false }),
  })

  it('get_iteration_summary returns NO-DATA with reason no_active_repo', async () => {
    const { client } = await connectClient(noRepoDeps)
    const res = await client.callTool({ name: 'get_iteration_summary', arguments: {} })
    expect(res.isError).toBeFalsy()
    const payload = res.structuredContent ?? JSON.parse(res.content[0].text)
    expect(payload.iteration).toBeNull()
    expect(payload.reason).toBe('no_active_repo')
  })

  it('get_iteration_summary returns reason needs_setup when wizard mode', async () => {
    const wizardDeps = buildDeps({
      getRepoContext: () => null,
      preferences: fakePreferences({ currentRepo: null, needsSetup: true }),
    })
    const { client } = await connectClient(wizardDeps)
    const res = await client.callTool({ name: 'get_iteration_summary', arguments: {} })
    const payload = res.structuredContent ?? JSON.parse(res.content[0].text)
    expect(payload.reason).toBe('needs_setup')
  })

  it('summarize_progress reports no_events_recorded when eventStore is empty', async () => {
    const { client } = await connectClient(buildDeps({ eventStore: fakeEventStore([]) }))
    const res = await client.callTool({ name: 'summarize_progress', arguments: {} })
    const payload = res.structuredContent ?? JSON.parse(res.content[0].text)
    expect(payload.files).toBeNull()
    expect(payload.reason).toBe('no_events_recorded')
  })

  it('list_recent_iterations returns NO-DATA when no repo active', async () => {
    const { client } = await connectClient(noRepoDeps)
    const res = await client.callTool({ name: 'list_recent_iterations', arguments: {} })
    const payload = res.structuredContent ?? JSON.parse(res.content[0].text)
    expect(payload.iterations).toBeNull()
    expect(payload.reason).toBe('no_active_repo')
  })

  it('get_file_diff rejects path traversal via reused validator', async () => {
    const { client } = await connectClient(buildDeps())
    const res = await client.callTool({
      name: 'get_file_diff',
      arguments: { path: '../../etc/passwd' },
    })
    const payload = res.structuredContent ?? JSON.parse(res.content[0].text)
    expect(payload.diff).toBeNull()
    // The reused validator uses code 'escapes_root' for relative dot-dot
    // chains that resolve outside the repo root.
    expect(['escapes_root', 'path_traversal']).toContain(payload.reason)
  })
})

describe('MCP server — happy paths', () => {
  it('summarize_progress aggregates by file and tool', async () => {
    const now = Date.now()
    const events = [
      { ts: new Date(now - 1000).toISOString(), pathNorm: 'src/a.js', tool: 'Edit', agent: 'claude' },
      { ts: new Date(now - 500).toISOString(), pathNorm: 'src/a.js', tool: 'Read', agent: 'claude' },
      { ts: new Date(now - 200).toISOString(), pathNorm: 'src/b.js', tool: 'Write', agent: 'antigravity' },
    ]
    const deps = buildDeps({ eventStore: fakeEventStore(events) })
    const { client } = await connectClient(deps)
    const res = await client.callTool({
      name: 'summarize_progress',
      arguments: { since: new Date(now - 5000).toISOString() },
    })
    const payload = res.structuredContent ?? JSON.parse(res.content[0].text)
    expect(payload.totals).toEqual({ reads: 1, writes: 1, edits: 1 })
    expect(payload.files).toHaveLength(2)
    const aFile = payload.files.find((f) => f.path === 'src/a.js')
    expect(aFile).toMatchObject({ reads: 1, edits: 1, agents: ['claude'] })
    expect(payload.reason).toBeNull()
  })

  it('list_recent_iterations splits events into bursts by gapMs', async () => {
    const t0 = Date.now() - 600_000 // 10 min ago
    const events = [
      { ts: new Date(t0).toISOString(), pathNorm: 'a', tool: 'Edit' },
      { ts: new Date(t0 + 5_000).toISOString(), pathNorm: 'a', tool: 'Edit' },
      // 6-minute gap
      { ts: new Date(t0 + 360_000).toISOString(), pathNorm: 'b', tool: 'Read' },
      { ts: new Date(t0 + 365_000).toISOString(), pathNorm: 'b', tool: 'Edit' },
    ]
    const { client } = await connectClient(buildDeps({ eventStore: fakeEventStore(events) }))
    const res = await client.callTool({
      name: 'list_recent_iterations',
      arguments: { gapMs: 180_000, limit: 5 },
    })
    const payload = res.structuredContent ?? JSON.parse(res.content[0].text)
    expect(payload.iterations).toHaveLength(2)
    // Most recent first.
    expect(payload.iterations[0].events).toBe(2)
    expect(payload.iterations[1].events).toBe(2)
  })

  it('get_iteration_summary returns activities when events exist in window', async () => {
    const now = Date.now()
    const events = [
      { ts: new Date(now - 30_000).toISOString(), pathNorm: 'src/a.js', tool: 'Edit', agent: 'claude' },
      { ts: new Date(now - 20_000).toISOString(), pathNorm: 'src/b.js', tool: 'Read', agent: 'claude' },
    ]
    const ctx = fakeRepoContext('/repo/active', { fileCount: 10, files: ['src/a.js', 'src/b.js'] })
    const deps = buildDeps({
      eventStore: fakeEventStore(events),
      getRepoContext: () => ctx,
    })
    const { client } = await connectClient(deps)
    const res = await client.callTool({ name: 'get_iteration_summary', arguments: {} })
    const payload = res.structuredContent ?? JSON.parse(res.content[0].text)
    expect(payload.reason).toBeNull()
    expect(payload.activities.edited).toHaveLength(1)
    expect(payload.activities.read).toHaveLength(1)
    expect(payload.metrics).toMatchObject({ red: 1, green: 1, yellow: 0 })
  })

  it('get_file_diff returns the diff payload when path is valid', async () => {
    const { client } = await connectClient(buildDeps())
    const res = await client.callTool({
      name: 'get_file_diff',
      arguments: { path: 'src/a.js', against: 'HEAD' },
    })
    const payload = res.structuredContent ?? JSON.parse(res.content[0].text)
    expect(payload.reason).toBeNull()
    expect(payload.diff.file).toBe('src/a.js')
    expect(payload.against).toBe('HEAD')
  })
})

describe('MCP server — resources', () => {
  it('blastradius://health returns server metadata', async () => {
    const { client } = await connectClient(buildDeps())
    const res = await client.readResource({ uri: 'blastradius://health' })
    const body = JSON.parse(res.contents[0].text)
    expect(body.status).toBe('ok')
    expect(body.server).toMatchObject({ name: 'blastradius', version: '1.0.0-test' })
  })

  it('blastradius://heat/{window} validates window via NO-DATA contract', async () => {
    const { client } = await connectClient(buildDeps())
    const res = await client.readResource({ uri: 'blastradius://heat/bogus' })
    const body = JSON.parse(res.contents[0].text)
    expect(body.files).toBeNull()
    expect(body.reason).toBe('unknown_window')
    expect(body.allowed).toEqual(expect.arrayContaining(['session', 'iteration', 'hour', 'day']))
  })

  it('blastradius://repo/active returns NO-DATA when no repo is set', async () => {
    const deps = buildDeps({
      getRepoContext: () => null,
      preferences: fakePreferences({ currentRepo: null }),
    })
    const { client } = await connectClient(deps)
    const res = await client.readResource({ uri: 'blastradius://repo/active' })
    const body = JSON.parse(res.contents[0].text)
    expect(body.repo).toBeNull()
    expect(body.reason).toBe('no_active_repo')
  })

  it('blastradius://events/recent caps to last 100 events newest-first', async () => {
    const events = Array.from({ length: 150 }, (_, i) => ({
      ts: new Date(Date.now() - (150 - i) * 1000).toISOString(),
      pathNorm: `f${i}.js`,
      tool: 'Read',
    }))
    const deps = buildDeps({ eventStore: fakeEventStore(events) })
    const { client } = await connectClient(deps)
    const res = await client.readResource({ uri: 'blastradius://events/recent' })
    const body = JSON.parse(res.contents[0].text)
    expect(body.events).toHaveLength(100)
    // Newest first — the last seeded event (index 149) becomes index 0.
    expect(body.events[0].pathNorm).toBe('f149.js')
    expect(body.total).toBe(150)
  })
})
