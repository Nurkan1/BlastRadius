import { describe, it, expect } from 'vitest'
import { computeHeat, canonicalKey, resolveWindow } from '../src/server/heatEngine.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOW = new Date('2026-05-24T12:00:00.000Z')

/** Build a touch event at `now - offsetMs`. */
function ev({ tool = 'Edit', path = 'src/a.ts', offsetMs = 0, sessionId = 'sid' } = {}) {
  return {
    ts: new Date(NOW.getTime() - offsetMs).toISOString(),
    tool,
    path: `/abs/${path}`,
    pathNorm: path,
    cwd: '/abs',
    hash: 'sha256:x',
    sessionId,
  }
}

// ─── Suite 1: Per-file color rules ───────────────────────────────────────────

describe('color rules', () => {
  it('Edit makes file red', () => {
    const { files } = computeHeat({ events: [ev({ tool: 'Edit' })], now: NOW })
    expect(files['src/a.ts']).toBe('red')
  })

  it('Write makes file red', () => {
    const { files } = computeHeat({ events: [ev({ tool: 'Write' })], now: NOW })
    expect(files['src/a.ts']).toBe('red')
  })

  it('Read-only makes file orange', () => {
    const { files } = computeHeat({ events: [ev({ tool: 'Read' })], now: NOW })
    expect(files['src/a.ts']).toBe('orange')
  })

  it('Read then Edit → red (Edit wins regardless of order)', () => {
    const { files } = computeHeat({
      events: [ev({ tool: 'Read', offsetMs: 60_000 }), ev({ tool: 'Edit', offsetMs: 1_000 })],
      now: NOW,
    })
    expect(files['src/a.ts']).toBe('red')
  })

  it('Edit then Read → red (Edit wins even when Read is more recent)', () => {
    const { files } = computeHeat({
      events: [ev({ tool: 'Edit', offsetMs: 60_000 }), ev({ tool: 'Read', offsetMs: 1_000 })],
      now: NOW,
    })
    expect(files['src/a.ts']).toBe('red')
  })

  it('Read + Write → red', () => {
    const { files } = computeHeat({
      events: [ev({ tool: 'Read' }), ev({ tool: 'Write' })],
      now: NOW,
    })
    expect(files['src/a.ts']).toBe('red')
  })

  it('three Reads stay orange (no Edit/Write to upgrade)', () => {
    const { files } = computeHeat({
      events: [
        ev({ tool: 'Read', offsetMs: 3_000 }),
        ev({ tool: 'Read', offsetMs: 2_000 }),
        ev({ tool: 'Read', offsetMs: 1_000 }),
      ],
      now: NOW,
    })
    expect(files['src/a.ts']).toBe('orange')
  })

  it('no file is ever labeled "yellow" in Phase 2', () => {
    const events = [
      ev({ tool: 'Edit', path: 'a.ts' }),
      ev({ tool: 'Read', path: 'b.ts' }),
      ev({ tool: 'Write', path: 'c.ts' }),
    ]
    const { files, metrics } = computeHeat({ events, now: NOW })
    expect(Object.values(files)).not.toContain('yellow')
    expect(metrics.yellow).toBe(0)
  })
})

// ─── Suite 2: Window filtering ───────────────────────────────────────────────

