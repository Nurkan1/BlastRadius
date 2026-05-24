/**
 * BlastRadius dashboard — vanilla front-end.
 *
 * Renders a collapsible tree of the target repo and overlays heat colors
 * computed by the server. Listens to /api/events (SSE) for live updates.
 *
 * Why HTML nodes (not SVG): the tree is essentially a list-of-rows with
 * fixed-height entries. DOM scrolls naturally for huge repos and gives
 * us free accessibility (keyboard nav, screen-reader semantics). D3 is
 * still useful for `d3.hierarchy()` to flatten the tree into a render
 * order with depth metadata.
 *
 * State model:
 *   - `tree`: the latest /api/tree response (root node).
 *   - `heat`: the latest /api/heat response ({ files, metrics }).
 *   - `windowName`: 'iteration' | 'hour' | 'session'.
 *   - `expanded`: Set of dir paths currently open.
 *   - `selected`: path string of the file shown in the side panel.
 *
 * All updates flow through `refreshHeat()` / `refreshTree()` which fetch
 * fresh data and then call `render()`. Render is idempotent — it just
 * rebuilds the DOM from current state.
 */

const $tree = document.getElementById('tree')
const $treeEmpty = document.getElementById('tree-empty')
const $sideTitle = document.getElementById('side-title')
const $sideBody = document.getElementById('side-body')
const $sideClose = document.getElementById('side-close')
const $connection = document.querySelector('.connection')
const $connLabel = document.querySelector('.conn-label')
const $windowButtons = document.querySelectorAll('.window-toggle button')
const metricEls = {
  red: document.querySelector('[data-metric="red"]'),
  orange: document.querySelector('[data-metric="orange"]'),
  yellow: document.querySelector('[data-metric="yellow"]'),
  blastRadius: document.querySelector('[data-metric="blastRadius"]'),
}

// ─── State ─────────────────────────────────────────────────────────────────

const state = {
  tree: null,
  heat: { files: {}, metrics: { red: 0, orange: 0, yellow: 0, total: 0, blastRadius: 0 } },
  windowName: 'session',
  expanded: new Set(['']), // root is always open
  selected: null,
  // Coalesce bursts of SSE events so we don't refetch per keystroke during
  // a heavy edit. 250ms is well under the 3s spec budget.
  pendingHeatRefresh: null,
  pendingTreeRefresh: null,
}

// ─── Networking ────────────────────────────────────────────────────────────

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts)
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.json()
}

async function refreshTree() {
  try {
    state.tree = await fetchJson('/api/tree')
    if (!state.tree?.children?.length) {
      $tree.innerHTML = ''
      $treeEmpty.hidden = false
      return
    }
    $treeEmpty.hidden = true
    render()
  } catch (err) {
    console.error('refreshTree failed', err)
  }
}

async function refreshHeat() {
  try {
    state.heat = await fetchJson(`/api/heat?window=${encodeURIComponent(state.windowName)}`)
    renderMetrics()
    renderHeatOverlay()
    if (state.selected) renderSidePanel()
  } catch (err) {
    console.error('refreshHeat failed', err)
  }
}

function scheduleHeatRefresh() {
  if (state.pendingHeatRefresh) return
  state.pendingHeatRefresh = setTimeout(() => {
    state.pendingHeatRefresh = null
    void refreshHeat()
  }, 250)
}

function scheduleTreeRefresh() {
  if (state.pendingTreeRefresh) return
  state.pendingTreeRefresh = setTimeout(() => {
    state.pendingTreeRefresh = null
    void refreshTree()
    void refreshHeat() // tree change can also affect blastRadius denominator
  }, 400)
}

// ─── SSE ───────────────────────────────────────────────────────────────────

function setConnectionState(label, mode) {
  $connection.setAttribute('data-conn', mode)
  $connLabel.textContent = label
}

function connectSse() {
  setConnectionState('connecting…', 'connecting')
  const es = new EventSource('/api/events')
  es.addEventListener('open', () => setConnectionState('live', 'open'))
  es.addEventListener('error', () => setConnectionState('reconnecting…', 'error'))
  es.addEventListener('heat-update', () => scheduleHeatRefresh())
  es.addEventListener('tree-update', () => scheduleTreeRefresh())
  // EventSource auto-reconnects on its own; the above 'error' listener
  // just updates the badge so the user sees something is wrong.
}

// ─── Rendering ─────────────────────────────────────────────────────────────

function renderMetrics() {
  const m = state.heat.metrics ?? {}
  metricEls.red.textContent = m.red ?? 0
  metricEls.orange.textContent = m.orange ?? 0
  metricEls.yellow.textContent = m.yellow ?? 0
  metricEls.blastRadius.textContent = m.blastRadius ?? 0
}

/**
 * Flatten the tree into a render order using d3.hierarchy. Each node
 * keeps {data, depth, path}. Collapsed dirs do not contribute their
 * children to the flattened list.
 */
