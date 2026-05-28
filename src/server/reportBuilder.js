/**
 * reportBuilder — pure Markdown + printable-HTML report formatters (rc8.6).
 *
 * The /api/report.md and /api/report.html routes gather the live heat
 * result + knowledge-graph snapshot, shape them into a plain data
 * object, and hand it here. These functions have NO IO and NO server
 * coupling — given the same data they always produce the same string,
 * which is what makes them cheap to unit-test.
 *
 * Data shape (all fields required except `graph` which may be null):
 *   {
 *     repoName:    string,
 *     repoPath:    string,
 *     generatedAt: string (ISO),
 *     window:      string,
 *     metrics:     { red, green, yellow, blastRadius, total },
 *     edited:      [{ path, agent }],
 *     read:        [{ path, agent }],
 *     affected:    [{ path, impactedBy: string[] }],
 *     graph:       { nodes, edges, cycles, orphans, withSummary } | null,
 *   }
 *
 * Security: buildHtmlReport escapes every repo-originated value (paths,
 * agent names) — a path can legally contain `< > & " '`, and the HTML
 * report opens in a browser/print view, so unescaped content would be
 * an injection vector. The Markdown variant backtick-wraps paths (a
 * .md file has no active-content execution surface).
 */

/** HTML-escape the five significant characters. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Coerce metrics to safe numbers (defends against missing fields). */
function safeMetrics(m = {}) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  return {
    red: n(m.red),
    green: n(m.green),
    yellow: n(m.yellow),
    blastRadius: n(m.blastRadius),
    total: n(m.total),
  }
}

/**
 * Build a Markdown digest of the current iteration / session.
 * @param {object} data — see module header
 * @returns {string} markdown
 */
