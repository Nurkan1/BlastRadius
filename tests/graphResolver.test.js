import { describe, it, expect, beforeAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { build, consumersOf, isSourceFile } from '../src/server/graphResolver.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(__dirname, 'fixtures', 'sample-repo')

// ─── build() against the real fixture repo ───────────────────────────────────
//
// The fixture has a linear chain a → b → c, plus d as an island.
// Reverse graph:    c → {b},   b → {a},   d → {},   a → {}

describe('build(fixture)', () => {
  let graph
  beforeAll(async () => {
    graph = await build(FIXTURE)
  }, 30_000) // cruise + ts parser load can take 1-2s on first run

  it('returns a graph with forward and reverse Maps', () => {
    expect(graph.forward).toBeInstanceOf(Map)
    expect(graph.reverse).toBeInstanceOf(Map)
    expect(typeof graph.builtAt).toBe('number')
    expect(graph.builtAt).toBeGreaterThan(0)
  })

  it('discovers all four source files', () => {
    const keys = [...graph.forward.keys()].sort()
    expect(keys).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'])
  })

  it('forward edges are correct (a→b→c, d isolated)', () => {
    expect([...graph.forward.get('src/a.ts')]).toEqual(['src/b.ts'])
    expect([...graph.forward.get('src/b.ts')]).toEqual(['src/c.ts'])
    expect([...graph.forward.get('src/c.ts')]).toEqual([])
    expect([...graph.forward.get('src/d.ts')]).toEqual([])
  })

  it('reverse edges mirror the forward graph', () => {
    expect([...(graph.reverse.get('src/b.ts') ?? new Set())]).toEqual(['src/a.ts'])
    expect([...(graph.reverse.get('src/c.ts') ?? new Set())]).toEqual(['src/b.ts'])
    // a and d have no consumers — may be absent from the reverse map entirely.
    expect(graph.reverse.get('src/a.ts') ?? new Set()).toEqual(new Set())
    expect(graph.reverse.get('src/d.ts') ?? new Set()).toEqual(new Set())
  })

  it('stats expose module + edge counts', () => {
    expect(graph.stats.modules).toBe(4)
    expect(graph.stats.edges).toBe(2) // a→b, b→c
  })
})

// ─── consumersOf — BFS over the fixture-derived graph ────────────────────────

describe('consumersOf (BFS depth)', () => {
  let graph
  beforeAll(async () => {
    graph = await build(FIXTURE)
  }, 30_000)

  it('depth=1 from c returns only direct importer {b}', () => {
    const out = consumersOf(graph, 'src/c.ts', 1)
    expect([...out].sort()).toEqual(['src/b.ts'])
  })

  it('depth=2 from c returns {b, a}', () => {
    const out = consumersOf(graph, 'src/c.ts', 2)
    expect([...out].sort()).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('depth=3 from c returns the same {b, a} (chain only has 2 levels)', () => {
    const out = consumersOf(graph, 'src/c.ts', 3)
    expect([...out].sort()).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('depth=10 from c returns the same {b, a} (clamp + chain exhaustion)', () => {
    const out = consumersOf(graph, 'src/c.ts', 10)
    expect([...out].sort()).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('isolated file d has zero consumers at any depth', () => {
    expect(consumersOf(graph, 'src/d.ts', 1).size).toBe(0)
    expect(consumersOf(graph, 'src/d.ts', 2).size).toBe(0)
    expect(consumersOf(graph, 'src/d.ts', 3).size).toBe(0)
  })

  it('top-of-chain file a has zero consumers', () => {
    expect(consumersOf(graph, 'src/a.ts', 2).size).toBe(0)
  })

  it('starting node is never included in result', () => {
    const out = consumersOf(graph, 'src/c.ts', 3)
    expect(out.has('src/c.ts')).toBe(false)
  })
})

// ─── consumersOf — synthetic graphs for edge cases ──────────────────────────

describe('consumersOf — synthetic graphs', () => {
  function makeGraph(edges) {
    // edges: array of [from, to] meaning "from depends on to"
    const forward = new Map()
    const reverse = new Map()
    for (const [from, to] of edges) {
      if (!forward.has(from)) forward.set(from, new Set())
      forward.get(from).add(to)
      if (!reverse.has(to)) reverse.set(to, new Set())
      reverse.get(to).add(from)
    }
    return { forward, reverse, builtAt: Date.now() }
  }

  it('handles a 2-node cycle without infinite loop', () => {
    // a ↔ b: a depends on b AND b depends on a
    const graph = makeGraph([['a', 'b'], ['b', 'a']])
    const fromA = consumersOf(graph, 'a', 10)
    expect([...fromA]).toEqual(['b']) // b is the only consumer of a (other than self)
    expect(fromA.has('a')).toBe(false)
  })

  it('handles a 3-node cycle', () => {
    const graph = makeGraph([['a', 'b'], ['b', 'c'], ['c', 'a']])
    const out = consumersOf(graph, 'a', 10)
    // a is imported by c, c by b, b by a (but a is the start, excluded)
    expect([...out].sort()).toEqual(['b', 'c'])
  })

  it('returns empty set when path is not in the reverse map', () => {
    const graph = makeGraph([['a', 'b']])
    expect(consumersOf(graph, 'nonexistent.ts', 2).size).toBe(0)
  })

  it('returns empty set when graph is null', () => {
    expect(consumersOf(null, 'a', 2).size).toBe(0)
  })

  it('returns empty set when graph.reverse is missing/wrong type', () => {
    expect(consumersOf({}, 'a', 2).size).toBe(0)
    expect(consumersOf({ reverse: 'oops' }, 'a', 2).size).toBe(0)
  })

  it('returns empty set when path is empty/null/undefined', () => {
    const graph = makeGraph([['a', 'b']])
    expect(consumersOf(graph, '', 2).size).toBe(0)
    expect(consumersOf(graph, null, 2).size).toBe(0)
    expect(consumersOf(graph, undefined, 2).size).toBe(0)
  })

  it('clamps depth to a safe range', () => {
    const graph = makeGraph([['a', 'b']])
    expect(() => consumersOf(graph, 'b', 0)).not.toThrow()
    expect(() => consumersOf(graph, 'b', -5)).not.toThrow()
    expect(() => consumersOf(graph, 'b', 9999)).not.toThrow()
    expect(() => consumersOf(graph, 'b', NaN)).not.toThrow()
    expect(() => consumersOf(graph, 'b', 'two')).not.toThrow()
  })

  it('Windows-style start path is normalized before lookup', () => {
    const graph = makeGraph([['src/x.ts', 'src/y.ts']])
    const out = consumersOf(graph, 'src\\y.ts', 1)
    expect([...out]).toEqual(['src/x.ts'])
  })

  it('handles a wide fan-in (many importers of one file)', () => {
    const graph = makeGraph([
      ['a', 'core'], ['b', 'core'], ['c', 'core'], ['d', 'core'], ['e', 'core'],
    ])
    const out = consumersOf(graph, 'core', 1)
    expect(out.size).toBe(5)
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

// ─── isSourceFile ────────────────────────────────────────────────────────────

describe('isSourceFile', () => {
  it.each([
    ['src/a.ts', true],
    ['src/a.tsx', true],
    ['src/a.js', true],
    ['src/a.jsx', true],
    ['src/a.mjs', true],
    ['src/a.cjs', true],
    ['src/a.d.ts', true],     // .ts suffix still wins
    ['README.md', false],
    ['package.json', false],
    ['src/a.css', false],
    ['', false],
  ])('isSourceFile(%j) === %s', (p, expected) => {
    expect(isSourceFile(p)).toBe(expected)
  })
})
