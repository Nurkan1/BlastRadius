/**
 * BlastRadius MCP stats — unit tests.
 *
 * Covers the in-memory counter shape, the byName / byClient
 * breakdowns, the SSE-debounced flush callback, and the defensive
 * resilience invariants the recorder claims (must not throw on
 * malformed input).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { recordCall, getStats, onStatsUpdate, _resetForTests } from '../../src/mcp/stats.js'

describe('mcp/stats — recording', () => {
  beforeEach(() => _resetForTests())

  it('starts with a clean slate', () => {
    const s = getStats()
    expect(s.totals).toEqual({ tools: 0, resources: 0, other: 0, total: 0 })
    expect(s.byName).toEqual([])
    expect(s.byClient).toEqual([])
    expect(s.lastRequestAt).toBeNull()
    // startedAt is ISO and parses to a valid Date.
    expect(Number.isFinite(Date.parse(s.startedAt))).toBe(true)
  })

  it('records tools/call under tool:<name>', () => {
    recordCall({ method: 'tools/call', name: 'get_iteration_summary' })
    recordCall({ method: 'tools/call', name: 'get_iteration_summary' })
    recordCall({ method: 'tools/call', name: 'summarize_progress' })
    const s = getStats()
    expect(s.totals).toMatchObject({ tools: 3, resources: 0, other: 0, total: 3 })
    expect(s.byName).toEqual([
      { key: 'tool:get_iteration_summary', count: 2 },
      { key: 'tool:summarize_progress', count: 1 },
    ])
  })

  it('records resources/read under resource:<uri>', () => {
    recordCall({ method: 'resources/read', name: 'blastradius://health' })
    recordCall({ method: 'resources/read', name: 'blastradius://heat/session' })
    const s = getStats()
    expect(s.totals).toMatchObject({ resources: 2, total: 2 })
    expect(s.byName.map((e) => e.key).sort()).toEqual([
      'resource:blastradius://health',
      'resource:blastradius://heat/session',
    ])
  })

  it('counts initialize calls under "other" and captures clientInfo.name', () => {
    recordCall({ method: 'initialize', clientName: 'claude-ai' })
    recordCall({ method: 'initialize', clientName: 'claude-ai' })
    recordCall({ method: 'initialize', clientName: 'antigravity' })
    const s = getStats()
    expect(s.totals.other).toBe(3)
    expect(s.totals.total).toBe(3)
    expect(s.byClient).toEqual([
      { name: 'claude-ai', count: 2 },
      { name: 'antigravity', count: 1 },
    ])
  })

  it('sorts byName descending by count', () => {
    recordCall({ method: 'tools/call', name: 'a' })
    recordCall({ method: 'tools/call', name: 'b' })
    recordCall({ method: 'tools/call', name: 'b' })
    recordCall({ method: 'tools/call', name: 'b' })
    recordCall({ method: 'tools/call', name: 'c' })
    recordCall({ method: 'tools/call', name: 'c' })
    const s = getStats()
    expect(s.byName.map((e) => `${e.key.replace('tool:', '')}=${e.count}`)).toEqual([
      'b=3', 'c=2', 'a=1',
    ])
  })

  it('updates lastRequestAt on every call', async () => {
    expect(getStats().lastRequestAt).toBeNull()
    recordCall({ method: 'tools/call', name: 'x' })
    const first = getStats().lastRequestAt
    expect(first).not.toBeNull()
    await new Promise((r) => setTimeout(r, 5))
    recordCall({ method: 'tools/call', name: 'y' })
    const second = getStats().lastRequestAt
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first))
  })
})

describe('mcp/stats — defensive failure isolation', () => {
  beforeEach(() => _resetForTests())

  it('does not throw on missing method', () => {
    expect(() => recordCall({ name: 'foo' })).not.toThrow()
    // Still recorded as "other" because we incremented total.
    expect(getStats().totals.other).toBe(1)
  })

  it('does not throw on empty argument object', () => {
    expect(() => recordCall({})).not.toThrow()
    expect(() => recordCall()).not.toThrow()
    expect(getStats().totals.total).toBe(2)
  })

  it('does not throw on non-string method', () => {
    expect(() => recordCall({ method: 42, name: 'x' })).not.toThrow()
  })
})

describe('mcp/stats — SSE-debounced flush', () => {
  beforeEach(() => {
    _resetForTests()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('coalesces a burst of recordCall into a single onStatsUpdate fire', () => {
    const onUpdate = vi.fn()
    onStatsUpdate(onUpdate)

    for (let i = 0; i < 25; i++) {
      recordCall({ method: 'tools/call', name: `t${i}` })
    }
    // Nothing fires synchronously — the flush is debounced 500ms.
    expect(onUpdate).not.toHaveBeenCalled()

    vi.advanceTimersByTime(499)
    expect(onUpdate).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2)
    expect(onUpdate).toHaveBeenCalledTimes(1)

    const snapshot = onUpdate.mock.calls[0][0]
    expect(snapshot.totals.tools).toBe(25)
    expect(snapshot.byName).toHaveLength(25)
  })

  it('schedules a new flush after a previous one completes', () => {
    const onUpdate = vi.fn()
    onStatsUpdate(onUpdate)

    recordCall({ method: 'tools/call', name: 'a' })
    vi.advanceTimersByTime(600)
    expect(onUpdate).toHaveBeenCalledTimes(1)

    recordCall({ method: 'tools/call', name: 'b' })
    expect(onUpdate).toHaveBeenCalledTimes(1) // still pending
    vi.advanceTimersByTime(600)
    expect(onUpdate).toHaveBeenCalledTimes(2)
  })

  it('swallows handler exceptions to protect the recorder path', () => {
    onStatsUpdate(() => { throw new Error('handler exploded') })
    recordCall({ method: 'tools/call', name: 'x' })
    // Advancing timers must not bubble the handler's throw.
    expect(() => vi.advanceTimersByTime(600)).not.toThrow()
  })
})
