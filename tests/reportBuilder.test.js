/**
 * reportBuilder — pure Markdown + printable-HTML report generation (rc8.6).
 *
 * The /api/report.md and /api/report.html routes gather data from the
 * live heat computation + knowledge-graph snapshot, then hand a plain
 * data object to these pure formatters. Keeping the formatting pure
 * makes it unit-testable without a server, and means the route is a
 * thin data-gathering shim.
 *
 * Security note: buildHtmlReport MUST HTML-escape every value that
 * originates from the repo (file paths, agent names) — a path can
 * legally contain `<` `>` `&`, and the HTML report is opened in a
 * browser/print view, so unescaped content would be an injection
 * vector. The Markdown variant wraps paths in backticks (no active
 * content risk in a .md file).
 */

import { describe, it, expect } from 'vitest'
import { buildMarkdownReport, buildHtmlReport, buildReportFragment } from '../src/server/reportBuilder.js'

function sampleData(overrides = {}) {
  return {
    repoName: 'BlastRadius',
    repoPath: 'C:/Users/me/Documents/BlastRadius',
    generatedAt: '2026-05-28T10:00:00.000Z',
    window: 'session',
    metrics: { red: 2, green: 3, yellow: 1, blastRadius: 12, total: 27 },
    edited: [
      { path: 'src/server/routes.js', agent: 'Claude' },
      { path: 'src/server/heatEngine.js', agent: 'Antigravity' },
    ],
    read: [
      { path: 'src/mcp/tools.js', agent: 'Claude' },
    ],
    affected: [
      { path: 'src/server/index.js', impactedBy: ['src/server/routes.js (depth 1)'] },
    ],
    graph: { nodes: 27, edges: 39, cycles: 0, orphans: 1, withSummary: 1 },
    annotations: [
      { path: 'src/server/heatEngine.js', summary: 'Pure heat color computation.', tags: ['core', 'pure'] },
    ],
    ...overrides,
  }
}

describe('buildMarkdownReport', () => {
  it('includes the repo name, window, and generated timestamp', () => {
    const md = buildMarkdownReport(sampleData())
    expect(md).toContain('BlastRadius')
    expect(md).toContain('session')
    expect(md).toContain('2026-05-28T10:00:00.000Z')
  })

  it('renders the metrics', () => {
    const md = buildMarkdownReport(sampleData())
    expect(md).toMatch(/2.*edited|edited.*2/i)
    expect(md).toContain('12') // blast radius %
  })

  it('lists edited files with their agent, backtick-wrapped', () => {
    const md = buildMarkdownReport(sampleData())
    expect(md).toContain('`src/server/routes.js`')
    expect(md).toContain('Claude')
    expect(md).toContain('`src/server/heatEngine.js`')
    expect(md).toContain('Antigravity')
  })

  it('renders the knowledge-graph stats when present', () => {
    const md = buildMarkdownReport(sampleData())
    expect(md).toMatch(/27.*nodes|nodes.*27/i)
    expect(md).toMatch(/1.*orphan|orphan.*1/i)
  })

  it('renders annotations (summary + tags) when present', () => {
    const md = buildMarkdownReport(sampleData())
    expect(md).toContain('## Annotations')
    expect(md).toContain('`src/server/heatEngine.js`')
    expect(md).toContain('Pure heat color computation.')
    expect(md).toContain('`core`')
    expect(md).toContain('`pure`')
  })

  it('shows the "no annotations" fallback when there are none', () => {
    const md = buildMarkdownReport(sampleData({ annotations: [] }))
    expect(md).toContain('## Annotations')
    expect(md).toMatch(/No annotations yet/i)
    expect(md).toContain('set_node_summary')
  })

  it('does not crash on an empty report (no files, no graph, no annotations)', () => {
    const md = buildMarkdownReport(sampleData({
      metrics: { red: 0, green: 0, yellow: 0, blastRadius: 0, total: 0 },
      edited: [], read: [], affected: [], graph: null, annotations: [],
    }))
    expect(typeof md).toBe('string')
    expect(md.length).toBeGreaterThan(0)
    expect(md).toContain('BlastRadius')
    expect(md).toMatch(/No annotations yet/i)
  })

  it('shows the date range in the header when a range is active', () => {
    const md = buildMarkdownReport(sampleData({ range: { from: '2026-05-01', to: '2026-05-07' } }))
    expect(md).toContain('Date range:')
    expect(md).toContain('2026-05-01 → 2026-05-07')
  })

  it('shows the agent filter only when platform is not "all"', () => {
    const filtered = buildMarkdownReport(sampleData({ platform: 'Antigravity' }))
    expect(filtered).toContain('Agent filter:')
    expect(filtered).toContain('Antigravity')
    // No platform on the default sample → no agent-filter line.
    expect(buildMarkdownReport(sampleData())).not.toMatch(/Agent filter:/)
    // 'all' is treated as "no filter".
    expect(buildMarkdownReport(sampleData({ platform: 'all' }))).not.toMatch(/Agent filter:/)
  })
})