export function buildMarkdownReport(data = {}) {
  const repoName = data.repoName || data.repoPath || 'repository'
  const generatedAt = data.generatedAt || new Date().toISOString()
  const window = data.window || 'session'
  const m = safeMetrics(data.metrics)
  const edited = Array.isArray(data.edited) ? data.edited : []
  const read = Array.isArray(data.read) ? data.read : []
  const affected = Array.isArray(data.affected) ? data.affected : []
  const graph = data.graph || null

  const lines = []
  lines.push(`# BlastRadius Report — ${repoName}`)
  lines.push('')
  lines.push(`- **Generated:** ${generatedAt}`)
  // Scope line reflects the ACTIVE dashboard filter: a date range when
  // one is set (the window is then meaningless), otherwise the
  // time-window. Plus the agent filter when it isn't "all". Keeping the
  // header honest is the point of the filter-aware export.
  if (data.range && data.range.from && data.range.to) {
    lines.push(`- **Date range:** ${data.range.from} → ${data.range.to}`)
  } else {
    lines.push(`- **Window:** ${window}`)
  }
  if (data.platform && data.platform !== 'all') {
    lines.push(`- **Agent filter:** ${data.platform}`)
  }
  if (data.repoPath) lines.push(`- **Repo:** \`${data.repoPath}\``)
  lines.push('')

  lines.push('## Metrics')
  lines.push('')
  lines.push(`- Files edited (red): **${m.red}**`)
  lines.push(`- Files read (green): **${m.green}**`)
  lines.push(`- Files propagated (yellow): **${m.yellow}**`)
  lines.push(`- Blast radius: **${m.blastRadius}%**`)
  lines.push(`- Tracked files: **${m.total}**`)
  lines.push('')

  const fileSection = (title, items, withAgent = true) => {
    lines.push(`## ${title}`)
    lines.push('')
    if (items.length === 0) {
      lines.push('_None._')
    } else {
      for (const it of items) {
        if (withAgent) {
          lines.push(`- \`${it.path}\` — last agent: ${it.agent || 'Unknown'}`)
        } else {
          const by = Array.isArray(it.impactedBy) && it.impactedBy.length
            ? ` ← ${it.impactedBy.join(', ')}`
            : ''
          lines.push(`- \`${it.path}\`${by}`)
        }
      }
    }
    lines.push('')
  }

  fileSection('Edited files', edited)
  fileSection('Read files', read)
  fileSection('Propagated (affected) files', affected, false)

  // rc8.6+: knowledge-graph annotations (summaries + tags persisted by
  // the set_node_summary MCP tool). Included so the report carries the
  // human/agent notes about the codebase, not just raw activity. If
  // there are none, say so explicitly rather than omitting the section.
  const annotations = Array.isArray(data.annotations) ? data.annotations : []
  lines.push('## Annotations (agent / human notes)')
  lines.push('')
  if (annotations.length === 0) {
    lines.push('_No annotations yet — agents add these via the `set_node_summary` MCP tool._')
  } else {
    for (const a of annotations) {
      const tags = Array.isArray(a.tags) && a.tags.length
        ? ' ' + a.tags.map((t) => `\`${t}\``).join(' ')
        : ''
      const summary = a.summary ? ` — ${a.summary}` : ''
      lines.push(`- \`${a.path}\`${summary}${tags}`)
    }
  }
  lines.push('')

  if (graph) {
    lines.push('## Knowledge graph')
    lines.push('')
    lines.push(`- Nodes: **${graph.nodes ?? 0}** · Edges: **${graph.edges ?? 0}**`)
    lines.push(`- Cycles: **${graph.cycles ?? 0}** · Orphans: **${graph.orphans ?? 0}**`)
    lines.push(`- Nodes with a summary: **${graph.withSummary ?? 0}**`)
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('_Generated by BlastRadius — local-first observability for AI coding agents._')
  lines.push('')

  return lines.join('\n')
}

/**
 * Build a self-contained, print-friendly HTML document of the same
 * report. White background + dark text (optimized for paper / PDF via
 * Ctrl+P → Save as PDF). No external assets.
 *
 * `opts.autoPrint` injects a tiny, app-authored inline script that calls
 * `window.print()` on load. It's used by the dashboard's "Print / PDF"
 * button, which loads this page inside a hidden same-origin iframe: the
 * page prints ITSELF so the parent frame never has to touch the iframe's
 * `contentWindow` (that cross-frame access throws a SecurityError in the
 * Tauri WebView2 shell). The script contains no interpolated data, so
 * it's not an injection surface; the default (shareable) variant stays
 * script-free.
 *
 * @param {object} data — see module header
 * @param {{ autoPrint?: boolean }} [opts]
 * @returns {string} a full HTML document
 */
export function buildHtmlReport(data = {}, opts = {}) {
  const repoName = esc(data.repoName || data.repoPath || 'repository')
  const generatedAt = esc(data.generatedAt || new Date().toISOString())
  const window = esc(data.window || 'session')
  const repoPath = data.repoPath ? esc(data.repoPath) : null
  // Scope = date range (if active) else time-window, plus the agent
  // filter when it isn't "all". platform is client-controlled, so every
  // value here is esc()'d — this string lands in a print/browser view.
  const hasRange = Boolean(data.range && data.range.from && data.range.to)
  const scopeLabel = hasRange
    ? `Date range: ${esc(data.range.from)} → ${esc(data.range.to)}`
    : `Window: ${window}`
  const agentLabel = data.platform && data.platform !== 'all'
    ? ` &middot; Agent: ${esc(data.platform)}`
    : ''
  const m = safeMetrics(data.metrics)
  const edited = Array.isArray(data.edited) ? data.edited : []
  const read = Array.isArray(data.read) ? data.read : []
  const affected = Array.isArray(data.affected) ? data.affected : []
  const graph = data.graph || null

  const fileRows = (items, withAgent = true) => {
    if (items.length === 0) return '<p class="none">None.</p>'
    const lis = items.map((it) => {
      if (withAgent) {
        return `<li><code>${esc(it.path)}</code> <span class="agent">${esc(it.agent || 'Unknown')}</span></li>`
      }
      const by = Array.isArray(it.impactedBy) && it.impactedBy.length
        ? ` <span class="by">&larr; ${esc(it.impactedBy.join(', '))}</span>`
        : ''
      return `<li><code>${esc(it.path)}</code>${by}</li>`
    }).join('\n')
    return `<ul>\n${lis}\n</ul>`
  }

  // rc8.6+: annotations section. Every value is esc()'d — summaries and
  // tags are agent-provided free text and the HTML opens in a print
  // context, so this is an injection-defense boundary.
  const annotations = Array.isArray(data.annotations) ? data.annotations : []
  const annotationsBlock = (() => {
    if (annotations.length === 0) {
      return `<section>
  <h2>Annotations (agent / human notes)</h2>
  <p class="none">No annotations yet — agents add these via the <code>set_node_summary</code> MCP tool.</p>
</section>`
    }
    const lis = annotations.map((a) => {
      const tags = Array.isArray(a.tags) && a.tags.length
        ? ' ' + a.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')
        : ''
      const summary = a.summary ? ` <span class="summary">${esc(a.summary)}</span>` : ''
      return `<li><code>${esc(a.path)}</code>${summary}${tags}</li>`
    }).join('\n')
    return `<section>
  <h2>Annotations (agent / human notes)</h2>
  <ul>\n${lis}\n</ul>
</section>`
  })()

  const graphBlock = graph
    ? `<section>
  <h2>Knowledge graph</h2>
  <ul class="stats">
    <li>Nodes: <b>${esc(graph.nodes ?? 0)}</b></li>
    <li>Edges: <b>${esc(graph.edges ?? 0)}</b></li>
    <li>Cycles: <b>${esc(graph.cycles ?? 0)}</b></li>
    <li>Orphans: <b>${esc(graph.orphans ?? 0)}</b></li>
    <li>With summary: <b>${esc(graph.withSummary ?? 0)}</b></li>
  </ul>
</section>`
    : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>BlastRadius Report — ${repoName}</title>
<style>
  @media print { body { margin: 0; } .hint { display: none; } }
  body { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; color: #1a1a1a; background: #fff; max-width: 820px; margin: 32px auto; padding: 0 24px; line-height: 1.55; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 24px 0 8px; border-bottom: 1px solid #e2e2e2; padding-bottom: 4px; }
  .meta { color: #555; font-size: 13px; margin: 0 0 8px; }
  .meta code { font-size: 12px; }
  code { background: #f3f3f3; padding: 1px 6px; border-radius: 3px; font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; font-size: 12.5px; }
  ul { margin: 6px 0; padding-left: 20px; }
  li { margin: 3px 0; }
  .agent { color: #6a6a6a; font-size: 12px; margin-left: 6px; }
  .by { color: #8a6a00; font-size: 12px; }
  .metrics { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 14px; }
  .metrics li { background: #f7f7f7; border: 1px solid #e2e2e2; border-radius: 6px; padding: 8px 14px; font-size: 13px; }
  .metrics b { font-size: 18px; display: block; }
  .stats { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 14px; }
  .stats li { font-size: 13px; }
  .none { color: #999; font-style: italic; margin: 6px 0; }
  .summary { color: #333; }
  .tag { display: inline-block; background: #eef2ff; color: #3949ab; border-radius: 9px; padding: 0 8px; font-size: 11px; margin-left: 2px; }
  footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid #e2e2e2; color: #888; font-size: 12px; }
  .hint { background: #fff8e1; border: 1px solid #ffe08a; border-radius: 6px; padding: 8px 12px; font-size: 12px; color: #6a5300; margin-bottom: 18px; }
</style>
</head>
<body>
<p class="hint">Tip: press Ctrl/Cmd+P and choose "Save as PDF" to export this report.</p>
<h1>BlastRadius Report — ${repoName}</h1>
<p class="meta">Generated: ${generatedAt} &middot; ${scopeLabel}${agentLabel}${repoPath ? ` &middot; <code>${repoPath}</code>` : ''}</p>

<section>
  <h2>Metrics</h2>
  <ul class="metrics">
    <li><b>${m.red}</b> edited (red)</li>
    <li><b>${m.green}</b> read (green)</li>
    <li><b>${m.yellow}</b> propagated (yellow)</li>
    <li><b>${m.blastRadius}%</b> blast radius</li>
    <li><b>${m.total}</b> tracked files</li>
  </ul>
</section>

<section>
  <h2>Edited files</h2>
  ${fileRows(edited)}
</section>

<section>
  <h2>Read files</h2>
  ${fileRows(read)}
</section>

<section>
  <h2>Propagated (affected) files</h2>
  ${fileRows(affected, false)}
</section>

${annotationsBlock}

${graphBlock}

<footer>Generated by BlastRadius — local-first observability for AI coding agents.</footer>
${opts.autoPrint ? '<script>window.addEventListener("load",function(){setTimeout(function(){try{window.focus()}catch(e){}window.print()},150)})</script>' : ''}
</body>
</html>`
}
