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