describe('windows', () => {
  it('iteration: event 2 min ago is included', () => {
    const { files } = computeHeat({
      events: [ev({ tool: 'Edit', offsetMs: 2 * 60_000 })],
      window: 'iteration',
      now: NOW,
    })
    expect(files['src/a.ts']).toBe('red')
  })

  it('iteration: event 4 min ago is excluded', () => {
    const { files } = computeHeat({
      events: [ev({ tool: 'Edit', offsetMs: 4 * 60_000 })],
      window: 'iteration',
      now: NOW,
    })
    expect(files['src/a.ts']).toBeUndefined()
  })

  it('iteration: exact 3 min boundary is included (>= inclusive)', () => {
    const { files } = computeHeat({
      events: [ev({ tool: 'Edit', offsetMs: 3 * 60_000 })],
      window: 'iteration',
      now: NOW,
    })
    expect(files['src/a.ts']).toBe('red')
  })

  it('hour: event 30 min ago is included', () => {
    const { files } = computeHeat({
      events: [ev({ tool: 'Edit', offsetMs: 30 * 60_000 })],
      window: 'hour',
      now: NOW,
    })
    expect(files['src/a.ts']).toBe('red')
  })

  it('hour: event 70 min ago is excluded', () => {
    const { files } = computeHeat({
      events: [ev({ tool: 'Edit', offsetMs: 70 * 60_000 })],
      window: 'hour',
      now: NOW,
    })
    expect(files['src/a.ts']).toBeUndefined()
  })

  it('session: event 5 hours ago is included (no time filter)', () => {
    const { files } = computeHeat({
      events: [ev({ tool: 'Edit', offsetMs: 5 * 60 * 60_000 })],
      window: 'session',
      now: NOW,
    })
    expect(files['src/a.ts']).toBe('red')
  })

  it('iteration: Edit 5min ago + Read 1min ago → orange (Edit outside window)', () => {
    const { files } = computeHeat({
      events: [
        ev({ tool: 'Edit', path: 'x.ts', offsetMs: 5 * 60_000 }),
        ev({ tool: 'Read', path: 'x.ts', offsetMs: 1 * 60_000 }),
      ],
      window: 'iteration',
      now: NOW,
    })
    expect(files['x.ts']).toBe('orange')
  })
})

// ─── Suite 3: Metrics + blastRadius ──────────────────────────────────────────

describe('metrics', () => {
  it('zero events → all zeros', () => {
    const { files, metrics } = computeHeat({ events: [], now: NOW, totalFiles: 100 })
    expect(files).toEqual({})
    expect(metrics).toEqual({ red: 0, orange: 0, yellow: 0, total: 0, blastRadius: 0 })
  })

  it('3 red + 2 orange with totalFiles=100 → blastRadius=5', () => {
    const events = [
      ev({ tool: 'Edit', path: 'a.ts' }),
      ev({ tool: 'Edit', path: 'b.ts' }),
      ev({ tool: 'Write', path: 'c.ts' }),
      ev({ tool: 'Read', path: 'd.ts' }),
      ev({ tool: 'Read', path: 'e.ts' }),
    ]
    const { metrics } = computeHeat({ events, now: NOW, totalFiles: 100 })
    expect(metrics.red).toBe(3)
    expect(metrics.orange).toBe(2)
    expect(metrics.total).toBe(5)
    expect(metrics.blastRadius).toBe(5)
  })

  it('totalFiles=0 → blastRadius=0 (no division by zero)', () => {
    const events = [ev({ tool: 'Edit' })]
    const { metrics } = computeHeat({ events, now: NOW, totalFiles: 0 })
    expect(metrics.blastRadius).toBe(0)
  })

  it('total counts unique files, not events (3 Reads on same file → total: 1)', () => {
    const events = [
      ev({ tool: 'Read', offsetMs: 3000 }),
      ev({ tool: 'Read', offsetMs: 2000 }),
      ev({ tool: 'Read', offsetMs: 1000 }),
    ]
    const { metrics } = computeHeat({ events, now: NOW, totalFiles: 100 })
    expect(metrics.total).toBe(1)
  })

  it('blastRadius rounds to nearest integer', () => {
    // 5 of 333 → 1.5015% → rounds to 2
    const events = [
      ev({ tool: 'Edit', path: 'a' }),
      ev({ tool: 'Edit', path: 'b' }),
      ev({ tool: 'Edit', path: 'c' }),
      ev({ tool: 'Edit', path: 'd' }),
      ev({ tool: 'Edit', path: 'e' }),
    ]
    const { metrics } = computeHeat({ events, now: NOW, totalFiles: 333 })
    expect(metrics.blastRadius).toBe(2)
  })
})

// ─── Suite 4: Path normalization ─────────────────────────────────────────────

