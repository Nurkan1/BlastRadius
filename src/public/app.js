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

// Phase 4 elements
const $layout = document.querySelector('.layout')
const $iterPanel = document.getElementById('iter-panel')
const $iterToggle = document.getElementById('toggle-iter-panel')
const $iterClose = document.getElementById('iter-close')
const $iterCloseBtn = document.getElementById('iter-close-btn')
const iterEls = {
  red: document.getElementById('iter-red'),
  orange: document.getElementById('iter-orange'),
  yellow: document.getElementById('iter-yellow'),
  radius: document.getElementById('iter-radius'),
  depth: document.getElementById('iter-depth'),
  lastActivity: document.getElementById('iter-last-activity'),
  started: document.getElementById('iter-started'),
}
const $diffModal = document.getElementById('diff-modal')
const $diffModalTitle = document.getElementById('diff-modal-title')
const $diffModalBody = document.getElementById('diff-modal-body')
const $diffModalStats = document.getElementById('diff-modal-stats')
const $diffModalAdded = document.getElementById('diff-modal-added')
const $diffModalDeleted = document.getElementById('diff-modal-deleted')
const $diffTooltip = document.getElementById('diff-tooltip')
const $diffTooltipAdded = document.getElementById('diff-tooltip-added')
const $diffTooltipDeleted = document.getElementById('diff-tooltip-deleted')

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

  // Phase 4 state
  iterPanelOpen: false,
  iterationStartedAt: null,
  /** When the most recent SSE heat-update arrived — drives "última actividad". */
  lastHeatActivityAt: null,
  /** Background cache of diff stats per path so the hover tooltip is snappy
   *  after the first hover. Invalidated on every heat-update. */
  diffStatsCache: new Map(),
  /** Tracks the timer for the 1s hover-delay tooltip; cancelable on mouseleave. */
  hoverTimer: null,
  hoverPath: null,
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
  es.addEventListener('heat-update', () => {
    // The underlying files may have changed — last hover stats are
    // stale. Wipe the diff cache so the next hover re-fetches.
    state.diffStatsCache.clear()
    state.lastHeatActivityAt = Date.now()
    if (state.iterPanelOpen) refreshIterationPanel()
    scheduleHeatRefresh()
  })
  es.addEventListener('tree-update', () => scheduleTreeRefresh())
  es.addEventListener('iteration-update', () => {
    // Marker advanced server-side — refresh panel + tree (iteration
    // window will now be empty).
    void refreshHeat()
    if (state.iterPanelOpen) refreshIterationPanel()
  })
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
      // Red files open the diff modal directly on click; cold/orange/
      // yellow files just show the side-panel detail.
      if (node.type === 'file' && row.dataset.heat === 'red') {
        openDiffModal(node.path)
      }
    }
  })

  if (node.type === 'file') bindNodeHoverEvents(row)

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
    $sideBody.innerHTML = '<p class="side-hint">Click any file in the tree to see its heat status and metadata. Click a red file to view the full diff.</p>'
    return
  }
  const heat = state.heat.files?.[state.selected] ?? 'cold'
  $sideTitle.textContent = state.selected
  $sideClose.hidden = false
  const diffButtonHtml = heat === 'red'
    ? `<button type="button" class="iter-close-btn" id="side-open-diff" style="background: rgba(0,212,255,0.10); border-color: var(--accent); color: var(--accent);">Open diff</button>`
    : `<div class="diff-placeholder">Only red files have a diff to view. This file is "${heat}".</div>`
  $sideBody.innerHTML = `
    <div class="side-row"><span class="k">path</span><span class="v">${escapeHtml(state.selected)}</span></div>
    <div class="side-row"><span class="k">heat</span><span class="v heat-${heat}">${heat}</span></div>
    <div class="side-row"><span class="k">window</span><span class="v">${state.windowName}</span></div>
    <div class="side-section">
      <h3>Diff preview</h3>
      ${diffButtonHtml}
    </div>
  `
  const $openDiff = document.getElementById('side-open-diff')
  if ($openDiff) $openDiff.addEventListener('click', () => openDiffModal(state.selected))
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

