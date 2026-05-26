/**
 * BlastRadius MCP stats — unit tests.
 *
 * Covers the in-memory counter shape, the byName / byClient
 * breakdowns, the SSE-debounced flush callback, and the defensive
 * resilience invariants the recorder claims (must not throw on
 * malformed input).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { recordCall, getStats, onStatsUpdate, _resetForTests, MAX_DISTINCT_KEYS } from '../../src/mcp/stats.js'

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

describe('mcp/stats — attribution (the gap audited before rc5)', () => {
  beforeEach(() => _resetForTests())

  it('attributes EVERY call (not just initialize) to a client via UA fallback', () => {
    // Initialize from claude-ai…
    recordCall({ method: 'initialize', clientName: 'claude-ai', userAgent: 'claude-ai/1.0' })
    // …then claude-ai keeps calling tools without sending clientInfo
    // again (which is what MCP clients actually do per spec).
    recordCall({ method: 'tools/call', name: 'get_iteration_summary', userAgent: 'claude-ai/1.0' })
    recordCall({ method: 'tools/call', name: 'get_iteration_summary', userAgent: 'claude-ai/1.0' })
    // Meanwhile a second agent (Antigravity) makes one call.
    recordCall({ method: 'tools/call', name: 'summarize_progress', userAgent: 'Antigravity/0.5' })

    const s = getStats()
    // Total = 4 calls.
    expect(s.totals.total).toBe(4)
    // byClient credits ALL four, not just the initialize.
    expect(s.byClient).toContainEqual({ name: 'claude-ai', count: 3 })
    expect(s.byClient).toContainEqual({ name: 'antigravity', count: 1 })
    // Cross-tab: per-client, per-tool breakdown answers
    // "which agent called which tool how many times".
    const claudeBreakdown = s.byClientByName.find((c) => c.client === 'claude-ai')
    expect(claudeBreakdown.breakdown).toContainEqual({ key: 'tool:get_iteration_summary', count: 2 })
    expect(claudeBreakdown.breakdown).toContainEqual({ key: 'method:initialize', count: 1 })
    const antigravityBreakdown = s.byClientByName.find((c) => c.client === 'antigravity')
    expect(antigravityBreakdown.breakdown).toContainEqual({ key: 'tool:summarize_progress', count: 1 })
  })

  it('recognizes common User-Agent fingerprints', () => {
    const cases = [
      { ua: 'claude-ai/1.0.0', expect: 'claude-ai' },
      { ua: 'ClaudeCode/2.1', expect: 'claude-code' },
      { ua: 'Claude Desktop/1.8555.2', expect: 'claude-desktop' },
      { ua: 'antigravity/0.5', expect: 'antigravity' },
      { ua: 'Gemini-Antigravity', expect: 'antigravity' },
      { ua: 'modelcontextprotocol-typescript-sdk/1.29.0', expect: 'mcp-sdk-client' },
      { ua: 'node', expect: 'node-client' },
      { ua: 'curl/8.0.1', expect: 'manual-cli' },
      { ua: 'PowerShell/7.3', expect: 'manual-cli' },
      { ua: 'definitely-unknown-thing', expect: 'unknown' },
    ]
    for (const { ua, expect: clientName } of cases) {
      _resetForTests()
      recordCall({ method: 'tools/call', name: 'x', userAgent: ua })
      const s = getStats()
      const found = s.byClient.find((c) => c.name === clientName)
      expect(found, `UA "${ua}" should map to "${clientName}"`).toBeDefined()
    }
  })

  it('does NOT credit byClient when no UA and no clientName are provided', () => {
    recordCall({ method: 'tools/call', name: 'foo' })
    const s = getStats()
    expect(s.byClient).toEqual([])
    // But the call is still counted in totals and byName.
    expect(s.totals.tools).toBe(1)
  })

  it('explicit clientName takes precedence over UA fallback', () => {
    recordCall({
      method: 'initialize',
      clientName: 'custom-tool-from-clientinfo',
      userAgent: 'claude-ai/1.0',
    })
    const s = getStats()
    // No "claude-ai" entry — the explicit clientInfo.name wins.
    expect(s.byClient).toEqual([{ name: 'custom-tool-from-clientinfo', count: 1 }])
  })
})

describe('mcp/stats — memory caps (DoS defense)', () => {
  beforeEach(() => _resetForTests())

  it('does not grow byName past MAX_DISTINCT_KEYS', () => {
    for (let i = 0; i < MAX_DISTINCT_KEYS + 30; i++) {
      recordCall({ method: 'tools/call', name: `unique-tool-${i}` })
    }
    const s = getStats()
    expect(s.byName.length).toBe(MAX_DISTINCT_KEYS)
    expect(s.droppedKeys.byName).toBe(30)
    // Totals are still accurate — the cap only affects the breakdown,
    // not the aggregate.
    expect(s.totals.tools).toBe(MAX_DISTINCT_KEYS + 30)
    expect(s.totals.total).toBe(MAX_DISTINCT_KEYS + 30)
  })

  it('keeps incrementing EXISTING keys after the cap is hit', () => {
    // Fill the cap.
    for (let i = 0; i < MAX_DISTINCT_KEYS; i++) {
      recordCall({ method: 'tools/call', name: `t${i}` })
    }
    // Existing key, post-cap.
    recordCall({ method: 'tools/call', name: 't0' })
    recordCall({ method: 'tools/call', name: 't0' })
    // New key, post-cap.
    recordCall({ method: 'tools/call', name: 'overflow' })

    const s = getStats()
    expect(s.byName.length).toBe(MAX_DISTINCT_KEYS)
    const t0 = s.byName.find((e) => e.key === 'tool:t0')
    expect(t0.count).toBe(3) // 1 + 2 increments
    expect(s.byName.find((e) => e.key === 'tool:overflow')).toBeUndefined()
    expect(s.droppedKeys.byName).toBe(1)
  })

  it('caps byClient independently from byName', () => {
    // Use explicit clientName (the path attackers don't normally have,
    // but the cap still defends in case the agent registry grows
    // legitimately past the limit). UAs would be normalized to "unknown"
    // — the cap test for that path is implicit in this same test as
    // the byClient remains at size 1.
    for (let i = 0; i < MAX_DISTINCT_KEYS + 10; i++) {
      recordCall({ method: 'initialize', clientName: `client-${i}` })
    }
    const s = getStats()
    expect(s.byClient.length).toBe(MAX_DISTINCT_KEYS)
    expect(s.droppedKeys.byClient).toBe(10)
    // byName has only one entry (method:initialize), well under cap.
    expect(s.byName.find((e) => e.key === 'method:initialize').count).toBe(MAX_DISTINCT_KEYS + 10)
  })

  it('normalizes ALL unknown User-Agents to a single "unknown" bucket (privacy)', () => {
    // 50 unique unknown UAs collapse to ONE byClient entry.
    for (let i = 0; i < 50; i++) {
      recordCall({ method: 'tools/call', name: 'x', userAgent: `random-bot-${i}` })
    }
    const s = getStats()
    expect(s.byClient).toEqual([{ name: 'unknown', count: 50 }])
    expect(s.droppedKeys.byClient).toBe(0)
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
