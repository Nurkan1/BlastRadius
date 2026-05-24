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
  /** Paths already auto-expanded once. New entries trigger
   *  ancestor expansion; subsequent heat refreshes don't override
   *  the user's manual collapse choices. */
  seenHotPaths: new Set(),
  /** When set, the tree only shows files of this heat color (plus
   *  their ancestor dirs). Clicking the same counter button clears
   *  it. null means "show everything". */
  colorFilter: null,
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
    // Auto-expand ancestors of hot files we haven't surfaced before.
    // This is what closes the "the counter says 3 red but I only see 1
    // in the tree" UX hole: heat files lurking inside collapsed dirs
    // get their parents opened automatically on the first heat update
    // that brings them in. Once a path is in state.seenHotPaths, we
    // don't auto-re-expand its ancestors — if the user manually
    // collapsed a dir, we respect that on subsequent updates.
    autoExpandHotAncestors()
    // If a color filter is active, also force-expand ancestors of any
    // NEW matching file that just appeared — otherwise the filter
    // would silently hide it inside a collapsed dir.
    if (state.colorFilter) expandAllAncestorsOfColor(state.colorFilter)
    renderMetrics()
    renderHeatOverlay()
    // Re-render the tree DOM because state.expanded may have changed.
    render()
    if (state.selected) renderSidePanel()
  } catch (err) {
    console.error('refreshHeat failed', err)
  }
}