describe('path normalization', () => {
  it('canonicalKey converts backslashes to forward slashes', () => {
    expect(canonicalKey('src\\useBatch.ts')).toBe('src/useBatch.ts')
  })

  it('canonicalKey handles null/undefined', () => {
    expect(canonicalKey(null)).toBe('')
    expect(canonicalKey(undefined)).toBe('')
  })

  it('events with Windows-style + Unix-style paths collapse to one key', () => {
    const events = [
      { ...ev({ tool: 'Read' }), pathNorm: 'src/a.ts' },
      { ...ev({ tool: 'Edit' }), pathNorm: 'src\\a.ts' },
    ]
    const { files, metrics } = computeHeat({ events, now: NOW, totalFiles: 10 })
    expect(Object.keys(files)).toEqual(['src/a.ts'])
    expect(metrics.total).toBe(1)
    expect(files['src/a.ts']).toBe('red')
  })

  it('events with empty pathNorm are ignored', () => {
    const events = [
      { ...ev({ tool: 'Edit' }), pathNorm: '' },
      { ...ev({ tool: 'Edit' }), pathNorm: null },
    ]
    const { metrics } = computeHeat({ events, now: NOW, totalFiles: 10 })
    expect(metrics.total).toBe(0)
  })
})

// ─── Suite 5: No-throw under weird input ─────────────────────────────────────

describe('no-throw under any input', () => {
  it('events: undefined', () => {
    expect(() => computeHeat({ events: undefined, now: NOW })).not.toThrow()
  })

  it('events: null', () => {
    const r = computeHeat({ events: null, now: NOW })
    expect(r.metrics.total).toBe(0)
  })

  it('events: not an array', () => {
    const r = computeHeat({ events: 'oops', now: NOW })
    expect(r.metrics.total).toBe(0)
  })

  it('tool outside set is ignored', () => {
    const events = [{ ...ev({ tool: 'Edit' }), tool: 'Bash' }]
    const r = computeHeat({ events, now: NOW })
    expect(r.metrics.total).toBe(0)
  })

  it('empty event object is ignored', () => {
    const r = computeHeat({ events: [{}], now: NOW })
    expect(r.metrics.total).toBe(0)
  })

  it('invalid ts is ignored', () => {
    const e = { ...ev({ tool: 'Edit' }), ts: 'not-a-date' }
    const r = computeHeat({ events: [e], now: NOW })
    expect(r.metrics.total).toBe(0)
  })

  it('unknown window falls back to session', () => {
    expect(resolveWindow('garbage')).toBe(resolveWindow('session'))
    const r = computeHeat({
      events: [ev({ tool: 'Edit', offsetMs: 24 * 60 * 60_000 })],
      window: 'garbage',
      now: NOW,
    })
    expect(r.metrics.total).toBe(1) // included because falls back to session (no filter)
  })

  it('now: undefined does not throw', () => {
    expect(() => computeHeat({ events: [], now: undefined })).not.toThrow()
  })

  it('now: Invalid Date falls back to current clock', () => {
    expect(() => computeHeat({ events: [], now: new Date('bad') })).not.toThrow()
  })
})

// ─── Suite 6: Performance + determinism ──────────────────────────────────────

describe('performance + determinism', () => {
  it('10k synthetic events run in well under 100ms', () => {
    const events = []
    for (let i = 0; i < 10_000; i += 1) {
      events.push(ev({
        tool: i % 3 === 0 ? 'Edit' : 'Read',
        path: `src/f${i % 200}.ts`,
        offsetMs: (i % 60) * 1000,
      }))
    }
    const t0 = performance.now()
    const r = computeHeat({ events, window: 'hour', now: NOW, totalFiles: 1_000 })
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(100)
    expect(r.metrics.total).toBeGreaterThan(0)
  })

  it('same input twice → identical output (no hidden randomness)', () => {
    const events = [
      ev({ tool: 'Edit', path: 'a' }),
      ev({ tool: 'Read', path: 'b', offsetMs: 30_000 }),
    ]
    const a = computeHeat({ events, window: 'hour', now: NOW, totalFiles: 50 })
    const b = computeHeat({ events, window: 'hour', now: NOW, totalFiles: 50 })
    expect(a).toEqual(b)
  })
})

