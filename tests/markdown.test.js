/**
 * markdown.js — tiny dependency-free Markdown renderer for AI chat (rc9.7).
 *
 * The renderer's #1 job is to be XSS-safe (model output is untrusted), so
 * those cases come first. Then the structural features the user asked for:
 * tables, line breaks that don't collapse, lists, and preserved code.
 */

import { describe, it, expect } from 'vitest'
import { renderMarkdown, escapeHtml } from '../src/public/markdown.js'

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<script>"&'`)).toBe('&lt;script&gt;&quot;&amp;&#39;')
  })
  it('is null/undefined safe', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })
})

describe('renderMarkdown — XSS defense', () => {
  it('never emits live markup from the model text', () => {
    const html = renderMarkdown('Hello <img src=x onerror=alert(1)> world')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
  it('escapes HTML inside table cells', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| <b>x</b> | y |')
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>x</b>')
  })
  it('escapes HTML inside fenced code', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```')
    expect(html).toContain('<pre class="ai-code"><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>')
  })
})

describe('renderMarkdown — tables', () => {
  it('renders a Markdown table to <table>', () => {
    const html = renderMarkdown('| Name | Role |\n| --- | --- |\n| Ana | Dev |\n| Bo | Ops |')
    expect(html).toContain('<table class="ai-table">')
    expect(html).toContain('<thead><tr><th>Name</th><th>Role</th></tr></thead>')
    expect(html).toContain('<td>Ana</td><td>Dev</td>')
    expect(html).toContain('<td>Bo</td><td>Ops</td>')
  })
  it('honors column alignment from the separator row', () => {
    const html = renderMarkdown('| L | C | R |\n|:--|:-:|--:|\n| 1 | 2 | 3 |')
    expect(html).toContain('class="ai-al-left"')
    expect(html).toContain('class="ai-al-center"')
    expect(html).toContain('class="ai-al-right"')
  })
  it('clamps a ragged row to the header column count', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| only-one |')
    // Second cell is filled empty, never an extra/!missing column.
    expect(html).toContain('<td>only-one</td><td></td>')
  })
})

describe('renderMarkdown — line breaks & structure', () => {
  it('keeps paragraphs separate (double newline)', () => {
    const html = renderMarkdown('First para.\n\nSecond para.')
    expect(html).toBe('<p>First para.</p><p>Second para.</p>')
  })
  it('turns a single newline into <br> (no run-on collapse)', () => {
    const html = renderMarkdown('line one\nline two')
    expect(html).toBe('<p>line one<br>line two</p>')
  })
  it('renders unordered and ordered lists', () => {
    expect(renderMarkdown('- a\n- b')).toBe('<ul class="ai-list"><li>a</li><li>b</li></ul>')
    expect(renderMarkdown('1. a\n2. b')).toBe('<ol class="ai-list"><li>a</li><li>b</li></ol>')
  })
  it('renders a heading', () => {
    expect(renderMarkdown('## What changed')).toBe('<h4 class="ai-h">What changed</h4>')
  })
})

describe('renderMarkdown — inline + code', () => {
  it('renders bold and inline code', () => {
    expect(renderMarkdown('Use **bold** and `code` here.')).toBe('<p>Use <strong>bold</strong> and <code>code</code> here.</p>')
  })
  it('does not treat ** inside a code span as bold', () => {
    const html = renderMarkdown('`a ** b`')
    expect(html).toContain('<code>a ** b</code>')
    expect(html).not.toContain('<strong>')
  })
  it('preserves a fenced code block verbatim, separate from prose', () => {
    const html = renderMarkdown('Here is code:\n\n```js\nconst x = 1\n```\n\nDone.')
    expect(html).toContain('<p>Here is code:</p>')
    expect(html).toContain('<pre class="ai-code"><code>const x = 1</code></pre>')
    expect(html).toContain('<p>Done.</p>')
  })
})

describe('renderMarkdown — edge cases', () => {
  it('returns empty string for null/empty', () => {
    expect(renderMarkdown(null)).toBe('')
    expect(renderMarkdown('')).toBe('')
  })
  it('handles a large reply without hanging', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `Line ${i} with **bold** text`).join('\n')
    const t0 = Date.now()
    const html = renderMarkdown(big)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(html).toContain('<strong>bold</strong>')
  })
})
