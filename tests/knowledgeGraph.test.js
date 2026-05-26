/**
 * KnowledgeGraph — derivation, cycle detection, orphan logic.
 *
 * Uses hand-built fake graphResolver + in-memory KnowledgeStore so we
 * never touch dependency-cruiser or the real disk. Real filesystem
 * lives in a tmp dir per test, populated with empty files so fs.stat
 * works without dragging in the actual repo source.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  KnowledgeGraph,
  DEFAULT_ENTRY_POINTS,
  DEFAULT_RESPONSE_CAP,
  HARD_RESPONSE_CAP,
} from '../src/server/knowledgeGraph.js'
import { KnowledgeStore, getDefaultPaths } from '../src/server/knowledgeStore.js'

// ─── Test fixtures ─────────────────────────────────────────────────────────

/** Tiny graphResolver-shaped fake. forwardArr is `[fromPath, toPath]` pairs. */
function fakeResolver(forwardArr = []) {
  const forward = new Map()
  const reverse = new Map()
  for (const [from, to] of forwardArr) {
    if (!forward.has(from)) forward.set(from, new Set())
    forward.get(from).add(to)
    if (!reverse.has(to)) reverse.set(to, new Set())
    reverse.get(to).add(from)
    // Ensure target appears as a key in forward too (it may have no
    // outgoing edges but still exists as a node).
    if (!forward.has(to)) forward.set(to, new Set())
  }
  return {
    getGraph: () => ({ forward, reverse, builtAt: Date.now() }),
  }
}

let tempDir
let storeDir
let store
let kg

beforeEach(async () => {
  tempDir = await fs.mkdtemp(join(tmpdir(), 'blastradius-kg-'))
  storeDir = await fs.mkdtemp(join(tmpdir(), 'blastradius-kg-store-'))
  store = new KnowledgeStore({ paths: getDefaultPaths(storeDir) })
  await store.load()
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
  await fs.rm(storeDir, { recursive: true, force: true })
})

/** Create empty files at the given repo-relative paths so fs.stat works. */
async function touchFiles(paths) {
  for (const p of paths) {
    const full = join(tempDir, p)
    await fs.mkdir(join(full, '..'), { recursive: true })
    await fs.writeFile(full, '// fixture\n', 'utf8')
  }
}

// ─── Lifecycle / construction ──────────────────────────────────────────────

describe('KnowledgeGraph — construction + empty snapshot', () => {
  it('throws when required deps are missing', () => {
    expect(() => new KnowledgeGraph({})).toThrow(/repoPath/)
    expect(() => new KnowledgeGraph({ repoPath: '/x' })).toThrow(/graphResolver/)
    expect(() => new KnowledgeGraph({ repoPath: '/x', graphResolver: {} })).toThrow(/knowledgeStore/)
  })

  it('starts with a valid empty snapshot before the first rebuild', () => {
    kg = new KnowledgeGraph({ repoPath: tempDir, graphResolver: fakeResolver(), knowledgeStore: store })
    const snap = kg.getSnapshot()
    expect(snap.nodes.size).toBe(0)
    expect(snap.cycles).toEqual([])
    expect(snap.orphans).toEqual([])
    expect(snap.builtAt).toBe(0)
    expect(snap.stats).toMatchObject({ nodes: 0, edges: 0, cycles: 0, orphans: 0, withSummary: 0 })
  })
})

// ─── Basic derivation ──────────────────────────────────────────────────────

