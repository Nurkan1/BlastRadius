/**
 * GET /api/graph — response shape contract.
 *
 * rc8.2+: the endpoint must surface aggregate counters as TOP-LEVEL
 * fields (`totalNodes`, `totalEdges`, `cycleCount`, `orphanCount`,
 * `withSummary`), independent of the (possibly truncated) `nodes`
 * and `edges` arrays. The dashboard header MUST NOT compute totals
 * client-side from `nodes.length` — that breaks the moment the
 * snapshot exceeds the 200-node default cap. The backend is the
 * source of truth.
 *
 * `stats` stays as a backwards-compatible alias so rc8.1-era
 * dashboards (and any third-party reader that already shipped)
 * keep working unchanged.
 *
 * This test boots a minimal Express app with only the REST router
 * and a hand-built fake repo context whose knowledgeGraph snapshot
 * has known counters. No file I/O, no real graphResolver.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import { makeRouter } from '../src/server/routes.js'

function buildSnapshot({ nodes, edges = [], cycles = [], orphans = [], builtAt = Date.now() } = {}) {
  const nodeMap = new Map()
  let withSummary = 0
  for (const n of nodes) {
    if (n.summary) withSummary++
    nodeMap.set(n.path, {
      path: n.path,
      kind: n.kind ?? 'source',
      sizeBytes: n.sizeBytes ?? 100,
      lastModifiedMs: n.lastModifiedMs ?? 0,
      fanIn: n.fanIn ?? 0,
      fanOut: n.fanOut ?? 0,
      summary: n.summary ?? null,
      tags: n.tags ?? [],
      summaryUpdatedAt: n.summaryUpdatedAt ?? null,
    })
  }
  return {
    nodes: nodeMap,
    cycles,
    orphans,
    builtAt,
    stats: {
      nodes: nodeMap.size,
      edges: edges.length,
      cycles: cycles.length,
      orphans: orphans.length,
      withSummary,
    },
  }
}

function buildRepoContext(snapshot, forwardEdges = []) {
  const forward = new Map()
  const reverse = new Map()
  for (const [from, to] of forwardEdges) {
    if (!forward.has(from)) forward.set(from, new Set())
    forward.get(from).add(to)
    if (!reverse.has(to)) reverse.set(to, new Set())
    reverse.get(to).add(from)
  }
  return {
    repoPath: '/fake/repo',
    treeScanner: {
      countFiles: async () => snapshot.nodes.size,
      getFileSet: async () => new Set([...snapshot.nodes.keys()]),
    },
    graphResolver: { getGraph: () => ({ forward, reverse }) },
    diffProvider: { getDiff: async () => ({ ok: true, file: '', raw: '', html: '' }) },
    knowledgeGraph: { getSnapshot: () => snapshot, getNode: (p) => snapshot.nodes.get(p) ?? null },
  }
}

function buildDeps(snapshot, edges) {
  const ctx = buildRepoContext(snapshot, edges)
  return {
    getRepoContext: () => ctx,
    eventStore: {
      getEvents: () => [], getEventsForRepo: () => [], listDaysWithActivity: async () => [],
    },
    iterationMarker: { get: () => null, getIso: () => null },
    preferences: { get: () => ({ currentRepo: '/fake/repo', parentDir: '/fake', autoSwitch: false, needsSetup: false }) },
    repoDetector: () => ({ getRepos: async () => [] }),
    rebuildRepoDetector: () => {},
    switchRepo: async () => {},
    depth: 2,
    logger: { debug() {}, info() {}, warn() {} },
    blastRadiusRoot: '/fake',
    serverStartSha: 'test',
    getAutoSwitchSnoozedUntil: () => null,
    knowledgeStore: {
      setNodeSummary: async (_repo, _path, { summary, tags }) => ({ summary, tags, updatedAt: new Date().toISOString() }),
    },
  }
}

describe('GET /api/graph — response shape (rc8.2)', () => {
  let server
  let baseUrl
  let snapshot

  beforeAll(async () => {
    snapshot = buildSnapshot({
      nodes: [
        { path: 'src/a.js', fanIn: 0, fanOut: 1 },
        { path: 'src/b.js', fanIn: 1, fanOut: 1, summary: 'B' },
        { path: 'src/c.js', fanIn: 1, fanOut: 0 },
      ],
      edges: [['src/a.js', 'src/b.js'], ['src/b.js', 'src/c.js']],
      cycles: [['src/x.js', 'src/y.js']],
      orphans: ['src/dead.js', 'src/dead2.js'],
    })
    const app = express()
    app.use(express.json({ limit: '64kb' }))
    app.use(makeRouter(buildDeps(snapshot, [['src/a.js', 'src/b.js'], ['src/b.js', 'src/c.js']])))
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address()
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  it('surfaces totalNodes / totalEdges / cycleCount / orphanCount / withSummary at the top level', async () => {
    const res = await fetch(`${baseUrl}/api/graph`)
    expect(res.status).toBe(200)
    const body = await res.json()

    // Aggregate counters — the load-bearing part of this test. These
    // must come from the snapshot's stats object, NOT from the length
    // of the returned `nodes` array (which can be slice-truncated).
    expect(body.totalNodes).toBe(3)
    expect(body.totalEdges).toBe(2)
    expect(body.cycleCount).toBe(1)
    expect(body.orphanCount).toBe(2)
    expect(body.withSummary).toBe(1)

    // Backwards-compat alias must keep the same shape so rc8.1
    // dashboards don't blow up after upgrading the server.
    expect(body.stats).toEqual({
      nodes: 3, edges: 2, cycles: 1, orphans: 2, withSummary: 1,
    })

    // Sliced arrays still present.
    expect(Array.isArray(body.nodes)).toBe(true)
    expect(Array.isArray(body.edges)).toBe(true)
    expect(body.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('keeps aggregate counters honest when the response is truncated', async () => {
    // Build a fresh snapshot with 30 nodes so a limit=5 query truncates.
    const bigNodes = []
    for (let i = 0; i < 30; i++) bigNodes.push({ path: `src/f${i}.js`, fanIn: i % 3, fanOut: 0 })
    const big = buildSnapshot({ nodes: bigNodes })

    // Spin a sub-app with this larger snapshot.
    const sub = express()
    sub.use(express.json({ limit: '64kb' }))
    sub.use(makeRouter(buildDeps(big, [])))
    const subServer = await new Promise((resolve) => {
      const s = sub.listen(0, '127.0.0.1', () => resolve(s))
    })
    try {
      const { port } = subServer.address()
      const res = await fetch(`http://127.0.0.1:${port}/api/graph?limit=5`)
      const body = await res.json()
      expect(body.truncated).toBe(true)
      expect(body.nodes.length).toBe(5)
      // CRITICAL: totalNodes describes the FULL snapshot (30), not the
      // sliced array. Same for the other counters. If a future
      // refactor regresses this, the dashboard header will silently
      // lie about graph size.
      expect(body.totalNodes).toBe(30)
      expect(body.totalEdges).toBe(0)
      expect(body.cycleCount).toBe(0)
      expect(body.orphanCount).toBe(0)
    } finally {
      await new Promise((resolve) => subServer.close(resolve))
    }
  })
})