// ─── Phase 4-A: hover tooltip + diff modal ─────────────────────────────────

const HOVER_DELAY_MS = 1000

async function fetchDiff(path) {
  const url = `/api/diff?path=${encodeURIComponent(path)}`
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const err = new Error(body.message || `HTTP ${res.status}`)
    err.code = body.error || 'http_error'
    err.status = res.status
    throw err
  }
  return res.json()
}

async function ensureDiffStats(path) {
  if (state.diffStatsCache.has(path)) return state.diffStatsCache.get(path)
  try {
    const out = await fetchDiff(path)
    state.diffStatsCache.set(path, out.stats || { added: 0, deleted: 0 })
    // Also stash the rendered HTML so the modal opens instantly if the
    // user hovered first.
    state.diffStatsCache.set(`${path}::html`, out)
    return out.stats
  } catch (err) {
    // Cache the failure as zeros to avoid retry storms; the next
    // heat-update will invalidate this entry.
    state.diffStatsCache.set(path, { added: 0, deleted: 0 })
    return { added: 0, deleted: 0 }
  }
}

function positionTooltip(target) {
  const r = target.getBoundingClientRect()
  $diffTooltip.style.left = `${r.right + 8}px`
  $diffTooltip.style.top = `${r.top + r.height / 2 - 14}px`
}

function hideTooltip() {
  $diffTooltip.hidden = true
  state.hoverPath = null
  if (state.hoverTimer) clearTimeout(state.hoverTimer)
  state.hoverTimer = null
}

function bindNodeHoverEvents(row) {
  row.addEventListener('mouseenter', () => {
    if (row.dataset.heat !== 'red') return
    const path = row.dataset.path
    if (!path) return
    if (state.hoverTimer) clearTimeout(state.hoverTimer)
    state.hoverPath = path
    state.hoverTimer = setTimeout(async () => {
      const stats = await ensureDiffStats(path)
      // Bail out if the user moved off the row before the timer fired.
      if (state.hoverPath !== path) return
      $diffTooltipAdded.textContent = stats.added ?? 0
      $diffTooltipDeleted.textContent = stats.deleted ?? 0
      positionTooltip(row)
      $diffTooltip.hidden = false
    }, HOVER_DELAY_MS)
  })
  row.addEventListener('mouseleave', () => {
    if (state.hoverPath === row.dataset.path) hideTooltip()
  })
}

async function openDiffModal(path) {
  hideTooltip()
  $diffModal.hidden = false
  $diffModalTitle.textContent = path
  $diffModalStats.hidden = true
  $diffModalBody.innerHTML = `
    <div class="diff-modal-spinner">
      <div class="spinner"></div>
      <span>Loading diff…</span>
    </div>
  `
  document.body.style.overflow = 'hidden'

  try {
    // Reuse cached HTML if the user hovered first.
    let out = state.diffStatsCache.get(`${path}::html`)
    if (!out) {
      out = await fetchDiff(path)
      state.diffStatsCache.set(`${path}::html`, out)
      state.diffStatsCache.set(path, out.stats || { added: 0, deleted: 0 })
    }

    $diffModalAdded.textContent = out.stats?.added ?? 0
    $diffModalDeleted.textContent = out.stats?.deleted ?? 0
    $diffModalStats.hidden = false

    if (out.empty) {
      $diffModalBody.innerHTML = `
        <div class="diff-modal-empty">
          <div class="empty-icon">∅</div>
          <p>${escapeHtml(out.message || 'No diff to show.')}</p>
        </div>
      `
      return
    }

    // diff2html HTML is trusted — it's our server's render of git output.
    // Setting innerHTML is the documented way to mount it.
    $diffModalBody.innerHTML = out.truncated
      ? `<div class="diff-modal-empty"><div class="empty-icon">⚠</div><p>${escapeHtml(out.message)}</p></div>${out.html}`
      : out.html
  } catch (err) {
    $diffModalBody.innerHTML = `
      <div class="diff-modal-empty">
        <div class="empty-icon">✗</div>
        <p>${escapeHtml(err.message || 'Failed to load diff.')}</p>
      </div>
    `
  }
}