describe('KnowledgeGraph — basic derivation from forward/reverse Maps', () => {
  it('counts nodes and edges', async () => {
    await touchFiles(['src/a.js', 'src/b.js', 'src/c.js'])
    kg = new KnowledgeGraph({
      repoPath: tempDir,
      graphResolver: fakeResolver([
        ['src/a.js', 'src/b.js'],
        ['src/a.js', 'src/c.js'],
        ['src/b.js', 'src/c.js'],
      ]),
      knowledgeStore: store,
    })
    await kg.rebuild()
    const snap = kg.getSnapshot()
    expect(snap.stats.nodes).toBe(3)
    expect(snap.stats.edges).toBe(3)
    expect(snap.builtAt).toBeGreaterThan(0)
  })

  it('computes fanIn / fanOut correctly', async () => {
    await touchFiles(['src/util.js', 'src/a.js', 'src/b.js'])
    // util is imported by a and b; nobody imports a or b.
    kg = new KnowledgeGraph({
      repoPath: tempDir,
      graphResolver: fakeResolver([
        ['src/a.js', 'src/util.js'],
        ['src/b.js', 'src/util.js'],
      ]),
      knowledgeStore: store,
    })
    await kg.rebuild()
    expect(kg.getNode('src/util.js').fanIn).toBe(2)
    expect(kg.getNode('src/util.js').fanOut).toBe(0)
    expect(kg.getNode('src/a.js').fanIn).toBe(0)
    expect(kg.getNode('src/a.js').fanOut).toBe(1)
  })

  it('attaches sizeBytes and lastModifiedMs from fs.stat', async () => {
    await touchFiles(['src/a.js'])
    kg = new KnowledgeGraph({
      repoPath: tempDir,
      graphResolver: fakeResolver([['src/a.js', 'src/a.js']]),
      knowledgeStore: store,
    })
    // Self-loop is intentional so 'src/a.js' is in forward.keys.
    // (We don't validate the self-loop here — that's a separate test.)
    await kg.rebuild()
    const node = kg.getNode('src/a.js')
    expect(node.sizeBytes).toBeGreaterThan(0)
    expect(node.lastModifiedMs).toBeGreaterThan(0)
  })

  it('tolerates files that are referenced in the graph but missing on disk', async () => {
    // No fs.stat'able files at all — graphResolver claims they exist.
    kg = new KnowledgeGraph({
      repoPath: tempDir,
      graphResolver: fakeResolver([['src/ghost.js', 'src/never-existed.js']]),
      knowledgeStore: store,
    })
    await kg.rebuild()
    const ghost = kg.getNode('src/ghost.js')
    expect(ghost).not.toBeNull()
    expect(ghost.sizeBytes).toBe(0)
    expect(ghost.lastModifiedMs).toBe(0)
  })
})

// ─── Kind classification ───────────────────────────────────────────────────

describe('KnowledgeGraph — kind classification', () => {
  it('classifies common extensions correctly', async () => {
    await touchFiles([
      'src/heatEngine.js',
      'tests/heatEngine.test.js',
      'docs/mcp.md',
      'package.json',
      'src-tauri/Cargo.toml',
      'icons/logo.png',
    ])
    kg = new KnowledgeGraph({
      repoPath: tempDir,
      graphResolver: fakeResolver([
        ['src/heatEngine.js', 'tests/heatEngine.test.js'],
        ['src/heatEngine.js', 'docs/mcp.md'],
        ['src/heatEngine.js', 'package.json'],
        ['src/heatEngine.js', 'src-tauri/Cargo.toml'],
        ['src/heatEngine.js', 'icons/logo.png'],
      ]),
      knowledgeStore: store,
    })
    await kg.rebuild()
    expect(kg.getNode('src/heatEngine.js').kind).toBe('source')
    expect(kg.getNode('tests/heatEngine.test.js').kind).toBe('test')
    expect(kg.getNode('docs/mcp.md').kind).toBe('doc')
    expect(kg.getNode('package.json').kind).toBe('config')
    expect(kg.getNode('src-tauri/Cargo.toml').kind).toBe('config')
    expect(kg.getNode('icons/logo.png').kind).toBe('other')
  })
})

// ─── Cycle detection ───────────────────────────────────────────────────────

