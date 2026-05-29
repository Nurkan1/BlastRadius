/**
 * markdown.js — a tiny, dependency-free Markdown renderer for the AI chat
 * bubbles (rc9.7).
 *
 * Why hand-rolled (not marked / markdown-it / showdown):
 *   BlastRadius ships zero runtime deps and runs inside a locked-down
 *   Tauri WebView2 (CSP `script-src 'self'`). A ~180-line vanilla renderer
 *   covers everything a local model's prose actually uses — tables, lists,
 *   code, bold, paragraphs — without pulling a parser (and its supply-chain
 *   surface) into the bundle.
 *
 * Security (the only rule that matters here):
 *   The model's output is UNTRUSTED. Every piece of text is HTML-escaped
 *   FIRST; the only HTML this module ever emits is its own fixed tag set
 *   (<p>, <br>, <strong>, <code>, <pre>, <ul>/<ol>/<li>, <table>…, <h4>).
 *   Because escaping happens before any structural pass, a `<script>` or an
 *   `onerror=` in the reply can never reach innerHTML as live markup.
 *
 * Performance:
 *   Designed for replies up to ~8k tokens (~32 KB). One linear extraction
 *   pass for fenced code, one split into blocks, then linear per-block work.
 *   Every regex is anchored / non-backtracking (no nested quantifiers over
 *   the same span), so a huge reply can't freeze the WebView.
 *
 * Pure (no DOM, no IO) → unit-testable under vitest.
 */

const ESCAPE_RE = /[&<>"']/g
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Escape the five HTML-significant characters. The single entry point for
 *  turning untrusted text into innerHTML-safe text. */
export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(ESCAPE_RE, (c) => ESCAPE_MAP[c])
}

// Placeholder token standing in for a lifted code block. `@@BRCODE<i>@@`
// survives String.trim(), is untouched by escapeHtml (no HTML-significant
// chars), and is vanishingly unlikely to appear in model prose. The lift
// pads it with blank lines so it always lands in its own block.
const PLACEHOLDER_LINE = /^@@BRCODE\d+@@$/
const PLACEHOLDER_GLOBAL = /@@BRCODE(\d+)@@/g

// Inline spans, applied ONLY to already-escaped text. Order matters: inline
// code first, so `**` / backticks inside a code span aren't re-interpreted.
// Italics are intentionally omitted — single `*`/`_` collide with prose like
// `2 * 3` and `snake_case`, and the false positives aren't worth it.
function inline(escaped) {
  return escaped
    .replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
}

/** Split a table row into trimmed cells, tolerating optional edge pipes. */
function splitRow(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

/** A block is a table if line 1 has a pipe and line 2 is a separator row
 *  (cells of only dashes with optional alignment colons). */
function isTable(lines) {
  if (lines.length < 2) return false
  if (!lines[0].includes('|')) return false
  const seps = splitRow(lines[1])
  return seps.length > 0 && seps.every((c) => /^:?-+:?$/.test(c))
}

function alignClass(sep) {
  const left = sep.startsWith(':')
  const right = sep.endsWith(':')
  if (left && right) return ' class="ai-al-center"'
  if (right) return ' class="ai-al-right"'
  if (left) return ' class="ai-al-left"'
  return ''
}

function renderTable(lines) {
  const header = splitRow(lines[0])
  const aligns = splitRow(lines[1]).map(alignClass)
  const cell = (tag, text, i) => `<${tag}${aligns[i] || ''}>${inline(escapeHtml(text))}</${tag}>`
  const head = header.map((c, i) => cell('th', c, i)).join('')
  const body = lines.slice(2).map((row) => {
    const cells = splitRow(row)
    // Render exactly the header's column count, so a ragged row can't desync
    // the table or smuggle in extra cells.
    const tds = header.map((_, i) => cell('td', cells[i] ?? '', i)).join('')
    return `<tr>${tds}</tr>`
  }).join('')
  return `<table class="ai-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

function renderBlock(block) {
  const b = block.trim()
  if (!b) return ''
  // An isolated fenced-code placeholder passes straight through; it's swapped
  // for the real <pre><code> in the final step.
  if (PLACEHOLDER_LINE.test(b)) return b

  const lines = b.split('\n')

  if (isTable(lines)) return renderTable(lines)

  // Heading: a single line of 1–4 leading #. Rendered at one visual size —
  // chat bubbles don't need a full heading hierarchy.
  const heading = lines.length === 1 && b.match(/^\s*#{1,4}\s+(.*)$/)
  if (heading) return `<h4 class="ai-h">${inline(escapeHtml(heading[1]))}</h4>`

  // Unordered list: every line a `-` or `*` bullet.
  if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
    const items = lines.map((l) => `<li>${inline(escapeHtml(l.replace(/^\s*[-*]\s+/, '')))}</li>`).join('')
    return `<ul class="ai-list">${items}</ul>`
  }
  // Ordered list: every line `N.`.
  if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
    const items = lines.map((l) => `<li>${inline(escapeHtml(l.replace(/^\s*\d+\.\s+/, '')))}</li>`).join('')
    return `<ol class="ai-list">${items}</ol>`
  }

  // Paragraph: a single newline becomes a <br>, so a multi-line note keeps
  // its shape instead of collapsing into one run-on line.
  const para = lines.map((l) => inline(escapeHtml(l))).join('<br>')
  return `<p>${para}</p>`
}

/**
 * Render a Markdown string to safe HTML.
 * @param {string} text — untrusted model output
 * @returns {string} HTML built only from this module's fixed tag set
 */
export function renderMarkdown(text) {
  if (text == null) return ''
  const src = String(text).replace(/\r\n?/g, '\n')

  // 1. Lift fenced code blocks out FIRST, replacing each with an isolated
  //    placeholder (padded with blank lines so the block split always
  //    separates it). Their content is escaped verbatim later — no inline or
  //    structural pass ever touches code.
  const codeBlocks = []
  const lifted = src.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
    const i = codeBlocks.length
    codeBlocks.push(code.replace(/\n$/, ''))
    return `\n\n@@BRCODE${i}@@\n\n`
  })

  // 2. Blocks are separated by blank lines.
  const html = lifted
    .split(/\n{2,}/)
    .map(renderBlock)
    .filter(Boolean)
    .join('')

  // 3. Swap code placeholders for escaped <pre><code>.
  return html.replace(PLACEHOLDER_GLOBAL, (_, i) =>
    `<pre class="ai-code"><code>${escapeHtml(codeBlocks[Number(i)] ?? '')}</code></pre>`)
}