function autoExpandHotAncestors() {
  const files = state.heat?.files
  if (!files) return
  for (const path of Object.keys(files)) {
    if (state.seenHotPaths.has(path)) continue
    state.seenHotPaths.add(path)
    // Add every ancestor dir of this file to the expanded set.
    // For "src/components/HelpModal.tsx" that means {"", "src",
    // "src/components"}.
    const parts = path.split('/')
    let cursor = ''
    for (let i = 0; i < parts.length - 1; i += 1) {
      cursor = cursor ? `${cursor}/${parts[i]}` : parts[i]
      state.expanded.add(cursor)
    }
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
  // Phase 5: active repo changed (manual click or auto-switch) — pull
  // fresh tree + heat + repo selector state.
  es.addEventListener('repo-changed', () => {
    void Promise.all([refreshTree(), refreshHeat(), refreshRepoSelector()])
  })
  // Phase 5: the set of detected repos changed (parentDir watcher saw
  // a .git/ appear or disappear). Just refresh the dropdown — the
  // active repo is unchanged.
  es.addEventListener('repos-updated', () => {
    void refreshRepoSelector()
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
  refreshCounterDisabledState()
}

/**
 * Compute the set of paths that should be visible when a color filter
 * is active. A file is visible iff its heat color matches the filter;
 * a directory is visible iff at least one of its descendants is.
 *
 * Returns null when there is no filter (caller should skip the
 * gating step).
 */
function computeVisiblePaths() {
  if (!state.colorFilter) return null
  const files = state.heat?.files ?? {}
  const visible = new Set([''])  // root is always visible
  for (const [path, color] of Object.entries(files)) {
    if (color !== state.colorFilter) continue
    visible.add(path)
    // Mark every ancestor dir as visible too.
    const parts = path.split('/')
    let cursor = ''
    for (let i = 0; i < parts.length - 1; i += 1) {
      cursor = cursor ? `${cursor}/${parts[i]}` : parts[i]
      visible.add(cursor)
    }
  }
  return visible
}

/**
 * Flatten the tree into a render order using d3.hierarchy. Each node
 * keeps {data, depth, path}. Collapsed dirs do not contribute their
 * children to the flattened list. When state.colorFilter is set, only
 * matching files (and their ancestor dirs) appear.
 */
function flattenTree(root) {
  if (!root) return []
  const out = []
  const visible = computeVisiblePaths()
  const visit = (node, depth) => {
    const isRoot = node.path === ''
    if (visible && !isRoot && !visible.has(node.path)) return
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

// ─── Clickable color counters — FILTER the tree by heat color ────────────
//
// The three colored counters in the header are <button>s with a
// data-jump attribute. Click 🔴 N → tree shows ONLY red files (and
// their ancestor dirs, so the path is readable). Click the same
// counter again → filter clears, tree shows everything. Picking a
// different color swaps the filter. Counter at zero disables the
// button so we don't silently no-op.

function expandAncestors(path) {
  if (!path) return
  const parts = path.split('/')
  let cursor = ''
  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor = cursor ? `${cursor}/${parts[i]}` : parts[i]
    state.expanded.add(cursor)
  }
}

function expandAllAncestorsOfColor(color) {
  if (!state.heat?.files) return
  for (const [path, c] of Object.entries(state.heat.files)) {
    if (c === color) expandAncestors(path)
  }
}

function toggleColorFilter(color) {
  if (state.colorFilter === color) {
    // Same button clicked twice → clear filter.
    state.colorFilter = null
  } else {
    state.colorFilter = color
    // Make sure every ancestor of every matching file is open, so the
    // filter actually surfaces them instead of leaving them hidden
    // inside collapsed dirs.
    expandAllAncestorsOfColor(color)
  }
  render()
  refreshCounterActiveState()
}

function refreshCounterDisabledState() {
  const m = state.heat?.metrics ?? {}
  for (const btn of document.querySelectorAll('button.metric[data-jump]')) {
    const color = btn.dataset.jump
    const count = m[color] ?? 0
    btn.disabled = !(count > 0)
    // If the filter was on a color that just dropped to zero (e.g.
    // user closed the iteration), clear the filter so the tree comes
    // back into view.
    if (state.colorFilter === color && count === 0) {
      state.colorFilter = null
    }
  }
  refreshCounterActiveState()
}

function refreshCounterActiveState() {
  for (const btn of document.querySelectorAll('button.metric[data-jump]')) {
    const isActive = state.colorFilter === btn.dataset.jump
    btn.classList.toggle('is-active', isActive)
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false')
  }
}

for (const btn of document.querySelectorAll('button.metric[data-jump]')) {
  btn.addEventListener('click', () => {
    if (btn.disabled) return
    toggleColorFilter(btn.dataset.jump)
  })
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

// ─── Phase 5: wizard + repo selector ───────────────────────────────────────

const $wizard = document.getElementById('wizard-modal')
const $wizardStep1 = $wizard.querySelector('[data-step="1"]')
const $wizardStep2 = $wizard.querySelector('[data-step="2"]')
const $wizardCandidates = document.getElementById('wizard-candidates')
const $wizardManual = document.getElementById('wizard-manual-path')
const $wizardError = document.getElementById('wizard-error')
const $wizardStep1Next = document.getElementById('wizard-step1-next')
const $wizardBack = document.getElementById('wizard-back')
const $wizardFinish = document.getElementById('wizard-finish')
const $wizardStep2Parent = document.getElementById('wizard-step2-parent')
const $wizardRepoPreview = document.getElementById('wizard-repo-preview')
const $wizardAutoSwitch = document.getElementById('wizard-autoswitch')

const $repoSelector = document.getElementById('repo-selector')
const $repoTrigger = document.getElementById('repo-selector-trigger')
const $repoMenu = document.getElementById('repo-selector-menu')
const $repoName = document.getElementById('repo-selector-name')
const $repoAutoSwitch = document.getElementById('repo-autoswitch')

const wizardState = {
  /** Candidates returned by the server-side detection — see /api/preferences/candidates
   *  if we ever add one; for now we hardcode a small list and let the user
   *  pick + manual-input. */
  candidates: [],
  selected: null,
  detectedRepos: [],
}

// Candidate parent dirs to suggest. The server doesn't enforce these —
// they're just convenience pre-fills. We could probe via fetch but the
// brief says "candidatos comunes" → small hardcoded list, the input
// covers the rest.
const COMMON_PARENT_CANDIDATES = [
  '~/Documents',
  '~/Documents/code',
  '~/projects',
  '~/code',
  '~/workspace',
  '~/dev',
]

async function probeCandidate(displayPath) {
  // We can't directly stat from the browser; ask the server via a
  // dry-run POST that doesn't save. Pragmatic: just save and re-save.
  // For now we don't validate candidates pre-click — the server returns
  // 400 if the path doesn't exist, and we surface the error inline.
  return displayPath
}

function showWizard() {
  $wizard.hidden = false
  document.body.style.overflow = 'hidden'
  // Pre-populate candidates list. We can't probe FS from the browser,
  // so we just list well-known paths and the server validates on submit.
  $wizardCandidates.innerHTML = ''
  for (const cand of COMMON_PARENT_CANDIDATES) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'wizard-candidate'
    btn.textContent = cand
    btn.addEventListener('click', () => {
      // ~ doesn't get expanded by the browser; let the user know.
      $wizardManual.value = cand
      // Mark as selected
      for (const b of $wizardCandidates.querySelectorAll('.wizard-candidate')) {
        b.classList.toggle('is-selected', b === btn)
      }
      wizardState.selected = cand
      $wizardStep1Next.disabled = false
      $wizardError.hidden = true
    })
    $wizardCandidates.appendChild(btn)
  }
}

function hideWizard() {
  $wizard.hidden = true
  document.body.style.overflow = ''
}

$wizardManual.addEventListener('input', () => {
  const v = $wizardManual.value.trim()
  wizardState.selected = v
  $wizardStep1Next.disabled = !v
  $wizardError.hidden = true
  for (const b of $wizardCandidates.querySelectorAll('.wizard-candidate')) {
    b.classList.toggle('is-selected', b.textContent === v)
  }
})

$wizardStep1Next.addEventListener('click', async () => {
  const parentDir = (wizardState.selected || '').trim()
  if (!parentDir) return
  // Server expands ~ for us if we ever wire that in; for now we just
  // forward the raw string. The server enforces existsSync + isDir.
  try {
    const res = await fetch('/api/preferences', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentDir }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      $wizardError.hidden = false
      $wizardError.textContent = body.message || `HTTP ${res.status}`
      return
    }
    // Move to step 2
    $wizardStep2Parent.textContent = body.preferences?.parentDir || parentDir
    $wizardStep1.hidden = true
    $wizardStep2.hidden = false
    // Fetch detected repos for preview
    $wizardRepoPreview.innerHTML = '<li class="wizard-empty">Escaneando…</li>'
    const reposRes = await fetch('/api/repos?refresh=1')
    const reposBody = await reposRes.json()
    wizardState.detectedRepos = reposBody.repos || []
    renderWizardPreview()
  } catch (err) {
    $wizardError.hidden = false
    $wizardError.textContent = String(err.message || err)
  }
})

function renderWizardPreview() {
  $wizardRepoPreview.innerHTML = ''
  if (wizardState.detectedRepos.length === 0) {
    const li = document.createElement('li')
    li.className = 'wizard-empty'
    li.textContent = 'No se detectaron repos con actividad reciente.'
    $wizardRepoPreview.appendChild(li)
    return
  }
  for (const r of wizardState.detectedRepos) {
    const li = document.createElement('li')
    const name = document.createElement('span')
    name.className = 'preview-name'
    name.textContent = r.name
    const meta = document.createElement('span')
    meta.className = 'preview-meta'
    meta.textContent = r.lastActivity ? `${humanAgo(r.lastActivity)} · ${r.eventCount} eventos` : 'sin actividad'
    li.appendChild(name)
    li.appendChild(meta)
    $wizardRepoPreview.appendChild(li)
  }
}

$wizardBack.addEventListener('click', () => {
  $wizardStep2.hidden = true
  $wizardStep1.hidden = false
})

$wizardFinish.addEventListener('click', async () => {
  // Persist autoSwitch + always pick the top-ranked repo so the
  // dashboard isn't stuck at an empty state. With autoSwitch ON, the
  // server's 10-s interval may pick a different one later based on
  // sustained activity — but until then, having SOMETHING active
  // beats an empty tree.
  const autoSwitch = $wizardAutoSwitch.checked
  await fetch('/api/preferences', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ autoSwitch }),
  })
  if (wizardState.detectedRepos.length > 0) {
    await fetch('/api/repos/select', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: wizardState.detectedRepos[0].path }),
    }).catch(() => {})
  }
  hideWizard()
  await bootAfterWizard()
})