function closeDiffModal() {
  $diffModal.hidden = true
  document.body.style.overflow = ''
}

$diffModal.addEventListener('click', (ev) => {
  if (/** @type {HTMLElement} */ (ev.target).closest('[data-close-modal]')) {
    closeDiffModal()
  }
})

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !$diffModal.hidden) {
    ev.preventDefault()
    closeDiffModal()
  }
})

// ─── Phase 4-B: iteration panel ────────────────────────────────────────────

function setIterPanelOpen(open) {
  state.iterPanelOpen = !!open
  $layout.setAttribute('data-iter-open', state.iterPanelOpen ? 'true' : 'false')
  $iterPanel.hidden = !state.iterPanelOpen
  $iterToggle.setAttribute('aria-pressed', state.iterPanelOpen ? 'true' : 'false')
  if (state.iterPanelOpen) refreshIterationPanel()
}

async function refreshIterationPanel() {
  // The iteration panel always shows the "iteration" window regardless
  // of which window is currently selected for the tree colors. That way
  // the panel is a stable view of "current iteration so far".
  try {
    const heat = await fetchJson('/api/heat?window=iteration')
    const m = heat.metrics ?? {}
    iterEls.red.textContent = m.red ?? 0
    iterEls.orange.textContent = m.orange ?? 0
    iterEls.yellow.textContent = m.yellow ?? 0
    iterEls.radius.textContent = m.blastRadius ?? 0
  } catch {
    // Network blip — keep the previous numbers on screen.
  }
  // Pull the iteration start time separately so we always have the
  // freshest value (the marker might have advanced between fetches).
  try {
    const out = await fetchJson('/api/iteration')
    state.iterationStartedAt = out.iterationStartedAt
    iterEls.started.textContent = state.iterationStartedAt
      ? formatTime(new Date(state.iterationStartedAt))
      : '—'
  } catch { /* ignore */ }
  iterEls.depth.textContent = `(depth: 2)` // mirrors the server default; could plumb in via /api/health if needed
  updateLastActivityLabel()
}

function updateLastActivityLabel() {
  if (!state.lastHeatActivityAt) {
    iterEls.lastActivity.textContent = '—'
    return
  }
  const seconds = Math.floor((Date.now() - state.lastHeatActivityAt) / 1000)
  if (seconds < 5) iterEls.lastActivity.textContent = 'hace instantes'
  else if (seconds < 60) iterEls.lastActivity.textContent = `hace ${seconds} s`
  else if (seconds < 3600) iterEls.lastActivity.textContent = `hace ${Math.floor(seconds / 60)} min`
  else iterEls.lastActivity.textContent = `hace ${Math.floor(seconds / 3600)} h`
}

function formatTime(d) {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

async function closeIteration() {
  try {
    const res = await fetch('/api/iteration/close', { method: 'POST' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const out = await res.json()
    state.iterationStartedAt = out.iterationStartedAt
    // Also refresh the global heat (the "iteration" window is now empty).
    void refreshHeat()
    refreshIterationPanel()
  } catch (err) {
    console.error('closeIteration failed', err)
  }
}

$iterToggle.addEventListener('click', () => setIterPanelOpen(!state.iterPanelOpen))
$iterClose.addEventListener('click', () => setIterPanelOpen(false))
$iterCloseBtn.addEventListener('click', closeIteration)

// Alt+I keybinding to toggle the panel — matches the brief.
window.addEventListener('keydown', (ev) => {
  if (ev.altKey && (ev.key === 'i' || ev.key === 'I') && !ev.ctrlKey && !ev.metaKey) {
    ev.preventDefault()
    setIterPanelOpen(!state.iterPanelOpen)
  }
})

// Live "última actividad" updater — runs once a second only when the
// panel is open (cheap; no DOM work when closed).
setInterval(() => {
  if (state.iterPanelOpen) updateLastActivityLabel()
}, 1000)

// ─── Boot ──────────────────────────────────────────────────────────────────

;(async function boot() {
  await Promise.all([refreshTree(), refreshHeat()])
  connectSse()
})()