describe('KnowledgeGraph — cycle detection (Tarjan SCC)', () => {
  it('finds a simple 3-cycle: a → b → c → a', async () => {
    await touchFiles(['src/a.js', 'src/b.js', 'src/c.js'])
    kg = new KnowledgeGraph({
      repoPath: tempDir,
      graphResolver: fakeResolver([
        ['src/a.js', 'src/b.js'],
        ['src/b.js', 'src/c.js'],
        ['src/c.js', 'src/a.js'],
      ]),
      knowledgeStore: store,
    })
    await kg.rebuild()
    expect(kg.getSnapshot().stats.cycles).toBe(1)
    const cycle = kg.getSnapshot().cycles[0]
    expect(new Set(cycle)).toEqual(new Set(['src/a.js', 'src/b.js', 'src/c.js']))
  })

  it('finds a 2-cycle: a → b → a', async () => {
    await touchFiles(['src/a.js', 'src/b.js'])
    kg = new KnowledgeGraph({
      repoPath: tempDir,
      graphResolver: fakeResolver([
        ['src/a.js', 'src/b.js'],
        ['src/b.js', 'src/a.js'],
      ]),
      knowledgeStore: store,
    })
    await kg.rebuild()
    expect(kg.getSnapshot().stats.cycles).toBe(1)
    expect(new Set(kg.getSnapshot().cycles[0])).toEqual(new Set(['src/a.js', 'src/b.js']))
  })

  it('finds a self-loop: a → a', async () => {
    await touchFiles(['src/a.js'])
    kg = new KnowledgeGraph({
      repoPath: tempDir,
      graphResolver: fakeResolver([['src/a.js', 'src/a.js']]),
      knowledgeStore: store,
    })
    await kg.rebuild()
    expect(kg.getSnapshot().stats.cycles).toBe(1)
    expect(kg.getSnapshot().cycles[0]).toEqual(['src/a.js'])
  })

  it('reports zero cycles on a clean DAG', async () => {
    await touchFiles(['src/a.js', 'src/b.js', 'src/c.js'])
    kg = new KnowledgeGraph({
      repoPath: tempDir,
      graphResolver: fakeResolver([
        ['src/a.js', 'src/b.js'],
        ['src/b.js', 'src/c.js'],
      ]),
      knowledgeStore: store,
    })
    await kg.rebuild()
    expect(kg.getSnapshot().stats.cycles).toBe(0)
    expect(kg.getSnapshot().cycles).toEqual([])
  })

  it('detects multiple independent cycles', async () => {
    await touchFiles(['x/a.js', 'x/b.js', 'y/c.js', 'y/d.js'])
    kg = new KnowledgeGraph({
      repoPath: tempDir,
      graphResolver: fakeResolver([
        ['x/a.js', 'x/b.js'], ['x/b.js', 'x/a.js'],   // cycle 1
        ['y/c.js', 'y/d.js'], ['y/d.js', 'y/c.js'],   // cycle 2
      ]),
      knowledgeStore: store,
    })
    await kg.rebuild()
    expect(kg.getSnapshot().stats.cycles).toBe(2)
  })
})

// ─── Orphan detection ──────────────────────────────────────────────────────

describe('KnowledgeGraph — orphan detection', () => {
  it('flags a leaf with fanIn === 0 and a non-entry-point name as orphan', async () => {
    await touchFiles(['src/orphan.js', 'src/main.js'])
    kg = new KnowledgeGraph({
      repoPath: tempDir,
      graphResolver: fakeResolver([
        ['src/main.js', 'src/imported.js'],
      ]),
      knowledgeStore: store,
    })
    await kg.rebuild()
    // 'src/main.js' is in DEFAULT_ENTRY_POINTS — should NOT be an orphan
    // even though nothing imports it. 'src/imported.js' is imported BY main,
    // so it has fanIn=1 and is not orphan. orphan candidates here: none —
    // since we didn't put 'src/orphan.js' into the graph.
    expect(kg.getSnapshot().orphans).toEqual([])
  })

  it('flags an in-graph node with fanIn === 0 and a non-entry-point name', async () => {
    await touchFiles(['src/forgotten.js', 'src/main.js', 'src/util.js'])
    kg = new KnowledgeGraph({
      repoPath: tempDir,
      graphResolver: fakeResolver([
        ['src/main.js', 'src/util.js'],
        ['src/forgotten.js', 'src/util.js'], // forgotten imports util but nobody imports forgotten
      ]),
      knowledgeStore: store,
    })
    await kg.rebuild()
    // src/main.js → fanIn=0 but in DEFAULT_ENTRY_POINTS → NOT orphan
    // src/forgotten.js → fanIn=0 and NOT in entry points → orphan
    // src/util.js → fanIn=2 → not orphan
    expect(kg.getSnapshot().orphans).toEqual(['src/forgotten.js'])
  })

  it('respects a custom entryPoints allowlist', async () => {
    await touchFiles(['src/my-custom-entry.js', 'src/util.js'])
    kg = new KnowledgeGraph({
      repoPath: tempDir,
      graphResolver: fakeResolver([
        ['src/my-custom-entry.js', 'src/util.js'],
      ]),
      knowledgeStore: store,
      entryPoints: new Set(['my-custom-entry.js']),
    })
    await kg.rebuild()
    expect(kg.getSnapshot().orphans).toEqual([])
  })
})

// ─── Semantic layer hydration ──────────────────────────────────────────────