// ─── Phase 5 fix: standalone "change parent dir" settings modal ────────────

const $settingsModal = document.getElementById('settings-modal')
const $settingsInput = document.getElementById('settings-parent-input')
const $settingsError = document.getElementById('settings-error')
const $settingsCancel = document.getElementById('settings-cancel')
const $settingsSave = document.getElementById('settings-save')

function openSettingsModal(currentParent) {
  $settingsInput.value = currentParent || ''
  $settingsError.hidden = true
  $settingsError.textContent = ''
  $settingsModal.hidden = false
  document.body.style.overflow = 'hidden'
  // Close any open dropdown so it doesn't visually overlap
  $repoMenu.hidden = true
  $repoTrigger.setAttribute('aria-expanded', 'false')
  setTimeout(() => $settingsInput.focus(), 0)
}

function closeSettingsModal() {
  $settingsModal.hidden = true
  document.body.style.overflow = ''
}

$settingsCancel.addEventListener('click', closeSettingsModal)

// Click outside the card closes it
$settingsModal.addEventListener('click', (ev) => {
  if (/** @type {HTMLElement} */ (ev.target).classList.contains('wizard-backdrop')) {
    closeSettingsModal()
  }
})

// Escape closes it (and only it — diff modal handler is gated on its
// own hidden flag, so they don't interfere)
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !$settingsModal.hidden) {
    ev.preventDefault()
    closeSettingsModal()
  }
})

