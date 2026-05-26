/**
 * BlastRadius MCP — Knowledge Graph tools + resources (rc8).
 *
 * Tests the 5 new tools (get_codebase_graph, get_nearest_neighbors,
 * describe_node, find_nodes, set_node_summary) and the 4 new resources
 * (blastradius://graph/{summary,topology,cycles,orphans}) end-to-end
 * through an InMemoryTransport pair — same harness pattern as
 * server.test.js.
 *
 * Goals:
 *   1. NO-DATA contract preserved (reason field always present).
 *   2. Path validation reused from DiffProvider (CWE-22 defense).
 *   3. set_node_summary carries the requiresConsent annotation
 *      (Phase 3 mutation gate).
 *   4. find_nodes ranks by relevance (path > tag > summary > contains).
 *   5. Graph snapshot is read O(1) — no rebuilds triggered by reads.
 */

import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../../src/mcp/server.js'

// ─── Fakes ─────────────────────────────────────────────────────────────────

function fakePreferences({ currentRepo = '/repo/active', needsSetup = false } = {}) {
  return {
    get: () => ({ currentRepo, parentDir: '/repo', autoSwitch: true, iterationWindowMs: 180_000, needsSetup }),
  }
}

function fakeEventStore(events = []) {
  return {
    getEvents: () => events,
    getEventsForRepo: () => events,
    listDaysWithActivity: async () => [],
    loadDays: async () => {},
    getEventsForRepoInRange: () => events,
  }
}

function fakeIterationMarker() {
  return { get: () => null, getIso: () => null }
}

/**
 * Build a snapshot the way KnowledgeGraph._buildSnapshot would. Tests
 * pass a small "spec" of paths + fanIn/fanOut + optional summary; this
 * builder fills in the rest.
 */
function buildSnapshot(spec) {
  const nodes = new Map()
  let withSummary = 0
  for (const s of spec.nodes) {
    if (s.summary) withSummary++
    nodes.set(s.path, {
      path: s.path,
      kind: s.kind ?? 'source',
      sizeBytes: s.sizeBytes ?? 100,
      lastModifiedMs: s.lastModifiedMs ?? 0,
      fanIn: s.fanIn ?? 0,
      fanOut: s.fanOut ?? 0,
      summary: s.summary ?? null,
      tags: s.tags ?? [],
      summaryUpdatedAt: s.summaryUpdatedAt ?? null,
    })
  }
  return {
    nodes,
    cycles: spec.cycles ?? [],
    orphans: spec.orphans ?? [],
    builtAt: spec.builtAt ?? Date.now(),
    stats: {
      nodes: nodes.size,
      edges: spec.edges?.length ?? 0,
      cycles: (spec.cycles ?? []).length,
      orphans: (spec.orphans ?? []).length,
      withSummary,
    },
  }
}

function fakeKnowledgeGraph(snapshot) {
  let cur = snapshot
  return {
    getSnapshot: () => cur,
    getNode: (p) => cur.nodes.get(p) ?? null,
    rebuild: async () => {},
    scheduleRebuild: () => {},
    _setSnapshot(next) { cur = next },
  }
}

function fakeKnowledgeStore() {
  const data = new Map() // `${repo}|${path}` → entry
  return {
    getRepoNodes: () => ({}),
    setNodeSummary: async (repo, path, { summary = '', tags = [] } = {}) => {
      if (typeof summary === 'string' && summary.length > 2000) {
        const e = new Error('summary too long'); e.code = 'summary_too_long'; throw e
      }
      if (Array.isArray(tags) && tags.length > 20) {
        const e = new Error('too many tags'); e.code = 'too_many_tags'; throw e
      }
      const entry = { summary, tags: Array.isArray(tags) ? [...tags] : [], updatedAt: new Date().toISOString() }
      data.set(`${repo}|${path}`, entry)
      return entry
    },
    _get: (repo, path) => data.get(`${repo}|${path}`) ?? null,
  }
}