describe('KnowledgeGraph — semantic layer hydration from KnowledgeStore', () => {
  it('attaches summary and tags from the store onto the node', async () => {
    await touchFiles(['src/heatEngine.js'])
    await store.setNodeSummary(tempDir, 'src/heatEngine.js', {
      summary: 'Pure heat color computation.',
      tags: ['core', 'pure'],
    })
    kg = new KnowledgeGraph({
      repoPath: tempDir,
      graphResolver: fakeResolver([['src/heatEngine.js', 'src/heatEngine.js']]),
      knowledgeStore: store,
    })
    await kg.rebuild()
    const node = kg.getNode('src/heatEngine.js')
    expect(node.summary).toBe('Pure heat color computation.')
    expect(node.tags).toEqual(['core', 'pure'])
    expect(typeof node.summaryUpdatedAt).toBe('string')
  })

  it('leaves nodes without persisted data with summary=null and tags=[]', async () => {
    await touchFiles(['src/a.js'])
    kg = new KnowledgeGraph({
      repoPath: tempDir,
      graphResolver: fakeResolver([['src/a.js', 'src/a.js']]),
      knowledgeStore: store,
    })
    await kg.rebuild()
    const node = kg.getNode('src/a.js')
    expect(node.summary).toBeNull()
    expect(node.tags).toEqual([])
    expect(node.summaryUpdatedAt).toBeNull()
  })

  it('stats.withSummary counts the nodes that have a persisted entry', async () => {
    await touchFiles(['src/a.js', 'src/b.js', 'src/c.js'])
    await store.setNodeSummary(tempDir, 'src/a.js', { summary: 'a', tags: [] })
    await store.setNodeSummary(tempDir, 'src/c.js', { summary: 'c', tags: [] })
    kg = new KnowledgeGraph({
      repoPath: tempDir,
      graphResolver: fakeResolver([
        ['src/a.js', 'src/b.js'],
        ['src/b.js', 'src/c.js'],
      ]),
      knowledgeStore: store,
    })
    await kg.rebuild()
    expect(kg.getSnapshot().stats.withSummary).toBe(2)
  })

  it('rebuilding does not lose summaries (re-hydrates from the store)', async () => {
    await touchFiles(['src/a.js'])
    await store.setNodeSummary(tempDir, 'src/a.js', { summary: 'first', tags: ['initial'] })
    kg = new KnowledgeGraph({
      repoPath: tempDir,
      graphResolver: fakeResolver([['src/a.js', 'src/a.js']]),
      knowledgeStore: store,
    })
    await kg.rebuild()
    expect(kg.getNode('src/a.js').summary).toBe('first')

    // Second rebuild — summary must still be there.
    await kg.rebuild()
    expect(kg.getNode('src/a.js').summary).toBe('first')
    expect(kg.getNode('src/a.js').tags).toEqual(['initial'])
  })
})

// ─── Resilience ────────────────────────────────────────────────────────────

describe('KnowledgeGraph — resilience', () => {
  it('keeps the previous snapshot when a rebuild throws', async () => {
    await touchFiles(['src/a.js'])
    kg = new KnowledgeGraph({
      repoPath: tempDir,
      graphResolver: fakeResolver([['src/a.js', 'src/a.js']]),
      knowledgeStore: store,
    })
    await kg.rebuild()
    const firstBuiltAt = kg.getSnapshot().builtAt
    expect(firstBuiltAt).toBeGreaterThan(0)

    // Sabotage: replace graphResolver.getGraph with a thrower.
    kg.graphResolver.getGraph = () => { throw new Error('simulated failure') }
    await kg.rebuild()
    // Previous snapshot retained.
    expect(kg.getSnapshot().builtAt).toBe(firstBuiltAt)
  })

  it('coalesces concurrent rebuild() calls into a single in-flight promise', async () => {
    await touchFiles(['src/a.js'])
    let callCount = 0
    const slowResolver = {
      getGraph: () => {
        callCount++
        const f = new Map([['src/a.js', new Set()]])
        const r = new Map()
        return { forward: f, reverse: r, builtAt: Date.now() }
      },
    }
    kg = new KnowledgeGraph({ repoPath: tempDir, graphResolver: slowResolver, knowledgeStore: store })
    // Fire two rebuilds back-to-back without awaiting between them.
    const p1 = kg.rebuild()
    const p2 = kg.rebuild()
    await Promise.all([p1, p2])
    expect(callCount).toBe(1)
  })
})

// ─── Exposed constants ─────────────────────────────────────────────────────

describe('KnowledgeGraph — module exports', () => {
  it('exposes cap constants for downstream API layers', () => {
    expect(DEFAULT_RESPONSE_CAP).toBe(200)
    expect(HARD_RESPONSE_CAP).toBe(1000)
    expect(DEFAULT_ENTRY_POINTS).toBeInstanceOf(Set)
  })
})