$settingsSave.addEventListener('click', async () => {
  const parentDir = $settingsInput.value.trim()
  if (!parentDir) {
    $settingsError.hidden = false
    $settingsError.textContent = 'La ruta no puede estar vacía.'
    return
  }
  $settingsSave.disabled = true
  try {
    const res = await fetch('/api/preferences', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentDir }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      $settingsError.hidden = false
      $settingsError.textContent = body.message || `HTTP ${res.status}`
      return
    }
    closeSettingsModal()
    // If the server cleared currentRepo (because the old one no longer
    // fits under the new parentDir), needsSetup flips back on. The SSE
    // `repos-updated` will trigger refreshRepoSelector(); we also pull
    // /api/preferences to decide whether to re-open the wizard.
    const prefs = await fetchJson('/api/preferences')
    if (prefs.needsSetup || !prefs.currentRepo) {
      // No active repo any more → re-open the wizard so the user picks
      // a fresh one from the new parent dir.
      showWizard()
      // Pre-fill step 1 with the new parent (already saved server-side)
      $wizardManual.value = prefs.parentDir || parentDir
      wizardState.selected = prefs.parentDir || parentDir
      $wizardStep1Next.disabled = false
    } else {
      // Active repo still valid under the new parent → just refresh
      await Promise.all([refreshTree(), refreshHeat(), refreshRepoSelector()])
    }
  } catch (err) {
    $settingsError.hidden = false
    $settingsError.textContent = String(err.message || err)
  } finally {
    $settingsSave.disabled = false
  }
})

// ─── Repo selector (header dropdown) ──────────────────────────────────────

let lastRepoSelectAt = 0

