/**
 * GET /api/report.md + /api/report.html — endpoint contract (rc8.6).
 *
 * The pure formatting is covered by tests/reportBuilder.test.js; here
 * we verify the route wiring: correct Content-Type, the .md route
 * sends an attachment Content-Disposition, both embed the live data,
 * and a missing repo yields 503 (the wizard signal, consistent with
 * the other repo-scoped routes).
 *
 * Boots Express + makeRouter() with a hand-built repo context whose
 * heat inputs are deterministic. computeHeat is the real engine (it's
 * imported by routes.js), so we seed a couple of events.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import { makeRouter } from '../src/server/routes.js'

const REPO = '/repo/active'

function fakeCtx() {
  // Two events today so computeHeat produces non-empty metrics.
  const now = new Date().toISOString()
  const events = [
    { ts: now, path: `${REPO}/src/a.js`, pathNorm: 'src/a.js', cwd: REPO, tool: 'Edit', agent: 'Claude' },
    { ts: now, path: `${REPO}/src/b.js`, pathNorm: 'src/b.js', cwd: REPO, tool: 'Read', agent: 'Antigravity' },
  ]
  return {
    repoPath: REPO,
    treeScanner: {
      countFiles: async () => 10,
      getFileSet: async () => new Set(['src/a.js', 'src/b.js', 'src/c.js']),
    },
    graphResolver: { getGraph: () => ({ forward: new Map(), reverse: new Map() }) },
    knowledgeGraph: {
      getSnapshot: () => ({
        builtAt: Date.now(),
        stats: { nodes: 3, edges: 1, cycles: 0, orphans: 1, withSummary: 0 },
        nodes: new Map(), cycles: [], orphans: [],
      }),
    },
    _events: events,
  }
}

let server
let baseUrl
let ctx

beforeAll(async () => {
  ctx = fakeCtx()
  const deps = {
    getRepoContext: () => ctx,
    eventStore: {
      getEvents: () => ctx._events,
      getEventsForRepo: () => ctx._events.map((e) => ({ ...e })),
      listDaysWithActivity: async () => [],
    },
    iterationMarker: { get: () => null, getIso: () => null },
    preferences: { get: () => ({ currentRepo: REPO, parentDir: '/repo', autoSwitch: false, needsSetup: false }) },
    repoDetector: () => ({ getRepos: async () => [] }),
    rebuildRepoDetector: () => {},
    switchRepo: async () => {},
    depth: 2,
    logger: { debug() {}, info() {}, warn() {} },
    blastRadiusRoot: '/repo',
    logDir: '/tmp/logs',
    serverStartSha: 'test',
    getAutoSwitchSnoozedUntil: () => null,
    knowledgeStore: { setNodeSummary: async () => ({}) },
  }
  const app = express()
  app.use(express.json({ limit: '64kb' }))
  app.use(makeRouter(deps))
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

describe('GET /api/report.md', () => {
  it('returns markdown with an attachment Content-Disposition', async () => {
    const res = await fetch(`${baseUrl}/api/report.md`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/markdown/)
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename=".*\.md"/)
    const md = await res.text()
    expect(md).toContain('# BlastRadius Report')
    expect(md).toContain('## Metrics')
    expect(md).toContain('Knowledge graph') // graph snapshot was built
    // The fake snapshot has an empty nodes Map → no annotations → fallback.
    expect(md).toContain('## Annotations')
    expect(md).toMatch(/No annotations yet/i)
  })

  it('surfaces knowledge-graph annotations when nodes carry summaries/tags', async () => {
    // Swap in a snapshot whose nodes have a summary + tags.
    const nodes = new Map([
      ['src/a.js', { path: 'src/a.js', summary: 'Entry point.', tags: ['core'] }],
      ['src/b.js', { path: 'src/b.js', summary: null, tags: [] }],
    ])
    ctx.knowledgeGraph.getSnapshot = () => ({
      builtAt: Date.now(),
      stats: { nodes: 2, edges: 0, cycles: 0, orphans: 0, withSummary: 1 },
      nodes, cycles: [], orphans: [],
    })
    const res = await fetch(`${baseUrl}/api/report.md`)
    const md = await res.text()
    // a.js is annotated → its summary + tag appear under Annotations.
    expect(md).toContain('Entry point.')
    expect(md).toContain('`core`')
    // b.js has no summary/tags → it must NOT appear in the Annotations
    // section (it may still appear elsewhere, e.g. as a read file, so we
    // scope the negative check to the Annotations section only).
    const annoSection = md.slice(md.indexOf('## Annotations'))
    expect(annoSection).toContain('src/a.js')
    expect(annoSection).not.toContain('src/b.js')
  })

  it('accepts a window param', async () => {
    const res = await fetch(`${baseUrl}/api/report.md?window=hour`)
    expect(res.status).toBe(200)
    const md = await res.text()
    expect(md).toContain('hour')
  })
})

describe('GET /api/report.html', () => {
  it('returns an inline HTML document', async () => {
    const res = await fetch(`${baseUrl}/api/report.html`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    // inline, NOT an attachment (so the browser renders it for Ctrl+P)
    expect(res.headers.get('content-disposition')).toBeNull()
    const html = await res.text()
    expect(html).toMatch(/^<!doctype html>/i)
    expect(html).toContain('BlastRadius Report')
  })
})

describe('report routes — no active repo', () => {
  it('returns 503 when there is no repo context', async () => {
    const deps = {
      getRepoContext: () => null,
      eventStore: { getEvents: () => [], getEventsForRepo: () => [], listDaysWithActivity: async () => [] },
      iterationMarker: { get: () => null, getIso: () => null },
      preferences: { get: () => ({ currentRepo: null, parentDir: null, autoSwitch: false, needsSetup: true }) },
      repoDetector: () => null,
      depth: 2,
      logger: { debug() {}, info() {}, warn() {} },
      blastRadiusRoot: '/repo',
      logDir: '/tmp/logs',
      serverStartSha: 'test',
      getAutoSwitchSnoozedUntil: () => null,
    }
    const app = express()
    app.use(express.json())
    app.use(makeRouter(deps))
    const sub = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    try {
      const { port } = sub.address()
      const res = await fetch(`http://127.0.0.1:${port}/api/report.md`)
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.error).toBe('no_active_repo')
    } finally {
      await new Promise((resolve) => sub.close(resolve))
    }
  })
})
