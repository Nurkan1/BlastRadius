import { describe, it, expect } from 'vitest'
import {
  inferAgent,
  agentDisplayName,
  AGENT_CLAUDE,
  AGENT_ANTIGRAVITY,
  AGENT_MANUAL,
  AGENT_DISPLAY,
  LEGACY_ANTIGRAVITY_SESSION_ID,
} from '../src/server/agentInference.js'

// ─── Cascade — Design decision 1 in docs/antigravity-audit.md ────────────────
//
// The 8 cases below mirror the matrix in the design-decisions section
// row-for-row. If any of these flip, the audit doc needs updating too.

describe('inferAgent — back-compat cascade', () => {
  it('1. legacy Claude event with no agent field → "claude"', () => {
    // Pre-refactor JSONL written by Claude Code's PostToolUse hook.
    // The historical "Claude" UI filter must keep matching these.
    const ev = {
      ts: '2026-05-24T12:00:00.000Z',
      tool: 'Edit',
      path: '/abs/src/a.ts',
      pathNorm: 'src/a.ts',
      cwd: '/abs',
      hash: 'sha256:abc',
      sessionId: 'claude-abc',
    }
    expect(inferAgent(ev)).toBe(AGENT_CLAUDE)
  })

  it('2. legacy Antigravity event via old CLI → "antigravity"', () => {
    // The literal "antigravity-session" sessionId written by
    // scripts/log-external.js today. Kept until those logs age out.
    const ev = {
      ts: '2026-05-24T12:00:00.000Z',
      tool: 'Read',
      pathNorm: 'src/a.ts',
      sessionId: LEGACY_ANTIGRAVITY_SESSION_ID,
    }
    expect(inferAgent(ev)).toBe(AGENT_ANTIGRAVITY)
  })

  it('3. new event with explicit agent="claude" → "claude"', () => {
    // Post-refactor emitter using the canonical field.
    const ev = { agent: 'claude', sessionId: 'claude-xyz' }
    expect(inferAgent(ev)).toBe(AGENT_CLAUDE)
  })

  it('4. explicit agent="antigravity" overrides sessionId hint', () => {
    // Antigravity hook uses a real conversationId, not the legacy
    // literal. The explicit `agent` field is authoritative.
    const ev = { agent: 'antigravity', sessionId: 'some-uuid-not-the-literal' }
    expect(inferAgent(ev)).toBe(AGENT_ANTIGRAVITY)
  })

  it('5. empty sessionId, no agent → "manual"', () => {
    // Scripted seeding / test fixtures / replay tools.
    const ev = { sessionId: '' }
    expect(inferAgent(ev)).toBe(AGENT_MANUAL)
  })

  it('5b. missing sessionId entirely, no agent → "manual"', () => {
    const ev = {}
    expect(inferAgent(ev)).toBe(AGENT_MANUAL)
  })

  it('6. non-string agent value is ignored, cascade continues', () => {
    // A malformed log line must not be able to mis-attribute future
    // events. Number / null / object on `agent` falls through to the
    // sessionId-based cascade.
    expect(inferAgent({ agent: 42, sessionId: 'claude-abc' })).toBe(AGENT_CLAUDE)
    expect(inferAgent({ agent: null, sessionId: 'claude-abc' })).toBe(AGENT_CLAUDE)
    expect(inferAgent({ agent: {}, sessionId: 'claude-abc' })).toBe(AGENT_CLAUDE)
  })

  it('7. mixed file: half legacy / half new — both contribute', () => {
    // Same JSONL contains pre- and post-refactor shapes. The cascade
    // must classify each row independently; no event is dropped.
    const events = [
      { sessionId: 'claude-1' },                                         // legacy claude
      { sessionId: LEGACY_ANTIGRAVITY_SESSION_ID },                      // legacy antigravity
      { agent: 'claude', sessionId: 'claude-2' },                        // new claude
      { agent: 'antigravity', sessionId: 'real-conv-uuid' },             // new antigravity
      { sessionId: '' },                                                 // manual
    ]
    const inferred = events.map(inferAgent)
    expect(inferred).toEqual([
      AGENT_CLAUDE,
      AGENT_ANTIGRAVITY,
      AGENT_CLAUDE,
      AGENT_ANTIGRAVITY,
      AGENT_MANUAL,
    ])
  })

  it('8. heatEngine-style "claude" filter includes legacy events', () => {
    // Sanity check that the platform filter computed via inferAgent
    // returns every pre-refactor Claude event — the back-compat
    // guarantee for the historical archive.
    const legacy = [
      { sessionId: 'claude-1' },
      { sessionId: 'claude-2' },
      { sessionId: 'claude-3' },
    ]
    const matches = legacy.filter((ev) => inferAgent(ev) === AGENT_CLAUDE)
    expect(matches.length).toBe(3)
  })
})

// ─── Defensive input ─────────────────────────────────────────────────────────

describe('inferAgent — defensive behavior', () => {
  it('null / undefined / non-object input → default "claude" (never throws)', () => {
    expect(() => inferAgent(null)).not.toThrow()
    expect(inferAgent(null)).toBe(AGENT_CLAUDE)
    expect(inferAgent(undefined)).toBe(AGENT_CLAUDE)
    expect(inferAgent('not an event')).toBe(AGENT_CLAUDE)
    expect(inferAgent(42)).toBe(AGENT_CLAUDE)
  })

  it('uppercase agent value is normalised to canonical lowercase', () => {
    expect(inferAgent({ agent: 'CLAUDE' })).toBe(AGENT_CLAUDE)
    expect(inferAgent({ agent: 'Antigravity' })).toBe(AGENT_ANTIGRAVITY)
    expect(inferAgent({ agent: 'MANUAL' })).toBe(AGENT_MANUAL)
  })

  it('unknown explicit agent is passed through lowercased', () => {
    // Future-proofing: a Cursor or Aider hook can label its own events
    // and the filter UI will simply not match it (rather than
    // masquerading as "claude" and skewing attribution).
    expect(inferAgent({ agent: 'Cursor' })).toBe('cursor')
    expect(inferAgent({ agent: 'aider' })).toBe('aider')
  })
})

// ─── Display layer ───────────────────────────────────────────────────────────

describe('agentDisplayName + AGENT_DISPLAY', () => {
  it('maps the canonical three to readable labels', () => {
    expect(agentDisplayName({ agent: 'claude' })).toBe('Claude Code')
    expect(agentDisplayName({ agent: 'antigravity' })).toBe('Antigravity')
    expect(agentDisplayName({ agent: 'manual' })).toBe('Manual / CLI')
  })

  it('falls back to the raw lowercased string for unknown agents', () => {
    expect(agentDisplayName({ agent: 'Cursor' })).toBe('cursor')
  })

  it('AGENT_DISPLAY is frozen — UI cannot mutate the mapping', () => {
    expect(() => { AGENT_DISPLAY.claude = 'tampered' }).toThrow()
  })

  it('handles legacy events end-to-end (no agent, sessionId-based)', () => {
    expect(agentDisplayName({ sessionId: LEGACY_ANTIGRAVITY_SESSION_ID }))
      .toBe('Antigravity')
    expect(agentDisplayName({ sessionId: 'claude-abc' })).toBe('Claude Code')
    expect(agentDisplayName({ sessionId: '' })).toBe('Manual / CLI')
  })
})