function flattenTree(root) {
  if (!root) return []
  const out = []
  const visit = (node, depth) => {
    const isRoot = node.path === ''
    if (!isRoot) out.push({ data: node, depth })
    if (node.type === 'dir' && (isRoot || state.expanded.has(node.path))) {
      for (const child of node.children || []) visit(child, isRoot ? 0 : depth + 1)
    }
  }
  visit(root, 0)
  return out
}

function nodeIsExpanded(node) {
  return node.path === '' || state.expanded.has(node.path)
}

function render() {
  if (!state.tree) return
  const flat = flattenTree(state.tree)
  // We rebuild the DOM rather than diffing — the tree size is bounded by
  // the user's repo and a full re-render is well under 16ms for typical
  // workspaces. If this becomes a bottleneck we can swap in D3 join.
  const frag = document.createDocumentFragment()
  for (const { data, depth } of flat) {
    frag.appendChild(buildNodeEl(data, depth))
  }
  $tree.replaceChildren(frag)
  applyHeatToDom()
  applySelectionToDom()
}

function renderHeatOverlay() {
  // Without re-flattening: just update the data-heat attribute on each
  // existing row. Falls through to render() if the row count changed
  // (e.g. tree-update raced ahead).
  const rows = $tree.querySelectorAll('.node[data-type="file"]')
  for (const row of rows) {
    const path = row.dataset.path
    const heat = state.heat.files?.[path] ?? 'cold'
    row.setAttribute('data-heat', heat)
  }
}

function applyHeatToDom() {
  renderHeatOverlay()
}

function applySelectionToDom() {
  const rows = $tree.querySelectorAll('.node')
  rows.forEach((row) => {
    row.classList.toggle('is-selected', row.dataset.path === state.selected)
  })
}

function buildNodeEl(node, depth) {
  const row = document.createElement('div')
  row.className = 'node'
  row.dataset.path = node.path
  row.dataset.type = node.type
  row.dataset.heat = node.type === 'file'
    ? (state.heat.files?.[node.path] ?? 'cold')
    : 'cold'
  row.style.setProperty('--depth', String(depth))

  // Toggle (or invisible spacer for files)
  const toggle = document.createElement('span')
  toggle.className = 'node-toggle'
  if (node.type === 'dir') {
    toggle.textContent = nodeIsExpanded(node) ? '▾' : '▸'
  } else {
    toggle.classList.add('invisible')
    toggle.textContent = '·'
  }
  row.appendChild(toggle)

  // Heat dot
  const dot = document.createElement('span')
  dot.className = 'node-icon'
  row.appendChild(dot)

  // Label
  const label = document.createElement('span')
  label.className = 'node-label' + (node.type === 'dir' ? ' is-dir' : '')
  label.textContent = node.name + (node.type === 'dir' ? '/' : '')
  row.appendChild(label)

  row.addEventListener('click', (ev) => {
    ev.stopPropagation()
    if (node.type === 'dir') {
      toggleDir(node)
    } else {
      selectFile(node)
    }
  })

  return row
}

function toggleDir(node) {
  if (state.expanded.has(node.path)) state.expanded.delete(node.path)
  else state.expanded.add(node.path)
  render()
}

function selectFile(node) {
  state.selected = node.path
  renderSidePanel()
  applySelectionToDom()
}

function renderSidePanel() {
  if (!state.selected) {
    $sideTitle.textContent = 'Select a file'
    $sideClose.hidden = true
    $sideBody.innerHTML = '<p class="side-hint">Click any file in the tree to see its heat status and metadata. Diff preview ships in Phase 4.</p>'
    return
  }
  const heat = state.heat.files?.[state.selected] ?? 'cold'
  $sideTitle.textContent = state.selected
  $sideClose.hidden = false
  $sideBody.innerHTML = `
    <div class="side-row"><span class="k">path</span><span class="v">${escapeHtml(state.selected)}</span></div>
    <div class="side-row"><span class="k">heat</span><span class="v heat-${heat}">${heat}</span></div>
    <div class="side-row"><span class="k">window</span><span class="v">${state.windowName}</span></div>
    <div class="side-section">
      <h3>Diff preview</h3>
      <div class="diff-placeholder">Coming in Phase 4 — will show the latest change relative to the iteration marker.</div>
    </div>
  `
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c])
}

// ─── Window toggle ─────────────────────────────────────────────────────────

function setWindow(name) {
  if (state.windowName === name) return
  state.windowName = name
  for (const btn of $windowButtons) {
    btn.setAttribute('aria-selected', btn.dataset.window === name ? 'true' : 'false')
  }
  void refreshHeat()
}

for (const btn of $windowButtons) {
  btn.addEventListener('click', () => setWindow(btn.dataset.window))
}

// Initial visual state of toggle: pick the [aria-selected="true"] from
// markup (default: session).
;(() => {
  for (const btn of $windowButtons) {
    if (btn.getAttribute('aria-selected') === 'true') state.windowName = btn.dataset.window
  }
})()

$sideClose.addEventListener('click', () => {
  state.selected = null
  renderSidePanel()
  applySelectionToDom()
})

// ─── Boot ──────────────────────────────────────────────────────────────────

;(async function boot() {
  await Promise.all([refreshTree(), refreshHeat()])
  connectSse()
})()