function fakeRepoContext(repoPath, snapshot, forwardEdges = []) {
  // Build a forward Map from the edge list so get_codebase_graph
  // and get_nearest_neighbors have something to walk.
  const forward = new Map()
  const reverse = new Map()
  for (const [from, to] of forwardEdges) {
    if (!forward.has(from)) forward.set(from, new Set())
    forward.get(from).add(to)
    if (!reverse.has(to)) reverse.set(to, new Set())
    reverse.get(to).add(from)
  }
  return {
    repoPath,
    treeScanner: {
      countFiles: async () => snapshot.nodes.size,
      getFileSet: async () => new Set([...snapshot.nodes.keys()]),
    },
    graphResolver: {
      getGraph: () => ({ forward, reverse }),
    },
    diffProvider: {
      getDiff: async (path) => ({ ok: true, file: path, raw: '', html: '' }),
    },
    knowledgeGraph: fakeKnowledgeGraph(snapshot),
  }
}

function buildDeps({ snapshot, edges = [], repoPath = '/repo/active', knowledgeStore, preferences } = {}) {
  const snap = snapshot ?? buildSnapshot({ nodes: [] })
  return {
    getRepoContext: () => fakeRepoContext(repoPath, snap, edges),
    eventStore: fakeEventStore([]),
    iterationMarker: fakeIterationMarker(),
    preferences: preferences ?? fakePreferences({ currentRepo: repoPath }),
    repoDetector: () => ({ getRepos: async () => [] }),
    depth: 2,
    appVersion: '1.0.0-test',
    serverInfo: { name: 'blastradius', version: '1.0.0-test' },
    knowledgeStore: knowledgeStore ?? fakeKnowledgeStore(),
  }
}

async function connectClient(deps) {
  const server = createMcpServer(deps)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)
  return { client, server }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function parsePayload(res) {
  return res.structuredContent ?? JSON.parse(res.content[0].text)
}

function parseResource(res) {
  return JSON.parse(res.contents[0].text)
}

// ─── NO-DATA when graph is not ready ───────────────────────────────────────

describe('Knowledge Graph tools — NO-DATA contract', () => {
  it('get_codebase_graph returns graph_not_ready when snapshot.builtAt === 0', async () => {
    // Empty snapshot has builtAt = 0 by construction.
    const snapshot = buildSnapshot({ nodes: [], builtAt: 0 })
    const { client } = await connectClient(buildDeps({ snapshot }))
    const res = await client.callTool({ name: 'get_codebase_graph', arguments: {} })
    const payload = parsePayload(res)
    expect(payload.nodes).toBeNull()
    expect(payload.edges).toBeNull()
    expect(payload.reason).toBe('graph_not_ready')
  })

  it('returns no_active_repo when getRepoContext returns null', async () => {
    const { client } = await connectClient({
      ...buildDeps(),
      getRepoContext: () => null,
      preferences: fakePreferences({ currentRepo: null, needsSetup: false }),
    })
    const res = await client.callTool({ name: 'get_codebase_graph', arguments: {} })
    const payload = parsePayload(res)
    expect(payload.reason).toBe('no_active_repo')
  })

  it('returns needs_setup when wizard mode is on', async () => {
    const { client } = await connectClient({
      ...buildDeps(),
      getRepoContext: () => null,
      preferences: fakePreferences({ currentRepo: null, needsSetup: true }),
    })
    const res = await client.callTool({ name: 'get_nearest_neighbors', arguments: { path: 'src/a.js' } })
    const payload = parsePayload(res)
    expect(payload.reason).toBe('needs_setup')
  })
})

// ─── get_codebase_graph happy path + filters ───────────────────────────────

