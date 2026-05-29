/**
 * buildAiContextText — pure grounding-context formatter (rc9.2).
 *
 * Turns the gatherReportData() shape into the compact text block the
 * assistant is grounded with. Pure → no server needed.
 */

import { describe, it, expect } from 'vitest'
import { buildAiContextText } from '../../src/server/ai/context.js'

function sample(overrides = {}) {
  return {
    repoName: 'BlastRadius',
    metrics: { red: 2, green: 3, yellow: 1, blastRadius: 12, total: 27 },
    edited: [
      { path: 'src/server/routes.js', agent: 'Claude' },
      { path: 'src/server/heatEngine.js', agent: 'Antigravity' },
    ],
    read: [{ path: 'src/mcp/tools.js', agent: 'Claude' }],
    affected: [{ path: 'src/server/index.js', impactedBy: ['src/server/routes.js (depth 1)'] }],
    graph: { nodes: 27, edges: 39, cycles: 0, orphans: 1, withSummary: 1 },
    annotations: [{ path: 'src/server/heatEngine.js', summary: 'Pure heat color computation.', tags: ['core', 'pure'] }],
    ...overrides,
  }
}

describe('buildAiContextText', () => {
  it('summarizes repo, metrics, edited, propagation, graph and annotations', () => {
    const t = buildAiContextText(sample())
    expect(t).toContain('BlastRadius')
    expect(t).toMatch(/edited \(red\): 2/)
    expect(t).toContain('src/server/routes.js')
    expect(t).toContain('last touched by Claude')
    expect(t).toContain('src/server/index.js')
    expect(t).toContain('← src/server/routes.js (depth 1)')
    expect(t).toMatch(/27 nodes, 39 edges/)
    expect(t).toContain('Pure heat color computation.')
    expect(t).toContain('[core, pure]')
    // The grounding instruction is present so the model uses it.
    expect(t).toMatch(/Ground your answers in this state/i)
  })

  it('states authoritative counts so the model does not miscount the list', () => {
    const t = buildAiContextText(sample())
    expect(t).toContain('Exact counts — files edited: 2, read: 1, propagated: 1.')
    expect(t).toContain('Edited files (2 total):')
  })

  it('surfaces the last-activity timestamp when provided', () => {
    const t = buildAiContextText(sample({ lastActivityAt: '2026-05-30T09:00:00.000Z' }))
    expect(t).toContain('Most recent tracked activity: 2026-05-30T09:00:00.000Z')
    // And is explicit that per-file timestamps aren't available.
    expect(t).toMatch(/No per-file timestamps/i)
  })

  it('adds the session start, per-agent effort, and honest assistant usage (rc9.6)', () => {
    const t = buildAiContextText(sample({
      firstActivityAt: '2026-05-30T08:00:00.000Z',
      lastActivityAt: '2026-05-30T09:00:00.000Z',
      agentActivity: { Claude: 18, Antigravity: 4, Manual: 1 },
      assistantUsage: { adviceCount: 5, tokenTotal: 1234 },
    }))
    expect(t).toContain('Session started (first tracked event): 2026-05-30T08:00:00.000Z')
    // Effort is action counts, sorted, and explicitly NOT tokens.
    expect(t).toMatch(/Effort by agent .* Claude 18, Antigravity 4, Manual 1/)
    expect(t).toMatch(/not tokens/i)
    // Assistant usage is the local assistant's tokens, clearly disclaimed.
    expect(t).toContain('~1234 estimated tokens across 5 replies')
    expect(t).toMatch(/coding agent's token usage\s+is not tracked|not tracked by BlastRadius/i)
    expect(t).toMatch(/do not invent a number/i)
  })

  it('caps long lists, keeps the TOTAL count exact, and notes the overflow', () => {
    const edited = Array.from({ length: 40 }, (_, i) => ({ path: `src/f${i}.js`, agent: 'Claude' }))
    const t = buildAiContextText(sample({ edited }))
    // Total count stays exact even though the displayed list is capped.
    expect(t).toContain('files edited: 40')
    expect(t).toContain('Edited files (40 total):')
    expect(t).toMatch(/… and 15 more/) // 40 − 25 cap
    expect(t).not.toContain('src/f39.js')
  })

  it('is resilient to an empty / partial report', () => {
    const t = buildAiContextText({})
    expect(typeof t).toBe('string')
    expect(t).toContain('BlastRadius — live state')
    expect(t).toMatch(/edited \(red\): 0/)
  })

  it('hard-caps total length', () => {
    const ann = Array.from({ length: 200 }, (_, i) => ({ path: `p${i}`, summary: 'x'.repeat(200), tags: [] }))
    const t = buildAiContextText(sample({ annotations: ann }))
    expect(t.length).toBeLessThanOrEqual(6000 + 40)
  })
})