// ─── Suite 7: treeFiles intersection ─────────────────────────────────────────
//
// The heat engine should never report files that the tree pane can't
// render (gitignored builds, node_modules, files deleted on disk).
// `treeFiles` is the authoritative set of "renderable" paths.

describe('treeFiles intersection', () => {
  it('drops touched files not in the tree set', () => {
    const events = [
      ev({ tool: 'Edit', path: 'src/a.ts' }),         // in tree
      ev({ tool: 'Edit', path: 'dist/bundle.js' }),   // gitignored
      ev({ tool: 'Edit', path: 'node_modules/x.js' }),// hard-ignored
    ]
    const treeFiles = new Set(['src/a.ts', 'src/b.ts'])
    const { files, metrics } = computeHeat({ events, now: NOW, totalFiles: 2, treeFiles })
    expect(Object.keys(files)).toEqual(['src/a.ts'])
    expect(metrics.red).toBe(1)
    expect(metrics.total).toBe(1)
  })

  it('drops orange files not in the tree set', () => {
    const events = [
      ev({ tool: 'Read', path: 'src/a.ts' }),
      ev({ tool: 'Read', path: 'dist/bundle.js' }),
    ]
    const treeFiles = new Set(['src/a.ts'])
    const { files, metrics } = computeHeat({ events, now: NOW, totalFiles: 1, treeFiles })
    expect(Object.keys(files)).toEqual(['src/a.ts'])
    expect(metrics.orange).toBe(1)
  })

  it('empty Set behaves like "no filter" to avoid accidental wipe', () => {
    // Guard against a corner where the tree just finished scanning and
    // the set is momentarily empty. Better to keep showing events than
    // to blank the counter and confuse the user.
    const events = [ev({ tool: 'Edit', path: 'src/a.ts' })]
    const { metrics } = computeHeat({ events, now: NOW, totalFiles: 1, treeFiles: new Set() })
    expect(metrics.red).toBe(1)
  })

  it('null treeFiles → no filter (back-compat)', () => {
    const events = [ev({ tool: 'Edit', path: 'src/a.ts' })]
    const { metrics } = computeHeat({ events, now: NOW, totalFiles: 1, treeFiles: null })
    expect(metrics.red).toBe(1)
  })

  it('filter applies BEFORE yellow propagation seeds', () => {
    // A red event on a gitignored file shouldn't seed yellow ripple
    // either — the user can't see the seed, the ripple is misleading.
    const graph = {
      reverse: new Map([
        ['dist/bundle.js', new Set(['src/consumer.ts'])],
      ]),
    }
    const events = [ev({ tool: 'Edit', path: 'dist/bundle.js' })]
    const treeFiles = new Set(['src/consumer.ts'])
    const { files, metrics } = computeHeat({
      events, now: NOW, totalFiles: 1, treeFiles, graph, depth: 2,
    })
    expect(metrics.red).toBe(0)
    expect(metrics.yellow).toBe(0)
    expect(files).toEqual({})
  })

  it('filters yellow consumers not in the tree set', () => {
    const graph = {
      reverse: new Map([
        ['src/red.ts', new Set(['src/visible.ts', 'dist/hidden.js'])],
      ]),
    }
    const events = [ev({ tool: 'Edit', path: 'src/red.ts' })]
    const treeFiles = new Set(['src/red.ts', 'src/visible.ts'])
    const { files, metrics } = computeHeat({
      events, now: NOW, totalFiles: 2, treeFiles, graph, depth: 2,
    })
    expect(files['src/red.ts']).toBe('red')
    expect(files['src/visible.ts']).toBe('yellow')
    expect(files['dist/hidden.js']).toBeUndefined()
    expect(metrics.yellow).toBe(1)
  })
})
