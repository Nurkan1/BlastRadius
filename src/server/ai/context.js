/**
 * Build the grounding context the AI assistant is given on every turn
 * (rc9.2). Without it the model answers blind — it has no idea what the
 * user edited or how the graph looks. We feed BlastRadius's OWN live data
 * as compact, structured TEXT (not an image): LLMs reason far better over
 * structured text than over a rendered graph picture, it's cheaper, and
 * it works with any model — vision or not.
 *
 * Input is the plain object produced by routes.gatherReportData():
 *   { repoName, metrics:{red,green,yellow,blastRadius,total},
 *     edited:[{path,agent}], read:[{path,agent}],
 *     affected:[{path,impactedBy:string[]}],
 *     graph:{nodes,edges,cycles,orphans,withSummary}|null,
 *     annotations:[{path,summary,tags:string[]}] }
 *
 * Pure (no IO) → unit-testable. Caps every list and the total length so a
 * huge repo can't blow the model's context window.
 */

const MAX_EDITED = 25
const MAX_READ = 12
const MAX_AFFECTED = 20
const MAX_ANNOTATIONS = 20
const MAX_CHARS = 6000

function clampList(arr, n) {
  const items = Array.isArray(arr) ? arr : []
  return { shown: items.slice(0, n), extra: Math.max(0, items.length - n) }
}
const moreLine = (extra) => (extra > 0 ? `  … and ${extra} more` : null)

/**
 * @param {object} data — see gatherReportData() shape
 * @returns {string} a compact grounding block (code-language English; the
 *   model is separately instructed to REPLY in the user's language)
 */
export function buildAiContextText(data = {}) {
  const lines = []
  const repoName = data.repoName || data.repoPath || 'the repository'
  const m = data.metrics || {}

  lines.push('[BlastRadius — live state of the repository the user is working in]')
  lines.push(`Repository: ${repoName}`)
  lines.push(
    `Session activity — edited (red): ${m.red ?? 0}, read (green): ${m.green ?? 0}, ` +
    `propagated (yellow): ${m.yellow ?? 0}; blast radius ${m.blastRadius ?? 0}% of ${m.total ?? 0} tracked files.`,
  )

  const edited = clampList(data.edited, MAX_EDITED)
  if (edited.shown.length) {
    lines.push('Recently edited files:')
    for (const f of edited.shown) lines.push(`- ${f.path}${f.agent ? ` (last touched by ${f.agent})` : ''}`)
    const more = moreLine(edited.extra); if (more) lines.push(more)
  }

  const affected = clampList(data.affected, MAX_AFFECTED)
  if (affected.shown.length) {
    lines.push('Files impacted by those edits (propagation):')
    for (const f of affected.shown) {
      const by = Array.isArray(f.impactedBy) && f.impactedBy.length ? ` ← ${f.impactedBy.join(', ')}` : ''
      lines.push(`- ${f.path}${by}`)
    }
    const more = moreLine(affected.extra); if (more) lines.push(more)
  }

  const read = clampList(data.read, MAX_READ)
  if (read.shown.length) {
    lines.push('Recently read files: ' + read.shown.map((f) => f.path).join(', ') + (read.extra ? `, … +${read.extra}` : ''))
  }

  if (data.graph) {
    const g = data.graph
    lines.push(
      `Knowledge graph: ${g.nodes ?? 0} nodes, ${g.edges ?? 0} edges, ` +
      `${g.cycles ?? 0} cycles, ${g.orphans ?? 0} orphans.`,
    )
  }

  const ann = clampList(data.annotations, MAX_ANNOTATIONS)
  if (ann.shown.length) {
    lines.push('Notes on the codebase (agent/human annotations):')
    for (const a of ann.shown) {
      const tags = Array.isArray(a.tags) && a.tags.length ? ` [${a.tags.join(', ')}]` : ''
      const summary = a.summary ? ` — ${a.summary}` : ''
      lines.push(`- ${a.path}${summary}${tags}`)
    }
    const more = moreLine(ann.extra); if (more) lines.push(more)
  }

  lines.push(
    'Ground your answers in this state: when the user asks what changed, what a change affects, ' +
    'or where to go next, use these files, the propagation, and the graph rather than guessing.',
  )

  let text = lines.join('\n')
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '\n… (context truncated)'
  return text
}