describe('buildHtmlReport', () => {
  it('returns a full HTML document', () => {
    const html = buildHtmlReport(sampleData())
    expect(html).toMatch(/^<!doctype html>/i)
    expect(html).toContain('</html>')
    expect(html).toContain('BlastRadius')
  })

  it('HTML-escapes repo-originated values (injection defense)', () => {
    const html = buildHtmlReport(sampleData({
      edited: [{ path: 'src/<script>alert(1)</script>.js', agent: 'X&Y' }],
    }))
    // The raw tag must NOT appear; it must be escaped.
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('X&amp;Y')
  })

  it('HTML-escapes annotation summaries + tags (agent-provided free text)', () => {
    const html = buildHtmlReport(sampleData({
      annotations: [{ path: 'a.js', summary: '<img src=x onerror=alert(1)>', tags: ['<b>'] }],
    }))
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;b&gt;')
  })

  it('renders the annotations "none" fallback in HTML', () => {
    const html = buildHtmlReport(sampleData({ annotations: [] }))
    expect(html).toMatch(/No annotations yet/i)
  })

  it('does not crash on an empty report', () => {
    const html = buildHtmlReport(sampleData({
      metrics: { red: 0, green: 0, yellow: 0, blastRadius: 0, total: 0 },
      edited: [], read: [], affected: [], graph: null,
    }))
    expect(html).toMatch(/^<!doctype html>/i)
  })

  it('shows the active range + agent filter in the meta line', () => {
    const html = buildHtmlReport(sampleData({
      range: { from: '2026-05-01', to: '2026-05-07' },
      platform: 'Claude',
    }))
    expect(html).toContain('Date range: 2026-05-01 → 2026-05-07')
    expect(html).toContain('Agent: Claude')
  })

  it('HTML-escapes the platform/agent filter (client-controlled query param)', () => {
    const html = buildHtmlReport(sampleData({ platform: '<script>alert(1)</script>' }))
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('is script-free (safe to share / open standalone)', () => {
    const html = buildHtmlReport(sampleData())
    expect(html).not.toContain('<script')
  })
})

describe('buildReportFragment', () => {
  it('returns a scoped fragment (style + .br-report div), not a full document', () => {
    const frag = buildReportFragment(sampleData())
    expect(frag).not.toMatch(/<!doctype/i)
    expect(frag).not.toContain('<html')
    expect(frag).not.toContain('<body')
    expect(frag).toContain('<style>')
    expect(frag).toContain('<div class="br-report">')
    // Styles are scoped under .br-report so they can't leak onto the dark
    // dashboard the fragment is injected into.
    expect(frag).toContain('.br-report h2')
    expect(frag).not.toContain('<script')
  })

  it('carries the same content as the full document', () => {
    const frag = buildReportFragment(sampleData())
    expect(frag).toContain('BlastRadius Report')
    expect(frag).toContain('Annotations')
    expect(frag).toContain('src/server/heatEngine.js')
    expect(frag).toContain('Pure heat color computation.')
  })

  it('HTML-escapes repo-originated values in the fragment too', () => {
    const frag = buildReportFragment(sampleData({
      edited: [{ path: 'src/<script>alert(1)</script>.js', agent: 'X&Y' }],
    }))
    expect(frag).not.toContain('<script>alert(1)</script>')
    expect(frag).toContain('&lt;script&gt;')
    expect(frag).toContain('X&amp;Y')
  })
})