async function refreshRepoSelector() {
  try {
    const [reposRes, prefsRes] = await Promise.all([
      fetch('/api/repos'),
      fetch('/api/preferences'),
    ])
    const reposBody = await reposRes.json()
    const prefs = await prefsRes.json()
    const repos = reposBody.repos || []

    if (prefs.needsSetup) {
      $repoSelector.hidden = true
      return
    }
    $repoSelector.hidden = false

    // Update active label
    const active = repos.find((r) => r.isActive) ?? null
    $repoName.textContent = active?.name ?? prefs.currentRepo?.split('/').pop() ?? '—'

    // Update autoSwitch toggle
    $repoAutoSwitch.setAttribute('aria-pressed', prefs.autoSwitch ? 'true' : 'false')
    $repoAutoSwitch.textContent = prefs.autoSwitch ? 'auto' : 'manual'

    // Populate menu
    $repoMenu.innerHTML = ''
    if (repos.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'repo-option-empty'
      empty.textContent = 'No hay repos con actividad reciente'
      $repoMenu.appendChild(empty)
    } else {
      for (const r of repos) {
        const opt = document.createElement('div')
        opt.className = 'repo-option'
          + (r.isActive ? ' is-active' : '')
          + (r.lastActivity ? '' : ' is-idle')
        opt.setAttribute('role', 'option')
        opt.setAttribute('aria-selected', r.isActive ? 'true' : 'false')
        const name = document.createElement('span')
        name.className = 'repo-option-name'
        name.textContent = r.name
        const meta = document.createElement('span')
        meta.className = 'repo-option-meta'
        meta.textContent = r.lastActivity
          ? `${humanAgo(r.lastActivity)} · ${r.eventCount} eventos`
          : 'sin actividad'
        opt.appendChild(name)
        opt.appendChild(meta)
        opt.addEventListener('click', () => selectRepo(r.path))
        $repoMenu.appendChild(opt)
      }
    }
    // Footer: "Cambiar directorio padre…" — always visible so the user
    // can re-point at a different parentDir without having to delete
    // ~/.blastradius/preferences.json by hand.
    const footer = document.createElement('div')
    footer.className = 'repo-option-footer'
    const changeBtn = document.createElement('button')
    changeBtn.type = 'button'
    changeBtn.className = 'repo-option-action'
    changeBtn.textContent = '⚙ Cambiar directorio padre…'
    changeBtn.dataset.parent = prefs.parentDir || ''
    changeBtn.addEventListener('click', () => openSettingsModal(prefs.parentDir || ''))
    footer.appendChild(changeBtn)
    $repoMenu.appendChild(footer)
  } catch (err) {
    console.error('refreshRepoSelector failed', err)
  }
}

async function selectRepo(repoPath) {
  // 200ms debounce against rapid clicks
  const now = Date.now()
  if (now - lastRepoSelectAt < 200) return
  lastRepoSelectAt = now

  try {
    const res = await fetch('/api/repos/select', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: repoPath }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      console.error('repo select failed', body)
      return
    }
    $repoMenu.hidden = true
    $repoTrigger.setAttribute('aria-expanded', 'false')
    // Refresh everything to match the new repo
    await Promise.all([refreshTree(), refreshHeat(), refreshRepoSelector()])
  } catch (err) {
    console.error('selectRepo failed', err)
  }
}

$repoTrigger.addEventListener('click', () => {
  const open = $repoMenu.hidden
  $repoMenu.hidden = !open
  $repoTrigger.setAttribute('aria-expanded', open ? 'true' : 'false')
})

document.addEventListener('click', (ev) => {
  // Close menu when clicking outside
  if (!$repoSelector.contains(ev.target)) {
    $repoMenu.hidden = true
    $repoTrigger.setAttribute('aria-expanded', 'false')
  }
})

$repoAutoSwitch.addEventListener('click', async () => {
  const currentlyOn = $repoAutoSwitch.getAttribute('aria-pressed') === 'true'
  try {
    await fetch('/api/preferences', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoSwitch: !currentlyOn }),
    })
    refreshRepoSelector()
  } catch (err) {
    console.error('toggle autoSwitch failed', err)
  }
})

function humanAgo(iso) {
  if (!iso) return 'sin actividad'
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return 'sin actividad'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `hace ${s} s`
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`
  if (s < 86_400) return `hace ${Math.floor(s / 3600)} h`
  return `hace ${Math.floor(s / 86_400)} d`
}

// ─── Boot ──────────────────────────────────────────────────────────────────

async function bootAfterWizard() {
  // Re-attach SSE if it wasn't already; reload tree + heat for the new repo.
  await Promise.all([refreshTree(), refreshHeat(), refreshRepoSelector()])
}

;(async function boot() {
  // Phase 5: check needsSetup BEFORE trying to fetch tree/heat (which
  // would just return 503 in wizard mode).
  let prefs
  try {
    prefs = await fetchJson('/api/preferences')
  } catch {
    prefs = { needsSetup: true }
  }
  // SSE always — even in wizard mode we want to know when prefs change.
  connectSse()

  if (prefs.needsSetup) {
    showWizard()
    return
  }
  await Promise.all([refreshTree(), refreshHeat(), refreshRepoSelector()])
})()