describe('get_codebase_graph', () => {
  const snap = buildSnapshot({
    nodes: [
      { path: 'src/a.js', fanIn: 0, fanOut: 1, kind: 'source' },
      { path: 'src/b.js', fanIn: 1, fanOut: 1, kind: 'source', summary: 'B summary' },
      { path: 'src/c.js', fanIn: 1, fanOut: 0, kind: 'source' },
      { path: 'docs/readme.md', fanIn: 0, fanOut: 0, kind: 'doc' },
      { path: 'tests/a.test.js', fanIn: 0, fanOut: 1, kind: 'test' },
    ],
  })

  it('returns nodes + edges with stats and builtAt ISO string', async () => {
    const { client } = await connectClient(buildDeps({
      snapshot: snap,
      edges: [['src/a.js', 'src/b.js'], ['src/b.js', 'src/c.js'], ['tests/a.test.js', 'src/a.js']],
    }))
    const res = await client.callTool({ name: 'get_codebase_graph', arguments: {} })
    const payload = parsePayload(res)
    expect(payload.reason).toBeNull()
    expect(payload.nodes).toHaveLength(5)
    // edges only kept when BOTH endpoints are in the returned node set.
    expect(payload.edges.length).toBeGreaterThan(0)
    expect(payload.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(payload.stats.nodes).toBe(5)
  })

  it('filters by kinds', async () => {
    const { client } = await connectClient(buildDeps({ snapshot: snap }))
    const res = await client.callTool({ name: 'get_codebase_graph', arguments: { kinds: ['test'] } })
    const payload = parsePayload(res)
    expect(payload.nodes.map((n) => n.path)).toEqual(['tests/a.test.js'])
  })

  it('filters by minFanIn', async () => {
    const { client } = await connectClient(buildDeps({ snapshot: snap }))
    const res = await client.callTool({ name: 'get_codebase_graph', arguments: { minFanIn: 1 } })
    const payload = parsePayload(res)
    const paths = payload.nodes.map((n) => n.path).sort()
    expect(paths).toEqual(['src/b.js', 'src/c.js'])
  })

  it('filters by withSummaryOnly', async () => {
    const { client } = await connectClient(buildDeps({ snapshot: snap }))
    const res = await client.callTool({ name: 'get_codebase_graph', arguments: { withSummaryOnly: true } })
    const payload = parsePayload(res)
    expect(payload.nodes.map((n) => n.path)).toEqual(['src/b.js'])
  })

  it('truncates when more nodes than limit + flags truncated', async () => {
    const bigSpec = { nodes: [] }
    for (let i = 0; i < 50; i++) bigSpec.nodes.push({ path: `src/f${i}.js`, fanIn: i, fanOut: 0 })
    const big = buildSnapshot(bigSpec)
    const { client } = await connectClient(buildDeps({ snapshot: big }))
    const res = await client.callTool({ name: 'get_codebase_graph', arguments: { limit: 10 } })
    const payload = parsePayload(res)
    expect(payload.nodes).toHaveLength(10)
    expect(payload.truncated).toBe(true)
    expect(payload.limit).toBe(10)
    // sorted by fanIn desc → top 10 are f49..f40
    expect(payload.nodes[0].path).toBe('src/f49.js')
    expect(payload.nodes[9].path).toBe('src/f40.js')
  })
})

// ─── get_nearest_neighbors ────────────────────────────────────────────────

describe('get_nearest_neighbors', () => {
  // a → b → c chain plus d → b (b has fanIn 2).
  const snap = buildSnapshot({
    nodes: [
      { path: 'src/a.js', fanIn: 0, fanOut: 1 },
      { path: 'src/b.js', fanIn: 2, fanOut: 1 },
      { path: 'src/c.js', fanIn: 1, fanOut: 0 },
      { path: 'src/d.js', fanIn: 0, fanOut: 1 },
    ],
  })
  const edges = [
    ['src/a.js', 'src/b.js'],
    ['src/b.js', 'src/c.js'],
    ['src/d.js', 'src/b.js'],
  ]

  it('walks consumers + dependencies by default', async () => {
    const { client } = await connectClient(buildDeps({ snapshot: snap, edges }))
    const res = await client.callTool({ name: 'get_nearest_neighbors', arguments: { path: 'src/b.js' } })
    const payload = parsePayload(res)
    expect(payload.reason).toBeNull()
    expect(payload.consumers.map((c) => c.path).sort()).toEqual(['src/a.js', 'src/d.js'])
    expect(payload.dependencies.map((d) => d.path)).toEqual(['src/c.js'])
  })

  it('respects direction=consumers', async () => {
    const { client } = await connectClient(buildDeps({ snapshot: snap, edges }))
    const res = await client.callTool({
      name: 'get_nearest_neighbors',
      arguments: { path: 'src/b.js', direction: 'consumers' },
    })
    const payload = parsePayload(res)
    expect(payload.dependencies).toEqual([])
    expect(payload.consumers).toHaveLength(2)
  })

  it('returns unknown_node reason when path not in graph', async () => {
    const { client } = await connectClient(buildDeps({ snapshot: snap, edges }))
    const res = await client.callTool({
      name: 'get_nearest_neighbors',
      arguments: { path: 'src/missing.js' },
    })
    const payload = parsePayload(res)
    expect(payload.reason).toBe('unknown_node')
    expect(payload.consumers).toEqual([])
    expect(payload.dependencies).toEqual([])
  })

  it('rejects path traversal via reused DiffProvider validator', async () => {
    const { client } = await connectClient(buildDeps({ snapshot: snap, edges }))
    const res = await client.callTool({
      name: 'get_nearest_neighbors',
      arguments: { path: '../../etc/passwd' },
    })
    const payload = parsePayload(res)
    // PathTraversalError.code: 'escapes_root' for ../.. traversal.
    expect(['escapes_root', 'path_traversal', 'absolute_path']).toContain(payload.reason)
    expect(payload.consumers).toBeNull()
  })

  it('rejects absolute paths', async () => {
    const { client } = await connectClient(buildDeps({ snapshot: snap, edges }))
    const res = await client.callTool({
      name: 'get_nearest_neighbors',
      arguments: { path: '/etc/passwd' },
    })
    const payload = parsePayload(res)
    expect(payload.reason).toBe('absolute_path')
  })
})

// ─── describe_node ────────────────────────────────────────────────────────

describe('describe_node', () => {
  const snap = buildSnapshot({
    nodes: [
      { path: 'src/x.js', fanIn: 3, fanOut: 1, summary: 'Handles X.', tags: ['core', 'api'] },
    ],
  })

  it('returns node + recentActivity counters', async () => {
    const { client } = await connectClient(buildDeps({ snapshot: snap }))
    const res = await client.callTool({ name: 'describe_node', arguments: { path: 'src/x.js' } })
    const payload = parsePayload(res)
    expect(payload.reason).toBeNull()
    expect(payload.node.path).toBe('src/x.js')
    expect(payload.node.summary).toBe('Handles X.')
    expect(payload.node.tags).toEqual(['core', 'api'])
    expect(payload.recentActivity).toMatchObject({
      edits: expect.any(Number),
      reads: expect.any(Number),
      writes: expect.any(Number),
    })
  })

  it('returns unknown_node when path is not in the snapshot', async () => {
    const { client } = await connectClient(buildDeps({ snapshot: snap }))
    const res = await client.callTool({ name: 'describe_node', arguments: { path: 'src/missing.js' } })
    const payload = parsePayload(res)
    expect(payload.reason).toBe('unknown_node')
    expect(payload.node).toBeNull()
  })
})

// ─── find_nodes ───────────────────────────────────────────────────────────

describe('find_nodes — relevance ordering', () => {
  // Snapshot crafted so the same query "auth" hits each scoring level:
  //   - path startsWith 'auth' → 10
  //   - tag exact 'auth'       → 8
  //   - summary contains 'auth'→ 5
  //   - path contains 'auth'   → 3
  const snap = buildSnapshot({
    nodes: [
      { path: 'auth.js', fanIn: 0, fanOut: 0 },                                 // path startsWith → 10
      { path: 'src/m.js', fanIn: 0, fanOut: 0, tags: ['auth'] },                // tag exact → 8
      { path: 'src/n.js', fanIn: 0, fanOut: 0, summary: 'handles auth flow' }, // summary contains → 5
      { path: 'src/with-auth-impl.js', fanIn: 0, fanOut: 0 },                   // path contains → 3
      { path: 'src/unrelated.js', fanIn: 0, fanOut: 0 },                        // no match
    ],
  })

  it('ranks results: path startsWith > tag exact > summary contains > path contains', async () => {
    const { client } = await connectClient(buildDeps({ snapshot: snap }))
    const res = await client.callTool({ name: 'find_nodes', arguments: { query: 'auth' } })
    const payload = parsePayload(res)
    expect(payload.reason).toBeNull()
    const scoresByPath = Object.fromEntries(payload.matches.map((m) => [m.path, m.score]))
    expect(scoresByPath['auth.js']).toBe(10)
    expect(scoresByPath['src/m.js']).toBe(8)
    expect(scoresByPath['src/n.js']).toBe(5)
    expect(scoresByPath['src/with-auth-impl.js']).toBe(3)
    expect(scoresByPath['src/unrelated.js']).toBeUndefined()
    // Sorted desc by score.
    const scoresInOrder = payload.matches.map((m) => m.score)
    expect([...scoresInOrder]).toEqual([...scoresInOrder].sort((a, b) => b - a))
  })

  it('returns no_matches reason when nothing matches', async () => {
    const { client } = await connectClient(buildDeps({ snapshot: snap }))
    const res = await client.callTool({ name: 'find_nodes', arguments: { query: 'nonexistent_token_xyz' } })
    const payload = parsePayload(res)
    expect(payload.reason).toBe('no_matches')
    expect(payload.matches).toEqual([])
  })

  it('honours fields filter (only search tags)', async () => {
    const { client } = await connectClient(buildDeps({ snapshot: snap }))
    const res = await client.callTool({
      name: 'find_nodes',
      arguments: { query: 'auth', fields: ['tags'] },
    })
    const payload = parsePayload(res)
    // only src/m.js has tag 'auth' (exact); path/summary excluded.
    expect(payload.matches.map((m) => m.path)).toEqual(['src/m.js'])
  })
})

// ─── set_node_summary — annotations + persistence ─────────────────────────

describe('set_node_summary — Phase 3 mutation gate', () => {
  it('lists set_node_summary with the 4 standard MCP mutation hints', async () => {
    // MCP SDK strips non-standard annotation fields, so `requiresConsent`
    // (our Phase 3 contract additive flag) does not survive the wire —
    // it stays as documentation in src/mcp/tools.js. What MCP clients
    // actually use to gate the call is the combination of
    // `readOnlyHint: false` + `destructiveHint: false`, which marks the
    // tool as a non-destructive mutation requiring the same consent
    // prompt as any other write.
    const snap = buildSnapshot({ nodes: [{ path: 'src/a.js', fanIn: 0, fanOut: 0 }] })
    const { client } = await connectClient(buildDeps({ snapshot: snap }))
    const { tools } = await client.listTools()
    const tool = tools.find((t) => t.name === 'set_node_summary')
    expect(tool).toBeDefined()
    expect(tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
  })

  it('persists summary + tags via the knowledgeStore', async () => {
    const snap = buildSnapshot({ nodes: [{ path: 'src/a.js', fanIn: 0, fanOut: 0 }] })
    const store = fakeKnowledgeStore()
    const { client } = await connectClient(buildDeps({ snapshot: snap, knowledgeStore: store }))
    const res = await client.callTool({
      name: 'set_node_summary',
      arguments: { path: 'src/a.js', summary: 'Entry point for module A.', tags: ['entry', 'module-a'] },
    })
    const payload = parsePayload(res)
    expect(payload.ok).toBe(true)
    expect(payload.reason).toBeNull()
    expect(payload.entry.summary).toBe('Entry point for module A.')
    expect(payload.entry.tags).toEqual(['entry', 'module-a'])
    // KnowledgeStore actually got the call.
    expect(store._get('/repo/active', 'src/a.js')).not.toBeNull()
    // Snapshot got the optimistic in-memory refresh.
    expect(payload.node.summary).toBe('Entry point for module A.')
    expect(payload.node.tags).toEqual(['entry', 'module-a'])
  })

  it('rejects summary > 2000 chars via Zod (protocol-level cap defense)', async () => {
    // Defense-in-depth: the Zod schema declares summary.max(2000), so
    // the MCP SDK rejects oversize input *before* our handler runs.
    // KnowledgeStore.setNodeSummary's own `summary_too_long` guard is
    // the second line of defense for direct programmatic callers.
    const snap = buildSnapshot({ nodes: [{ path: 'src/a.js', fanIn: 0, fanOut: 0 }] })
    const store = fakeKnowledgeStore()
    const { client } = await connectClient(buildDeps({ snapshot: snap, knowledgeStore: store }))
    const longSummary = 'x'.repeat(2001) // 1 byte over the 2000 char cap.
    const res = await client.callTool({
      name: 'set_node_summary',
      arguments: { path: 'src/a.js', summary: longSummary },
    })
    // The SDK returns isError + a text content describing the violation.
    expect(res.isError).toBe(true)
    const errorText = res.content?.[0]?.text ?? ''
    expect(errorText).toMatch(/2000|too_big|String must contain|Too big/i)
    // Store was never touched.
    expect(store._get('/repo/active', 'src/a.js')).toBeNull()
  })

  it('rejects path traversal in the write path', async () => {
    const snap = buildSnapshot({ nodes: [{ path: 'src/a.js', fanIn: 0, fanOut: 0 }] })
    const { client } = await connectClient(buildDeps({ snapshot: snap }))
    const res = await client.callTool({
      name: 'set_node_summary',
      arguments: { path: '../../etc/passwd', summary: 'pwn' },
    })
    const payload = parsePayload(res)
    expect(payload.ok).toBe(false)
    expect(['escapes_root', 'path_traversal', 'absolute_path']).toContain(payload.reason)
  })
})

// ─── Resources — graph/* family ───────────────────────────────────────────

describe('Knowledge Graph resources', () => {
  const snap = buildSnapshot({
    nodes: [
      { path: 'src/a.js', fanIn: 0, fanOut: 1 },
      { path: 'src/b.js', fanIn: 1, fanOut: 0, summary: 'b' },
    ],
    cycles: [],
    orphans: ['src/a.js'],
  })

  it('blastradius://graph/summary returns stats + builtAt ISO', async () => {
    const { client } = await connectClient(buildDeps({
      snapshot: snap,
      edges: [['src/a.js', 'src/b.js']],
    }))
    const res = await client.readResource({ uri: 'blastradius://graph/summary' })
    const payload = parseResource(res)
    expect(payload.reason).toBeNull()
    expect(payload.stats).toMatchObject({ nodes: 2, withSummary: 1 })
    expect(payload.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('blastradius://graph/topology returns nodes + edges capped', async () => {
    const { client } = await connectClient(buildDeps({
      snapshot: snap,
      edges: [['src/a.js', 'src/b.js']],
    }))
    const res = await client.readResource({ uri: 'blastradius://graph/topology' })
    const payload = parseResource(res)
    expect(payload.reason).toBeNull()
    expect(payload.nodes).toHaveLength(2)
    expect(payload.edges).toEqual([{ from: 'src/a.js', to: 'src/b.js' }])
    expect(payload.truncated).toBe(false)
  })

  it('blastradius://graph/cycles returns cycles_none for a DAG', async () => {
    const { client } = await connectClient(buildDeps({
      snapshot: snap,
      edges: [['src/a.js', 'src/b.js']],
    }))
    const res = await client.readResource({ uri: 'blastradius://graph/cycles' })
    const payload = parseResource(res)
    expect(payload.reason).toBe('cycles_none')
    expect(payload.cycles).toEqual([])
    expect(payload.count).toBe(0)
  })

  it('blastradius://graph/orphans surfaces the orphan list when populated', async () => {
    const { client } = await connectClient(buildDeps({
      snapshot: snap,
      edges: [['src/a.js', 'src/b.js']],
    }))
    const res = await client.readResource({ uri: 'blastradius://graph/orphans' })
    const payload = parseResource(res)
    expect(payload.reason).toBeNull()
    expect(payload.orphans).toEqual(['src/a.js'])
    expect(payload.count).toBe(1)
  })

  it('returns graph_not_ready when snapshot.builtAt === 0', async () => {
    const empty = buildSnapshot({ nodes: [], builtAt: 0 })
    const { client } = await connectClient(buildDeps({ snapshot: empty }))
    const res = await client.readResource({ uri: 'blastradius://graph/summary' })
    const payload = parseResource(res)
    expect(payload.reason).toBe('graph_not_ready')
    expect(payload.stats).toBeNull()
  })
})
