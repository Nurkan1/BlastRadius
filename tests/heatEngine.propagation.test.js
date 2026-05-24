import { describe, it, expect, beforeAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { computeHeat } from '../src/server/heatEngine.js'
import { build } from '../src/server/graphResolver.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(__dirname, 'fixtures', 'sample-repo')
const NOW = new Date('2026-05-24T12:00:00.000Z')

function ev({ tool = 'Edit', path, offsetMs = 0 } = {}) {
  return {
    ts: new Date(NOW.getTime() - offsetMs).toISOString(),
    tool,
    path: `/abs/${path}`,
    pathNorm: path,
    cwd: '/abs',
    hash: 'sha256:x',
    sessionId: 's1',
  }
}

describe('yellow propagation (integration against fixture)', () => {
  /** @type {Awaited<ReturnType<typeof build>>} */
  let graph
  beforeAll(async () => {
    graph = await build(FIXTURE)
  }, 30_000)

  it('Edit c.ts with depth=1 → b becomes yellow, a stays cold', () => {
    const r = computeHeat({
      events: [ev({ tool: 'Edit', path: 'src/c.ts' })],
      window: 'session',
      now: NOW,
      totalFiles: 4,
      graph,
      depth: 1,
    })
    expect(r.files['src/c.ts']).toBe('red')
    expect(r.files['src/b.ts']).toBe('yellow')
    expect(r.files['src/a.ts']).toBeUndefined()
    expect(r.metrics.red).toBe(1)
    expect(r.metrics.yellow).toBe(1)
    expect(r.metrics.blastRadius).toBe(50) // (1 + 0 + 1) / 4 = 50%
  })

  it('Edit c.ts with depth=2 → both b and a become yellow', () => {
    const r = computeHeat({
      events: [ev({ tool: 'Edit', path: 'src/c.ts' })],
      window: 'session',
      now: NOW,
      totalFiles: 4,
      graph,
      depth: 2,
    })
    expect(r.files['src/c.ts']).toBe('red')
    expect(r.files['src/b.ts']).toBe('yellow')
    expect(r.files['src/a.ts']).toBe('yellow')
    expect(r.metrics.red).toBe(1)
    expect(r.metrics.yellow).toBe(2)
    expect(r.metrics.blastRadius).toBe(75) // (1 + 0 + 2) / 4 = 75%
  })

  it('Edit c.ts with depth=3 stays at {b, a} (chain exhausted)', () => {
    const r = computeHeat({
      events: [ev({ tool: 'Edit', path: 'src/c.ts' })],
      window: 'session',
      now: NOW,
      totalFiles: 4,
      graph,
      depth: 3,
    })
    expect(r.metrics.yellow).toBe(2)
  })

  it('Edit d.ts → zero yellows (d is an island)', () => {
    const r = computeHeat({
      events: [ev({ tool: 'Edit', path: 'src/d.ts' })],
      window: 'session',
      now: NOW,
      totalFiles: 4,
      graph,
      depth: 3,
    })
    expect(r.files['src/d.ts']).toBe('red')
    expect(r.metrics.yellow).toBe(0)
    expect(r.metrics.blastRadius).toBe(25) // 1/4 = 25%
  })

  it('Read c.ts only → no yellow propagation (orange does NOT propagate)', () => {
    const r = computeHeat({
      events: [ev({ tool: 'Read', path: 'src/c.ts' })],
      window: 'session',
      now: NOW,
      totalFiles: 4,
      graph,
      depth: 2,
    })
    expect(r.files['src/c.ts']).toBe('orange')
    expect(r.metrics.yellow).toBe(0)
    expect(r.files['src/b.ts']).toBeUndefined()
    expect(r.files['src/a.ts']).toBeUndefined()
  })

  it('Edit c + Read a → a stays orange (direct color always wins over yellow)', () => {
    const r = computeHeat({
      events: [
        ev({ tool: 'Edit', path: 'src/c.ts' }),
        ev({ tool: 'Read', path: 'src/a.ts' }),
      ],
      window: 'session',
      now: NOW,
      totalFiles: 4,
      graph,
      depth: 2,
    })
    expect(r.files['src/c.ts']).toBe('red')
    expect(r.files['src/a.ts']).toBe('orange') // NOT yellow
    expect(r.files['src/b.ts']).toBe('yellow') // b only gets the inferred color
    expect(r.metrics.red).toBe(1)
    expect(r.metrics.orange).toBe(1)
    expect(r.metrics.yellow).toBe(1)
    expect(r.metrics.blastRadius).toBe(75) // (1 + 1 + 1) / 4
  })

  it('Edit a (top of chain) → no yellow (nothing imports a in fixture)', () => {
    const r = computeHeat({
      events: [ev({ tool: 'Edit', path: 'src/a.ts' })],
      window: 'session',
      now: NOW,
      totalFiles: 4,
      graph,
      depth: 3,
    })
    expect(r.files['src/a.ts']).toBe('red')
    expect(r.metrics.yellow).toBe(0)
  })

  it('Red file not in the graph (e.g. a .md) → no yellow, no crash', () => {
    const r = computeHeat({
      events: [ev({ tool: 'Edit', path: 'README.md' })],
      window: 'session',
      now: NOW,
      totalFiles: 5,
      graph,
      depth: 2,
    })
    expect(r.files['README.md']).toBe('red')
    expect(r.metrics.yellow).toBe(0)
    expect(r.metrics.red).toBe(1)
  })

  it('total counts only directly-touched files (yellows excluded)', () => {
    const r = computeHeat({
      events: [
        ev({ tool: 'Edit', path: 'src/c.ts' }),
        ev({ tool: 'Read', path: 'src/d.ts' }),
      ],
      window: 'session',
      now: NOW,
      totalFiles: 4,
      graph,
      depth: 2,
    })
    expect(r.metrics.total).toBe(2) // c (red) + d (orange); a and b are yellow → NOT counted
    expect(r.metrics.yellow).toBe(2)
  })
})

// ─── Backwards-compat: F2 behavior when graph is absent ─────────────────────

describe('yellow propagation — backward compatible defaults', () => {
  it('no graph passed → no yellow, identical to Phase 2 output', () => {
    const r = computeHeat({
      events: [ev({ tool: 'Edit', path: 'src/c.ts' })],
      window: 'session',
      now: NOW,
      totalFiles: 4,
      // graph: undefined
    })
    expect(r.metrics.yellow).toBe(0)
    expect(r.files['src/c.ts']).toBe('red')
    expect(r.files['src/b.ts']).toBeUndefined()
  })

  it('empty graph (no edges) → no yellow, no crash', () => {
    const emptyGraph = { forward: new Map(), reverse: new Map(), builtAt: 0 }
    const r = computeHeat({
      events: [ev({ tool: 'Edit', path: 'src/c.ts' })],
      window: 'session',
      now: NOW,
      totalFiles: 4,
      graph: emptyGraph,
      depth: 2,
    })
    expect(r.metrics.yellow).toBe(0)
  })

  it('graph with wrong shape → no yellow, no throw', () => {
    expect(() => computeHeat({
      events: [ev({ tool: 'Edit', path: 'src/c.ts' })],
      window: 'session',
      now: NOW,
      totalFiles: 4,
      graph: { reverse: 'not-a-map' },
      depth: 2,
    })).not.toThrow()
  })
})

// ─── Propagation attribution (which red(s) caused each yellow) ──────────────
//
// computeHeat now returns a `propagation` field shaped as:
//   { [yellowPath]: [{ path: redPath, depth: number }, ...] }
// sorted by `depth asc, path asc`. The frontend uses it to answer
// "why is this file yellow?" in the side panel.

describe('yellow propagation — attribution', () => {
  /** @type {Awaited<ReturnType<typeof build>>} */
  let graph
  beforeAll(async () => {
    graph = await build(FIXTURE)
  }, 30_000)

  it('single red → single yellow lists that red at the correct depth', () => {
    const r = computeHeat({
      events: [ev({ tool: 'Edit', path: 'src/c.ts' })],
      window: 'session',
      now: NOW,
      totalFiles: 4,
      graph,
      depth: 2,
    })
    expect(r.propagation).toBeDefined()
    expect(r.propagation['src/b.ts']).toEqual([
      { path: 'src/c.ts', depth: 1 },
    ])
    expect(r.propagation['src/a.ts']).toEqual([
      { path: 'src/c.ts', depth: 2 },
    ])
  })

  // ── MANDATORY: 2 reds → same yellow at DIFFERENT depths ───────────────
  it('2 reds reaching the same yellow at different depths are both listed (sorted by depth)', () => {
    // Fixture chain: a → b → c.
    // Both b and c are red. From b, a is yellow at depth 1.
    // From c, a is yellow at depth 2. Expect propagation['src/a.ts']
    // to contain BOTH origins with their respective depths, ordered
    // by depth asc.
    const r = computeHeat({
      events: [
        ev({ tool: 'Edit', path: 'src/b.ts' }),
        ev({ tool: 'Edit', path: 'src/c.ts' }),
      ],
      window: 'session',
      now: NOW,
      totalFiles: 4,
      graph,
      depth: 2,
    })
    expect(r.files['src/b.ts']).toBe('red')
    expect(r.files['src/c.ts']).toBe('red')
    expect(r.files['src/a.ts']).toBe('yellow')
    expect(r.propagation['src/a.ts']).toEqual([
      { path: 'src/b.ts', depth: 1 },
      { path: 'src/c.ts', depth: 2 },
    ])
  })

  it('non-yellow files do not appear in propagation', () => {
    const r = computeHeat({
      events: [ev({ tool: 'Edit', path: 'src/c.ts' })],
      window: 'session',
      now: NOW,
      totalFiles: 4,
      graph,
      depth: 2,
    })
    // red and orange entries are NOT in propagation
    expect(r.propagation['src/c.ts']).toBeUndefined()
    // cold + missing files: not in propagation
    expect(r.propagation['src/d.ts']).toBeUndefined()
  })

  it('no graph passed → propagation is an empty object, never null', () => {
    const r = computeHeat({
      events: [ev({ tool: 'Edit', path: 'src/c.ts' })],
      window: 'session',
      now: NOW,
      totalFiles: 4,
      // graph: undefined
    })
    expect(r.propagation).toEqual({})
  })

  it('same red reaching the same yellow via two paths records the shortest depth', () => {
    // Synthetic diamond:
    //     A    (red)
    //    / \
    //   B   C
    //    \ /
    //     D
    // Forward: A imports B, A imports C, B imports D, C imports D
    // Reverse: B ← {A}, C ← {A}, D ← {B, C}
    // Editing D: consumers from D = B, C at depth 1; A at depth 2 via
    // BOTH B and C. BFS records A only once at its shortest distance
    // (2). Propagation['A'] should be [{path: 'D', depth: 2}].
    const reverse = new Map([
      ['B.ts', new Set(['A.ts'])],
      ['C.ts', new Set(['A.ts'])],
      ['D.ts', new Set(['B.ts', 'C.ts'])],
    ])
    const diamond = { forward: new Map(), reverse, builtAt: Date.now() }
    const r = computeHeat({
      events: [ev({ tool: 'Edit', path: 'D.ts' })],
      window: 'session',
      now: NOW,
      totalFiles: 4,
      graph: diamond,
      depth: 3,
    })
    expect(r.propagation['A.ts']).toEqual([{ path: 'D.ts', depth: 2 }])
    expect(r.propagation['B.ts']).toEqual([{ path: 'D.ts', depth: 1 }])
    expect(r.propagation['C.ts']).toEqual([{ path: 'D.ts', depth: 1 }])
  })

  it('propagation entries are sorted by (depth asc, path asc) for stable rendering', () => {
    // Two reds at the SAME depth → sort tie-broken by path.
    // Synthetic: editing X and Y, both depth-1 consumers point at Z.
    const reverse = new Map([
      ['X.ts', new Set(['Z.ts'])],
      ['Y.ts', new Set(['Z.ts'])],
    ])
    const graphLocal = { forward: new Map(), reverse, builtAt: Date.now() }
    const r = computeHeat({
      events: [
        ev({ tool: 'Edit', path: 'X.ts' }),
        ev({ tool: 'Edit', path: 'Y.ts' }),
      ],
      window: 'session',
      now: NOW,
      totalFiles: 3,
      graph: graphLocal,
      depth: 2,
    })
    expect(r.propagation['Z.ts']).toEqual([
      { path: 'X.ts', depth: 1 },
      { path: 'Y.ts', depth: 1 },
    ])
  })

  it('propagation honors the treeFiles filter (no entries for hidden yellows)', () => {
    const r = computeHeat({
      events: [ev({ tool: 'Edit', path: 'src/c.ts' })],
      window: 'session',
      now: NOW,
      totalFiles: 4,
      graph,
      depth: 2,
      // Only src/b.ts is in the tree set; src/a.ts is excluded.
      treeFiles: new Set(['src/c.ts', 'src/b.ts']),
    })
    expect(r.propagation['src/b.ts']).toEqual([
      { path: 'src/c.ts', depth: 1 },
    ])
    expect(r.propagation['src/a.ts']).toBeUndefined()
    expect(r.files['src/a.ts']).toBeUndefined()
  })
})

// ─── Cycle robustness via synthetic graph ───────────────────────────────────

describe('yellow propagation — cycle robustness', () => {
  it('artificial a↔b cycle does not infinite-loop and yields a finite set', () => {
    const reverse = new Map([
      ['a.ts', new Set(['b.ts'])],
      ['b.ts', new Set(['a.ts'])],
    ])
    const graph = { forward: new Map(), reverse, builtAt: Date.now() }
    const r = computeHeat({
      events: [ev({ tool: 'Edit', path: 'a.ts' })],
      window: 'session',
      now: NOW,
      totalFiles: 2,
      graph,
      depth: 10,
    })
    // a is red; b is the only consumer (the cycle returns to a but a is
    // already visited so it's never re-added or downgraded).
    expect(r.files['a.ts']).toBe('red')
    expect(r.files['b.ts']).toBe('yellow')
    expect(r.metrics.yellow).toBe(1)
  })
})
