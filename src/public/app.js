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

import { shouldShowServerDeadBanner } from './serverHealth.js'

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
  green: document.querySelector('[data-metric="green"]'),
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
  green: document.getElementById('iter-green'),
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
  heat: { files: {}, metrics: { red: 0, green: 0, yellow: 0, total: 0, blastRadius: 0 } },
  windowName: 'session',
  platform: 'all',
  /** rc7+: when not null, the heat map is loaded for a date range
   *  instead of the live time-window slice. Shape: { from, to } where
   *  both are 'YYYY-MM-DD' strings. While set, the window-toggle
   *  (Iteration/Hour/Session) is disabled and SSE heat-updates are
   *  ignored (historical ranges are immutable, no live tail). */
  dateRange: null,
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
  /** ISO of the effective iteration-window start. With no explicit
   *  marker this is `now - 3min`; with a marker it equals the marker
   *  itself. Populated by /api/iteration. */
  iterationEffectiveStart: null,
  /** True when iterationStartedAt comes from an explicit user-close
   *  rather than the rolling-window heuristic. */
  iterationIsExplicit: false,
  /** Wall-clock ms of the most recent in-window event. Updated from
   *  /api/iteration (authoritative, from the log) and from the SSE
   *  heat-update event (instant feedback). */
  lastHeatActivityAt: null,
  /** Background cache of diff stats per path so the hover tooltip is snappy
   *  after the first hover. Invalidated on every heat-update. */
  diffStatsCache: new Map(),
  /** Tracks the timer for the 1s hover-delay tooltip; cancelable on mouseleave. */
  hoverTimer: null,
  hoverPath: null,

  /** Wall-clock ms when the server's auto-switch snooze ends. null
   *  means "not snoozed". Populated from /api/preferences on boot
   *  and from the repo-changed SSE event after every manual switch. */
  autoSwitchSnoozedUntil: null,
}

// ─── Networking ────────────────────────────────────────────────────────────

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts)
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.json()
}

/**
 * Like fetchJson but retries with exponential backoff when the fetch
 * outright fails (network error, server not up yet) OR the response
 * is HTML — that's the symptom of the Tauri bundle hitting its SPA
 * fallback before the sidecar Node server has finished listening.
 * Used only for the boot-time `/api/preferences` call: subsequent
 * fetches happen after the dashboard has confirmed the server is
 * alive, so plain `fetchJson` is enough.
 */
async function fetchJsonWithRetry(url, { attempts = 8, baseDelayMs = 250 } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Tauri's SPA fallback returns index.html (Content-Type: text/html)
      // before the sidecar server is up. Reject that explicitly so we
      // retry instead of crashing the JSON parse downstream.
      const ct = res.headers.get('content-type') || ''
      if (!ct.includes('application/json')) throw new Error(`non-JSON response (${ct})`)
      return await res.json()
    } catch (err) {
      lastErr = err
      // 250ms, 500ms, 1s, 2s, 2s, 2s … capped at 2s.
      const delay = Math.min(baseDelayMs * 2 ** i, 2_000)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr ?? new Error(`${url} retries exhausted`)
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
    // rc7+: when a date range is active, the URL adds since= / until=
    // and the time-window param is omitted (the API forces 'session'
    // semantics when a range is provided — see routes.js comment).
    let url
    if (state.dateRange) {
      const { from, to } = state.dateRange
      url = `/api/heat?since=${encodeURIComponent(from)}&until=${encodeURIComponent(to)}&platform=${encodeURIComponent(state.platform)}`
    } else {
      url = `/api/heat?window=${encodeURIComponent(state.windowName)}&platform=${encodeURIComponent(state.platform)}`
    }
    state.heat = await fetchJson(url)
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
    // rc8 bugfix — only repaint the Tree-mode side panel when we are
    // actually in Tree mode. In Graph mode the side panel hosts the
    // inline summary+tags editor for the selected node; the
    // Tree-mode renderSidePanel() doesn't know about that markup and
    // would overwrite the editor (and any in-progress text) on every
    // incoming heat-update SSE event.
    if (state.selected && document.querySelector('.layout')?.getAttribute('data-view') !== 'graph') {
      renderSidePanel()
    }
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
  // rc7+: when a historical date range is active, ignore live SSE
  // refresh nudges — past days are immutable and new edits do not
  // belong in their heat slice. The user explicitly returns to the
  // live view by clicking "Today" in the range selector.
  if (state.dateRange) return
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

// ─── Server-dead detection (rc8.5) ───────────────────────────────────────────
//
// EventSource fires `error` on every transient blip and reconnects on
// its own. We only surface the alarming "server stopped" banner after
// SERVER_DEAD_FAILURE_THRESHOLD consecutive failures AND a confirming
// failed /api/health probe (decision in serverHealth.js). On a clean
// `open` we reset the counter and hide the banner.
const $serverDeadBanner = document.getElementById('server-dead-banner')
const $serverDeadRetry = document.getElementById('server-dead-retry')
const serverDead = {
  consecutiveFailures: 0,
  healthOk: true,
  probeInFlight: false,
}

async function probeHealth() {
  if (serverDead.probeInFlight) return serverDead.healthOk
  serverDead.probeInFlight = true
  try {
    // Same-origin fetch — no CORS concern (the dashboard IS served by
    // this origin). A 2 s abort keeps a hung socket from wedging the
    // probe loop.
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2000)
    const res = await fetch('/api/health', { signal: ctrl.signal, cache: 'no-store' })
    clearTimeout(t)
    serverDead.healthOk = res.ok
  } catch {
    serverDead.healthOk = false
  } finally {
    serverDead.probeInFlight = false
  }
  return serverDead.healthOk
}

function renderServerDeadBanner() {
  if (!$serverDeadBanner) return
  const show = shouldShowServerDeadBanner(serverDead.consecutiveFailures, serverDead.healthOk)
  $serverDeadBanner.hidden = !show
}

async function onSseFailure() {
  serverDead.consecutiveFailures += 1
  // Confirm with an out-of-band health probe before alarming — SSE
  // error alone is too noisy (a heat-update mid-flight can trip it).
  await probeHealth()
  renderServerDeadBanner()
}

function onSseAlive() {
  serverDead.consecutiveFailures = 0
  serverDead.healthOk = true
  renderServerDeadBanner()
}

if ($serverDeadRetry) {
  $serverDeadRetry.addEventListener('click', async () => {
    $serverDeadRetry.disabled = true
    const ok = await probeHealth()
    if (ok) {
      // Server is back — reset state, hide banner, and let the existing
      // EventSource auto-reconnect (or nudge a fresh data pull).
      serverDead.consecutiveFailures = 0
      renderServerDeadBanner()
      void refreshHeat()
    } else {
      renderServerDeadBanner()
    }
    $serverDeadRetry.disabled = false
  })
}

function connectSse() {
  setConnectionState('connecting…', 'connecting')
  const es = new EventSource('/api/events')
  // Expose the live EventSource so add-on modules (e.g. the rc5 MCP
  // usage panel at the bottom of this file) can attach their own
  // listeners without opening a second connection.
  window.__blastradiusSse = es
  es.addEventListener('open', () => {
    setConnectionState('live', 'open')
    onSseAlive()
  })
  es.addEventListener('error', () => {
    setConnectionState('reconnecting…', 'error')
    void onSseFailure()
  })
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
  // fresh tree + heat + repo selector state. The repo-changed payload
  // also carries autoSwitchSnoozedUntil (non-null when a manual switch
  // armed the snooze), which the button uses to paint the countdown.
  es.addEventListener('repo-changed', (ev) => {
    try {
      const data = JSON.parse(ev.data || '{}')
      if (typeof data.autoSwitchSnoozedUntil === 'number') {
        state.autoSwitchSnoozedUntil = data.autoSwitchSnoozedUntil
      } else if (data.autoSwitchSnoozedUntil === null) {
        state.autoSwitchSnoozedUntil = null
      }
    } catch {
      // SSE payload garbled — fall back to the value /api/preferences
      // returns on the next refresh.
    }
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
  metricEls.green.textContent = m.green ?? 0
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
      // Red files open the diff modal directly on click; cold/green/
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
    ? `<button type="button" class="side-open-diff" id="side-open-diff">Open diff</button>`
    : `<div class="diff-placeholder">Only red files have a diff to view. This file is <b>${heat}</b>.</div>`

  // "Affected by" section: only renders when the selected file is
  // yellow AND the server returned propagation info for it. The list
  // walks the user from "this yellow → caused by these reds → which
  // had these changes" by being click-navigable.
  const origins = (heat === 'yellow' && state.heat.propagation)
    ? state.heat.propagation[state.selected]
    : null
  const affectedByHtml = origins && origins.length > 0
    ? renderAffectedBy(origins)
    : ''

  const attribution = state.heat?.attributions?.[state.selected] ?? null
  const attributionHtml = attribution
    ? `<dt>Last Agent</dt><dd><span class="agent-pill agent-${attribution.toLowerCase().replace(/[^a-z0-9]/g, '-')}">${escapeHtml(attribution)}</span></dd>`
    : ''

  $sideBody.innerHTML = `
    <dl class="side-meta">
      <dt>Path</dt>
      <dd>${escapeHtml(state.selected)}</dd>
      <dt>Heat</dt>
      <dd><span class="heat-pill heat-${heat}">${heat}</span></dd>
      ${attributionHtml}
      <dt>Window</dt>
      <dd>${state.windowName}</dd>
    </dl>
    ${affectedByHtml}
    <div class="side-section">
      <h3>Diff preview</h3>
      ${diffButtonHtml}
    </div>
  `
  const $openDiff = document.getElementById('side-open-diff')
  if ($openDiff) $openDiff.addEventListener('click', () => openDiffModal(state.selected))

  // Wire click handlers on each "Affected by" entry so users can
  // navigate yellow → red without leaving the side panel.
  for (const btn of $sideBody.querySelectorAll('button[data-affected-by]')) {
    btn.addEventListener('click', () => {
      const redPath = btn.dataset.affectedBy
      if (!redPath) return
      // Mimic the tree click: select the file in the panel and, if
      // it's still red, open its diff modal so the user immediately
      // sees what changed.
      selectFile({ path: redPath, type: 'file' })
      const redHeat = state.heat.files?.[redPath]
      if (redHeat === 'red') openDiffModal(redPath)
    })
  }
}

/**
 * Render the "Affected by" section: list of red files (with depth
 * badges) that originated the currently-selected yellow file.
 * Buttons carry a `data-affected-by` attribute the click handler
 * uses to navigate.
 */
function renderAffectedBy(origins) {
  const items = origins.map((origin) => {
    const safePath = escapeHtml(origin.path)
    return `
      <li>
        <button type="button" class="affected-by-item" data-affected-by="${safePath}">
          <span class="affected-by-path">${safePath}</span>
          <span class="affected-by-depth">depth ${origin.depth}</span>
        </button>
      </li>
    `
  }).join('')
  return `
    <div class="side-section">
      <h3>Affected by</h3>
      <p class="side-hint affected-by-hint">
        ${origins.length === 1
          ? 'This file imports (directly or transitively) a red file:'
          : `This file imports (directly or transitively) ${origins.length} red files:`}
      </p>
      <ul class="affected-by">${items}</ul>
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

// ─── Platform/Agent filter toggle ──────────────────────────────────────────

const $platformButtons = document.querySelectorAll('.platform-toggle button')

function setPlatform(name) {
  if (state.platform === name) return
  state.platform = name
  for (const btn of $platformButtons) {
    btn.setAttribute('aria-selected', btn.dataset.platform === name ? 'true' : 'false')
  }
  void refreshHeat()
  if (state.iterPanelOpen) void refreshIterationPanel()
}

for (const btn of $platformButtons) {
  btn.addEventListener('click', () => setPlatform(btn.dataset.platform))
}

// Initial visual state of platform toggle
;(() => {
  for (const btn of $platformButtons) {
    if (btn.getAttribute('aria-selected') === 'true') state.platform = btn.dataset.platform
  }
})()


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

function diffSourceLabel(out) {
  // Honest label describing which diff the user is looking at:
  //   - "uncommitted" → unstaged working-tree changes vs HEAD
  //   - "commit <sha>" → the last commit that touched the file
  //   - "untracked" → a brand-new file, shown as a full "added" diff
  //   - explicit ref → "ref: <ref>"
  if (!out) return ''
  switch (out.source) {
    case 'uncommitted': return 'uncommitted changes'
    case 'commit': return out.shortSha ? `commit ${out.shortSha}` : 'last commit'
    case 'untracked': return 'new file'
    case 'ref': return out.ref ? `ref: ${out.ref}` : 'against ref'
    default: return ''
  }
}

async function openDiffModal(path) {
  hideTooltip()
  $diffModal.hidden = false
  $diffModalTitle.textContent = path
  $diffModalStats.hidden = true
  // Wipe any leftover source badge from a previous open so it doesn't
  // mis-label the new file during the load.
  const $sourceBadgeReset = document.getElementById('diff-modal-source')
  if ($sourceBadgeReset) {
    $sourceBadgeReset.hidden = true
    $sourceBadgeReset.textContent = ''
    delete $sourceBadgeReset.dataset.source
  }
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

    // Honest title: the path is the primary label; the source goes
    // into a separate pill badge so long paths don't squash it.
    $diffModalTitle.textContent = path
    const sourceLabel = diffSourceLabel(out)
    const $sourceBadge = document.getElementById('diff-modal-source')
    if ($sourceBadge) {
      if (sourceLabel) {
        $sourceBadge.textContent = sourceLabel
        $sourceBadge.dataset.source = out.source || ''
        $sourceBadge.hidden = false
      } else {
        $sourceBadge.hidden = true
      }
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
    const heat = await fetchJson(`/api/heat?window=iteration&platform=${encodeURIComponent(state.platform)}`)
    const m = heat.metrics ?? {}
    iterEls.red.textContent = m.red ?? 0
    iterEls.green.textContent = m.green ?? 0
    iterEls.yellow.textContent = m.yellow ?? 0
    iterEls.radius.textContent = m.blastRadius ?? 0
  } catch {
    // Network blip — keep the previous numbers on screen.
  }
  // Pull iteration timing. The server returns BOTH the explicit
  // marker (null until the user closes an iteration manually) AND
  // the effective window start + last-event timestamp from the log,
  // so we always have something useful to show even when no SSE
  // heat-update has fired yet.
  try {
    const out = await fetchJson('/api/iteration')
    state.iterationStartedAt = out.iterationStartedAt
    state.iterationEffectiveStart = out.effectiveStart ?? null
    state.iterationIsExplicit = !!out.isExplicit
    // Prefer the server-reported lastEventTs (always accurate, derived
    // from the log) over the SSE-driven heuristic in state.
    if (out.lastEventTs) {
      state.lastHeatActivityAt = Date.parse(out.lastEventTs)
    }
    // STARTED label honors the two modes:
    //   - explicit marker: show the clock time the user closed the
    //     previous iteration ("Started 14:32:05")
    //   - default (no marker yet): show that we're using the rolling
    //     3-min window so the user understands why no exact start time
    //     exists yet.
    if (state.iterationIsExplicit && state.iterationStartedAt) {
      iterEls.started.textContent = formatTime(new Date(state.iterationStartedAt))
    } else if (state.iterationEffectiveStart) {
      const startStr = formatTime(new Date(state.iterationEffectiveStart))
      iterEls.started.textContent = `rolling (since ${startStr})`
    } else {
      iterEls.started.textContent = '—'
    }
  } catch { /* network blip — keep previous values */ }
  iterEls.depth.textContent = `(depth: 2)` // mirrors the server default; could plumb in via /api/health if needed
  updateLastActivityLabel()
}

function updateLastActivityLabel() {
  if (!state.lastHeatActivityAt) {
    // No event in the iteration window at all → say so explicitly
    // instead of an opaque em-dash.
    iterEls.lastActivity.textContent = 'no events yet'
    return
  }
  const seconds = Math.floor((Date.now() - state.lastHeatActivityAt) / 1000)
  if (seconds < 5) iterEls.lastActivity.textContent = 'just now'
  else if (seconds < 60) iterEls.lastActivity.textContent = `${seconds}s ago`
  else if (seconds < 3600) iterEls.lastActivity.textContent = `${Math.floor(seconds / 60)}m ago`
  else iterEls.lastActivity.textContent = `${Math.floor(seconds / 3600)}h ago`
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

// Live "last activity" updater — runs once a second only when the
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
    $wizardRepoPreview.innerHTML = '<li class="wizard-empty">Scanning…</li>'
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
    li.textContent = 'No repos detected with recent activity.'
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
    meta.textContent = r.lastActivity ? `${humanAgo(r.lastActivity)} · ${r.eventCount} events` : 'no activity'
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
    $settingsError.textContent = 'Path cannot be empty.'
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

    // Update autoSwitch toggle (and capture snooze state so the
    // countdown badge can paint immediately, not on the next SSE).
    $repoAutoSwitch.setAttribute('aria-pressed', prefs.autoSwitch ? 'true' : 'false')
    if (typeof prefs.autoSwitchSnoozedUntil === 'number') {
      state.autoSwitchSnoozedUntil = prefs.autoSwitchSnoozedUntil
    } else if (prefs.autoSwitchSnoozedUntil === null) {
      state.autoSwitchSnoozedUntil = null
    }
    paintAutoSwitchButton(prefs.autoSwitch)

    // Populate menu
    $repoMenu.innerHTML = ''
    if (repos.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'repo-option-empty'
      empty.textContent = 'No repos with recent activity'
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
          ? `${humanAgo(r.lastActivity)} · ${r.eventCount} events`
          : 'no activity'
        opt.appendChild(name)
        opt.appendChild(meta)
        opt.addEventListener('click', () => selectRepo(r.path))
        $repoMenu.appendChild(opt)
      }
    }
    // Footer: "Change parent directory…" — always visible so the user
    // can re-point at a different parentDir without having to delete
    // ~/.blastradius/preferences.json by hand.
    const footer = document.createElement('div')
    footer.className = 'repo-option-footer'
    const changeBtn = document.createElement('button')
    changeBtn.type = 'button'
    changeBtn.className = 'repo-option-action'
    changeBtn.textContent = '⚙ Change parent directory…'
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

/**
 * Paint the auto/manual toggle. Three visual states:
 *   - autoSwitch OFF       → "manual" (no-op snooze; nothing changes)
 *   - autoSwitch ON, no snooze → "auto"
 *   - autoSwitch ON + snooze active → "snoozed M:SS" with a yellow
 *     tint and a tooltip explaining what's happening.
 *
 * The snooze is server-side state that ticks down on its own. We
 * just read the wall-clock delta and re-render every second.
 */
function paintAutoSwitchButton(autoSwitch) {
  const now = Date.now()
  const until = state.autoSwitchSnoozedUntil
  const snoozeActive = autoSwitch && typeof until === 'number' && until > now
  if (!autoSwitch) {
    $repoAutoSwitch.textContent = 'manual'
    $repoAutoSwitch.classList.remove('is-snoozed')
    $repoAutoSwitch.title = 'Click to enable auto-switch'
    return
  }
  if (!snoozeActive) {
    $repoAutoSwitch.textContent = 'auto'
    $repoAutoSwitch.classList.remove('is-snoozed')
    $repoAutoSwitch.title = 'Auto-switch is on. Manual repo selection pauses it for 5 min.'
    // If we just crossed the snooze boundary, clear the state so a
    // stale value doesn't keep painting "snoozed 0:00".
    if (until && until <= now) state.autoSwitchSnoozedUntil = null
    return
  }
  const remainingSec = Math.max(0, Math.ceil((until - now) / 1000))
  const mm = Math.floor(remainingSec / 60)
  const ss = remainingSec % 60
  $repoAutoSwitch.textContent = `snoozed ${mm}:${ss.toString().padStart(2, '0')}`
  $repoAutoSwitch.classList.add('is-snoozed')
  $repoAutoSwitch.title = 'Auto-switch is paused after your manual selection. Resumes automatically.'
}

// Tick the badge every second so the countdown stays fresh without
// spamming the server. The function is cheap when nothing is snoozed
// (DOM writes are guarded by class equality inside paint).
setInterval(() => {
  const isAuto = $repoAutoSwitch.getAttribute('aria-pressed') === 'true'
  if (isAuto && state.autoSwitchSnoozedUntil) paintAutoSwitchButton(true)
}, 1000)

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
  if (!iso) return 'no activity'
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return 'no activity'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

// ─── Boot ──────────────────────────────────────────────────────────────────

async function bootAfterWizard() {
  // Re-attach SSE if it wasn't already; reload tree + heat for the new repo.
  await Promise.all([refreshTree(), refreshHeat(), refreshRepoSelector()])
}

// ─── Stale-server banner (server SHA awareness) ────────────────────────────
//
// /api/health reports the SHA the server BOOTED on and the SHA on disk
// RIGHT NOW. When they differ — e.g. you applied a server-side patch
// and forgot to restart `run.bat` — we show a dismissable banner so
// you don't waste time wondering why the new behavior isn't kicking in.

const STALE_BANNER_DISMISS_KEY = 'blastradius:staleBannerDismissedFor'
const $staleBanner = document.getElementById('stale-banner')
const $staleServerSha = document.getElementById('stale-server-sha')
const $staleCurrentSha = document.getElementById('stale-current-sha')
const $staleBannerClose = document.getElementById('stale-banner-close')

async function checkServerStaleness() {
  if (!$staleBanner) return
  try {
    const health = await fetchJson('/api/health')
    // Banner is keyed by the SHA pair so dismissing it for one commit
    // doesn't permanently silence future drift. Once HEAD moves again
    // the new pair re-triggers the banner.
    const pairKey = `${health.serverStartShaShort ?? '?'}→${health.currentShaShort ?? '?'}`
    const dismissedFor = sessionStorage.getItem(STALE_BANNER_DISMISS_KEY)
    if (health.stale && dismissedFor !== pairKey) {
      $staleServerSha.textContent = health.serverStartShaShort ?? '?'
      $staleCurrentSha.textContent = health.currentShaShort ?? '?'
      $staleBanner.hidden = false
      $staleBanner.dataset.pair = pairKey
    } else {
      $staleBanner.hidden = true
    }
  } catch {
    // /api/health unreachable means SSE will also be down; the
    // connection badge already surfaces that. No banner needed.
    $staleBanner.hidden = true
  }
}

if ($staleBannerClose) {
  $staleBannerClose.addEventListener('click', () => {
    const pair = $staleBanner?.dataset?.pair
    if (pair) sessionStorage.setItem(STALE_BANNER_DISMISS_KEY, pair)
    $staleBanner.hidden = true
  })
}

// Re-poll periodically so the banner appears even if the user leaves
// the tab open across a commit + (forgotten) restart. 30 s is rare
// enough to not be wasteful and frequent enough to be useful.
setInterval(checkServerStaleness, 30_000)

;(async function boot() {
  // Phase 5: check needsSetup BEFORE trying to fetch tree/heat (which
  // would just return 503 in wizard mode).
  //
  // We use the retry-aware fetch here specifically because in the
  // Tauri-bundled build the WebView is ready before the sidecar Node
  // process has finished listening on :7842. Without retries the very
  // first /api/preferences would either fail or (worse) return the
  // SPA-fallback HTML, which gave us the "Unexpected token '<'" wizard
  // crash. After this initial hop the server is guaranteed up and we
  // can use plain fetchJson everywhere else.
  let prefs
  try {
    prefs = await fetchJsonWithRetry('/api/preferences')
  } catch {
    prefs = { needsSetup: true }
  }
  // SSE always — even in wizard mode we want to know when prefs change.
  connectSse()

  // Fire-and-forget on boot — the banner state doesn't gate the tree
  // / heat fetches, but we want to surface staleness ASAP if relevant.
  void checkServerStaleness()

  if (prefs.needsSetup) {
    showWizard()
    return
  }
  // rc8+: restore the persisted view mode BEFORE the first render so
  // the user sees the right pane immediately, without a flicker from
  // Tree → Graph. setViewMode() also kicks off the first /api/graph
  // fetch when graph mode is active.
  if (typeof window.__brSetViewMode === 'function') {
    window.__brSetViewMode(prefs.viewMode === 'graph' ? 'graph' : 'tree', { persist: false })
  }
  await Promise.all([refreshTree(), refreshHeat(), refreshRepoSelector()])
})()

// ─── rc5: Help modal ───────────────────────────────────────────────────────
//
// Self-contained module — no backend calls, no shared state with the
// dashboard rendering loop. Owns its own DOM event listeners and tears
// them down via the same hidden-attribute pattern as the diff modal.

;(() => {
  const $helpModal = document.getElementById('help-modal')
  const $helpToggle = document.getElementById('toggle-help')
  if (!$helpModal || !$helpToggle) return // defensive; should always exist

  const $closeBtn = document.getElementById('help-modal-close')
  const $tabs = $helpModal.querySelectorAll('.help-tab')
  const $panels = $helpModal.querySelectorAll('.help-tabpanel')

  function openHelp() {
    $helpModal.hidden = false
    $helpToggle.setAttribute('aria-pressed', 'true')
    // Focus the first tab for keyboard users.
    $tabs[0]?.focus()
  }

  function closeHelp() {
    $helpModal.hidden = true
    $helpToggle.setAttribute('aria-pressed', 'false')
    $helpToggle.focus()
  }

  function switchTab(name) {
    $tabs.forEach((tab) => {
      const active = tab.dataset.helpTab === name
      tab.classList.toggle('is-active', active)
      tab.setAttribute('aria-selected', active ? 'true' : 'false')
    })
    $panels.forEach((panel) => {
      const active = panel.dataset.helpPanel === name
      panel.classList.toggle('is-active', active)
      panel.hidden = !active
    })
  }

  // Header button toggles
  $helpToggle.addEventListener('click', () => {
    if ($helpModal.hidden) openHelp()
    else closeHelp()
  })

  // Close interactions
  $closeBtn?.addEventListener('click', closeHelp)
  $helpModal.addEventListener('click', (ev) => {
    if (ev.target.dataset.closeHelp !== undefined) closeHelp()
  })

  // Keyboard shortcuts: Ctrl+/ to open, Esc to close
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$helpModal.hidden) {
      closeHelp()
      ev.preventDefault()
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key === '/') {
      if ($helpModal.hidden) openHelp()
      else closeHelp()
      ev.preventDefault()
    }
  })

  // Tab clicks
  $tabs.forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.helpTab))
  })

  // The empty-state "open Help" link inside the MCP panel — defers
  // to the same toggle handler so we don't duplicate the open logic.
  const $emptyHelpLink = document.getElementById('mcp-empty-help')
  $emptyHelpLink?.addEventListener('click', () => {
    if ($helpModal.hidden) openHelp()
  })

  // Copy-to-clipboard for every <pre class="help-code" data-copyable>.
  // Falls back to a textarea hack when Clipboard API is unavailable
  // (Tauri webview in some configurations).
  $helpModal.querySelectorAll('pre.help-code[data-copyable]').forEach((pre) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'help-code-copy'
    btn.textContent = 'Copy'
    btn.setAttribute('aria-label', 'Copy command to clipboard')
    pre.appendChild(btn)
    btn.addEventListener('click', async () => {
      const code = pre.querySelector('code')?.innerText ?? ''
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(code)
        } else {
          // Fallback path — invisible textarea + execCommand.
          const ta = document.createElement('textarea')
          ta.value = code
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          document.body.removeChild(ta)
        }
        btn.textContent = 'Copied'
        btn.classList.add('is-copied')
        setTimeout(() => {
          btn.textContent = 'Copy'
          btn.classList.remove('is-copied')
        }, 1500)
      } catch {
        btn.textContent = 'Copy failed'
        setTimeout(() => { btn.textContent = 'Copy' }, 1500)
      }
    })
  })
})()

// ─── rc5: MCP usage panel ──────────────────────────────────────────────────
//
// Live counter of MCP requests served by the dashboard's /mcp endpoint,
// broken down by tool / resource / method and by client. Renders inside
// the iteration panel as a collapsible <details> block. Two update paths:
//
//   1. Initial fetch from GET /api/mcp/stats on load (so the panel
//      reflects state even if the dashboard was opened mid-session).
//   2. SSE subscription to 'mcp-stats-update' events for live updates
//      during agent activity (server debounces to ≤ 2 emissions/sec).
//
// Defensive: this whole module is wrapped in try/catch — a counter
// failure must never prevent the rest of the dashboard from rendering.

;(() => {
  const $total = document.getElementById('mcp-panel-total')
  const $empty = document.getElementById('mcp-empty')
  const $stats = document.getElementById('mcp-stats')
  const $tools = document.getElementById('mcp-stat-tools')
  const $resources = document.getElementById('mcp-stat-resources')
  const $other = document.getElementById('mcp-stat-other')
  const $last = document.getElementById('mcp-stat-last')
  const $bynameTbody = document.getElementById('mcp-byname-tbody')
  const $byclientTbody = document.getElementById('mcp-byclient-tbody')
  const $byclientTitle = document.getElementById('mcp-byclient-title')
  const $byclientTable = document.getElementById('mcp-byclient-table')
  if (!$total || !$stats || !$bynameTbody) return

  function relTime(iso) {
    if (!iso) return '—'
    const ms = Date.parse(iso)
    if (!Number.isFinite(ms)) return '—'
    const diff = Date.now() - ms
    if (diff < 0) return 'just now'
    if (diff < 5_000) return 'just now'
    if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
    return `${Math.round(diff / 3_600_000)}h ago`
  }

  function splitKey(key) {
    // key formats: "tool:foo", "resource:blastradius://x", "method:initialize"
    const idx = key.indexOf(':')
    if (idx < 0) return { kind: 'other', name: key }
    return { kind: key.slice(0, idx), name: key.slice(idx + 1) }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))
  }

  function render(snapshot) {
    try {
      const t = snapshot?.totals ?? { tools: 0, resources: 0, other: 0, total: 0 }
      $total.textContent = String(t.total)
      $tools.textContent = String(t.tools)
      $resources.textContent = String(t.resources)
      $other.textContent = String(t.other)
      $last.textContent = relTime(snapshot?.lastRequestAt)

      const hasActivity = t.total > 0
      $empty.hidden = hasActivity
      $stats.hidden = !hasActivity
      if (!hasActivity) return

      // Defensive number coercion — render count as Number, never
      // raw string. Belt-and-suspenders against the (unreachable)
      // case where the server emits a count that isn't strictly
      // numeric. Combined with escapeHtml on every text field, the
      // panel cannot be tricked into rendering hostile HTML.
      const safeCount = (v) => {
        const n = Number(v)
        return Number.isFinite(n) ? n : 0
      }

      // Render byName table.
      const byName = Array.isArray(snapshot.byName) ? snapshot.byName : []
      $bynameTbody.innerHTML = byName.map((row) => {
        const { kind, name } = splitKey(row.key)
        return `<tr>
          <td><span class="mcp-byname-kind kind-${escapeHtml(kind)}">${escapeHtml(kind)}</span>${escapeHtml(name)}</td>
          <td>${safeCount(row.count)}</td>
        </tr>`
      }).join('')

      // Render byClient table (only when populated).
      const byClient = Array.isArray(snapshot.byClient) ? snapshot.byClient : []
      const showClients = byClient.length > 0
      $byclientTitle.hidden = !showClients
      $byclientTable.hidden = !showClients
      if (showClients) {
        $byclientTbody.innerHTML = byClient.map((row) => `<tr>
          <td>${escapeHtml(row.name)}</td>
          <td>${safeCount(row.count)}</td>
        </tr>`).join('')
      }

      // Memory-cap warning. Surfaces when the server has dropped keys
      // — either heavy legitimate traffic or a unique-name DoS attempt.
      // Either way the operator deserves to know the breakdown is no
      // longer complete.
      const dropped = snapshot.droppedKeys
      const banner = document.getElementById('mcp-cap-banner')
      const totalDropped = (Number(dropped?.byName) || 0) + (Number(dropped?.byClient) || 0)
      if (banner) {
        if (totalDropped > 0) {
          banner.textContent = `Breakdown truncated — server dropped ${totalDropped} unique keys past the ${snapshot.caps?.maxDistinctKeys ?? 'configured'} cap.`
          banner.hidden = false
        } else {
          banner.hidden = true
        }
      }
    } catch (err) {
      console.warn('mcp-panel render failed:', err)
    }
  }

  async function fetchInitial() {
    try {
      const resp = await fetch('/api/mcp/stats')
      if (!resp.ok) return
      const snapshot = await resp.json()
      render(snapshot)
    } catch (err) {
      console.warn('mcp-panel initial fetch failed:', err)
    }
  }

  // Hook into the EXISTING SSE EventSource that app.js already opens
  // for heat-update / tree-update / iteration-update etc. We can't
  // open a second EventSource — the SDK Client and the SSE Broadcaster
  // both treat /api/events as a single shared channel.
  function attachSseListener() {
    // Poll briefly for the global EventSource that the main dashboard
    // module exposes. If it doesn't exist (e.g. wizard mode), we fall
    // back to a periodic fetch so the panel still surfaces activity.
    let tries = 0
    const interval = setInterval(() => {
      tries++
      const src = window.__blastradiusSse
      if (src instanceof EventSource) {
        src.addEventListener('mcp-stats-update', (ev) => {
          try {
            const snapshot = JSON.parse(ev.data)
            render(snapshot)
          } catch { /* malformed frame — ignore */ }
        })
        clearInterval(interval)
        return
      }
      if (tries > 20) {
        clearInterval(interval)
        // Fallback: 10 s polling.
        setInterval(fetchInitial, 10_000)
      }
    }, 250)
  }

  void fetchInitial()
  attachSseListener()
})()

// ─── rc7: Date-range selector ──────────────────────────────────────────────
//
// Wires the .range-toggle header chips + the custom <details> picker to
// state.dateRange and the heat-map refresh loop. Five presets:
//
//   today      → state.dateRange = null (live current-day view, default)
//   yesterday  → state.dateRange = { from: ymd(-1), to: ymd(-1) }
//   7d         → { from: ymd(-6), to: ymd(0) }   (last 7 days inclusive)
//   30d        → { from: ymd(-29), to: ymd(0) }  (last 30 days)
//   custom     → user picks two <input type='date'> values, clicks Apply
//
// While any non-Today preset is active:
//   - the .window-toggle bar is greyed out (.is-disabled class)
//   - SSE heat-update events are ignored by scheduleHeatRefresh()
//   - the heat map is loaded via GET /api/heat?since=…&until=…

;(() => {
  const $range = document.querySelector('.range-toggle')
  if (!$range) return
  const $windowToggle = document.querySelector('.window-toggle')
  const $rangeButtons = $range.querySelectorAll('button[data-range]')
  const $rangeCustom = document.getElementById('range-custom-details')
  const $rangeFrom = document.getElementById('range-from')
  const $rangeTo = document.getElementById('range-to')
  const $rangeApply = document.getElementById('range-apply')

  function ymd(daysAgo) {
    const d = new Date()
    d.setDate(d.getDate() - daysAgo)
    return d.toISOString().slice(0, 10)
  }

  /** Update visual selection on the chips + window-toggle disabled state. */
  function paintSelection(rangePresetName) {
    $rangeButtons.forEach((b) => {
      b.setAttribute('aria-selected', b.dataset.range === rangePresetName ? 'true' : 'false')
    })
    // Custom chip is the <details>'s <summary>; it's "selected" when
    // rangePresetName === 'custom'.
    if (rangePresetName === 'custom') {
      $rangeCustom.setAttribute('open', '')
    } else {
      $rangeCustom.removeAttribute('open')
    }
    // Greying out the window toggle.
    if (rangePresetName === 'today') {
      $windowToggle?.classList.remove('is-disabled')
    } else {
      $windowToggle?.classList.add('is-disabled')
    }
  }

  /** Apply a preset and trigger a heat refresh. */
  function applyPreset(name) {
    switch (name) {
      case 'today':
        state.dateRange = null
        break
      case 'yesterday': {
        const y = ymd(1)
        state.dateRange = { from: y, to: y }
        break
      }
      case '7d':
        state.dateRange = { from: ymd(6), to: ymd(0) }
        break
      case '30d':
        state.dateRange = { from: ymd(29), to: ymd(0) }
        break
      default:
        return
    }
    paintSelection(name)
    void refreshHeat()
  }

  $rangeButtons.forEach((btn) => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.range))
  })

  // Custom range: validate on input change, enable Apply only when both
  // values are present and from <= to.
  function validateCustom() {
    const f = $rangeFrom.value
    const t = $rangeTo.value
    const ok = !!f && !!t && f <= t
    $rangeApply.disabled = !ok
  }
  $rangeFrom?.addEventListener('change', validateCustom)
  $rangeTo?.addEventListener('change', validateCustom)
  validateCustom()

  $rangeApply?.addEventListener('click', () => {
    const f = $rangeFrom.value
    const t = $rangeTo.value
    if (!f || !t || f > t) return
    // Span guard mirrors the server-side cap so the user gets feedback
    // before the round-trip. 30 days inclusive = 29-day span.
    const spanDays = Math.round((Date.parse(t) - Date.parse(f)) / 86400000) + 1
    if (spanDays > 30) {
      // Reuse the existing toast pattern if available; otherwise
      // surface via alert (the connection bar would also work but
      // that's overkill for an obvious user input mistake).
      window.alert?.(`Range spans ${spanDays} days; the maximum allowed is 30.`)
      return
    }
    state.dateRange = { from: f, to: t }
    paintSelection('custom')
    void refreshHeat()
  })
})()

// ─── rc8: Knowledge Graph view (Tree↔Graph toggle + D3 force-directed) ────
//
// Self-contained module so it can be removed without touching the heat
// rendering loop. Owns:
//
//   - The view-toggle bar (Tree / Graph) and its persistence via
//     POST /api/preferences { viewMode }. Calls /api/preferences on
//     every flip; the response is fire-and-forget because the
//     in-memory state already drives the visible pane.
//
//   - The D3 force-directed simulation. Important UX trade-offs:
//       • `alphaDecay: 0.06` (aggressive — Mike Bostock's default is
//         0.0228) so the simulation converges in ~150-200 ticks
//         instead of ~1000. With ≤ 200 nodes this is invisible to the
//         user and saves continuous CPU.
//       • Hard `setTimeout` failsafe: if the simulation hasn't
//         settled in 8 s we call .stop() anyway. Defensive against
//         degenerate graphs that never reach alphaMin.
//       • The simulation is recreated from scratch on every refresh
//         (cheap: 200 nodes × ~150 ticks ≈ 30 ms). Trying to mutate
//         d3 nodes in-place is fiddly when fanIn/fanOut change.
//
//   - The side-panel inline editor for summary + tags. Calls
//     POST /api/graph/node (NOT MCP — the MCP tool is reserved for
//     agents). Tag chips parse from comma-separated input. Cap-aware
//     error display surfaces the server's `error` code verbatim so
//     the user understands which guard fired (summary_too_long,
//     too_many_tags, tag_too_long, etc.).
//
//   - SSE 'knowledge-graph-update' listener that schedules a
//     debounced refresh of the graph snapshot when the active view
//     is 'graph'. Wired through window.__blastradiusSse — same hook
//     the MCP usage panel uses to share the live EventSource.

;(() => {
  const $layout = document.querySelector('.layout')
  const $viewButtons = document.querySelectorAll('.view-toggle button')
  const $svg = document.getElementById('graph-canvas')
  const $graphStats = document.getElementById('graph-stats')
  const $graphTruncated = document.getElementById('graph-truncated')
  const $graphEmpty = document.getElementById('graph-empty')
  const $recenter = document.getElementById('graph-recenter')
  if (!$layout || !$svg) return

  /** Local-only state for the graph view. Kept separate from the
   *  top-level `state` object so this module can be removed cleanly. */
  const gState = {
    viewMode: 'tree',          // last-known mode; synced with .layout[data-view]
    snapshot: null,            // last /api/graph response
    simulation: null,          // active d3 force simulation
    selectedPath: null,        // currently focused node
    convergenceTimer: null,    // failsafe stop() timer
    pendingRefresh: null,      // SSE-debounce timer id
    fetchInflight: false,      // single-flight gate for /api/graph
    needsFetch: false,         // pending refresh while one is in flight
  }

  // ─── View toggle: Tree ↔ Graph ─────────────────────────────────────────

  /**
   * Switch view mode. `persist=true` (default) sends the change to the
   * server; `persist=false` is used by boot when we're just restoring
   * the already-persisted choice.
   */
  async function setViewMode(name, { persist = true } = {}) {
    if (name !== 'tree' && name !== 'graph') return
    if (gState.viewMode === name) return
    gState.viewMode = name
    $layout.setAttribute('data-view', name)
    for (const btn of $viewButtons) {
      btn.setAttribute('aria-selected', btn.dataset.view === name ? 'true' : 'false')
    }
    if (persist) {
      try {
        await fetch('/api/preferences', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ viewMode: name }),
        })
      } catch (err) {
        // Persistence failure is non-fatal — the toggle still works
        // for this session, it just won't survive a reload.
        console.warn('failed to persist viewMode', err)
      }
    }
    if (name === 'graph') {
      void fetchGraph()
    } else {
      // Free the simulation when leaving graph mode — no point burning
      // CPU on something the user can't see.
      stopSimulation()
    }
  }
  // Expose for the boot path so it can restore prefs.viewMode BEFORE
  // the first render. Used in the bootstrap IIFE above.
  window.__brSetViewMode = setViewMode

  for (const btn of $viewButtons) {
    btn.addEventListener('click', () => setViewMode(btn.dataset.view))
  }

  // ─── /api/graph fetch + render ────────────────────────────────────────

  async function fetchGraph() {
    // Single-flight guard: a second fetchGraph() while one is in flight
    // sets needsFetch=true so we re-run as soon as the first finishes.
    if (gState.fetchInflight) {
      gState.needsFetch = true
      return
    }
    gState.fetchInflight = true
    try {
      // Default cap = 200, matches the server-side default. We could
      // dial this up for hub-heavy repos but 200 covers BlastRadius's
      // own structure with room to spare (≈ 27 nodes today).
      const res = await fetch('/api/graph?limit=200')
      if (!res.ok) {
        // Wizard-mode (no active repo) or graph_not_ready: render the
        // empty-state overlay instead of crashing.
        gState.snapshot = null
        renderEmpty(await safeJson(res))
        return
      }
      const body = await res.json()
      gState.snapshot = body
      renderGraph(body)
    } catch (err) {
      console.error('fetchGraph failed', err)
      gState.snapshot = null
      renderEmpty({ error: 'fetch_failed' })
    } finally {
      gState.fetchInflight = false
      if (gState.needsFetch) {
        gState.needsFetch = false
        void fetchGraph()
      }
    }
  }

  async function safeJson(res) {
    try { return await res.json() } catch { return null }
  }

  function renderEmpty(body) {
    $graphStats.textContent = '—'
    $graphTruncated.hidden = true
    $graphEmpty.textContent = body?.error === 'no_active_repo'
      ? 'No active repo selected.'
      : body?.error === 'graph_not_ready'
        ? 'Knowledge Graph is still building — try again in a few seconds.'
        : 'Knowledge Graph not available.'
    $graphEmpty.hidden = false
    // Wipe any prior SVG content.
    while ($svg.firstChild) $svg.removeChild($svg.firstChild)
    stopSimulation()
  }

  function renderGraph(body) {
    const nodes = Array.isArray(body.nodes) ? body.nodes : []
    if (nodes.length === 0) {
      renderEmpty({ error: 'graph_not_ready' })
      return
    }
    $graphEmpty.hidden = true
    // rc8.2+: read top-level aggregate counters from the backend.
    // The backend's `totalNodes` / `totalEdges` / `cycleCount` /
    // `orphanCount` describe the FULL snapshot, not the (possibly
    // truncated) `body.nodes` array — so the header stays honest even
    // when the graph exceeds the 200-node default cap. Falling back to
    // `body.stats.*` keeps the dashboard readable against an older
    // rc8.1 server if someone runs a mixed build during an upgrade.
    const totalNodes  = body.totalNodes  ?? body.stats?.nodes      ?? body.nodes.length
    const totalEdges  = body.totalEdges  ?? body.stats?.edges      ?? body.edges.length
    const cycleCount  = body.cycleCount  ?? body.stats?.cycles     ?? 0
    const orphanCount = body.orphanCount ?? body.stats?.orphans    ?? 0
    const withSummary = body.withSummary ?? body.stats?.withSummary ?? 0
    $graphStats.textContent =
      `${totalNodes} nodes · ${totalEdges} edges · ` +
      `${cycleCount} cycles · ${orphanCount} orphans · ${withSummary} w/summary`
    $graphTruncated.hidden = !body.truncated

    // d3 wants new objects per render (it mutates them by stamping
    // x/y/vx/vy on each node). Copy by reference is fine for the
    // semantic fields — we only mutate position bookkeeping.
    const d3nodes = nodes.map((n) => ({ ...n }))
    const byPath = new Map(d3nodes.map((n) => [n.path, n]))
    const d3links = body.edges
      // d3.forceLink expects {source, target} pointing at node objects
      // (or string ids, which require .id() configuration). We use
      // objects directly to skip a lookup at every tick.
      .map((e) => ({ source: byPath.get(e.from), target: byPath.get(e.to) }))
      .filter((l) => l.source && l.target)

    drawForceDirected(d3nodes, d3links)
  }

  // ─── D3 force-directed simulation ─────────────────────────────────────

  function stopSimulation() {
    if (gState.simulation) {
      gState.simulation.stop()
      gState.simulation = null
    }
    if (gState.convergenceTimer) {
      clearTimeout(gState.convergenceTimer)
      gState.convergenceTimer = null
    }
  }

  function drawForceDirected(d3nodes, d3links) {
    const d3 = window.d3
    if (!d3) {
      console.warn('d3 not loaded — graph view unavailable')
      $graphEmpty.textContent = 'd3 not loaded'
      $graphEmpty.hidden = false
      return
    }
    stopSimulation()

    const rect = $svg.getBoundingClientRect()
    const width = Math.max(rect.width, 200)
    const height = Math.max(rect.height, 200)
    $svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    $svg.setAttribute('width', width)
    $svg.setAttribute('height', height)

    // Wipe prior render.
    while ($svg.firstChild) $svg.removeChild($svg.firstChild)
    const svg = d3.select($svg)

    // Pan + zoom container. Two nested <g>: outer is the zoom target,
    // inner holds the actual node + link primitives.
    const zoomG = svg.append('g').attr('class', 'gzoom')
    const linkLayer = zoomG.append('g').attr('class', 'glink-layer')
    const nodeLayer = zoomG.append('g').attr('class', 'gnode-layer')
    const labelLayer = zoomG.append('g').attr('class', 'glabel-layer')

    svg.call(
      d3.zoom()
        .scaleExtent([0.2, 4])
        .on('zoom', (ev) => zoomG.attr('transform', ev.transform)),
    )

    // Color/radius derive from heat overlay + fanIn. We pull heat from
    // the top-level state so a graph node turns red the moment the
    // tree pane would too — they share the same data source.
    const heatFiles = state.heat?.files ?? {}
    function nodeKind(d) {
      const heat = heatFiles[d.path]
      if (heat === 'red') return 'red'
      if (heat === 'green') return 'green'
      if (heat === 'yellow') return 'yellow'
      return 'neutral'
    }
    function nodeRadius(d) {
      // sqrt scale so a 30-fanIn hub doesn't dwarf 1-fanIn leaves.
      // Cap at 14 so hubs are visible but don't eat the canvas.
      const r = 4 + Math.sqrt(Math.max(d.fanIn, 0)) * 1.6
      return Math.min(14, Math.max(4, r))
    }

    // Build the simulation. Three forces:
    //   1. d3.forceLink — pulls connected nodes toward each other.
    //      Distance scaled with sqrt(combined fanIn) so dense hubs
    //      have room around them.
    //   2. d3.forceManyBody (charge) — pushes everything apart.
    //   3. d3.forceCenter — keeps the cluster in frame.
    // alphaDecay aggressive (0.06) so we converge in ~150 ticks.
    const sim = d3.forceSimulation(d3nodes)
      .alphaDecay(0.06)
      .velocityDecay(0.35)
      .force('link', d3.forceLink(d3links).distance((l) => 30 + Math.sqrt((l.source.fanIn || 0) + (l.target.fanIn || 0)) * 8))
      .force('charge', d3.forceManyBody().strength(-180))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide().radius((d) => nodeRadius(d) + 2))

    gState.simulation = sim

    // Failsafe: if the sim hasn't settled in 8 s, stop it anyway. With
    // 200 nodes and 0.06 decay we hit alphaMin in well under 4 s, so
    // 8 s is comfortable headroom.
    gState.convergenceTimer = setTimeout(() => {
      if (gState.simulation === sim) {
        sim.stop()
        gState.convergenceTimer = null
      }
    }, 8000)

    // Build SVG nodes.
    const link = linkLayer.selectAll('line')
      .data(d3links)
      .enter()
      .append('line')
      .attr('class', 'glink')

    const node = nodeLayer.selectAll('circle')
      .data(d3nodes)
      .enter()
      .append('circle')
      .attr('class', (d) => `gnode gnode-${nodeKind(d)} ${d.summary ? 'has-summary' : ''}`)
      .attr('r', nodeRadius)
      .attr('data-path', (d) => d.path)
      .on('click', (ev, d) => selectGraphNode(d.path))
      .call(
        d3.drag()
          .on('start', (ev, d) => {
            if (!ev.active) sim.alphaTarget(0.3).restart()
            d.fx = d.x; d.fy = d.y
          })
          .on('drag', (ev, d) => {
            d.fx = ev.x; d.fy = ev.y
          })
          .on('end', (ev, d) => {
            if (!ev.active) sim.alphaTarget(0)
            // Release the pin so the simulation can re-balance.
            d.fx = null; d.fy = null
          }),
      )
    node.append('title').text((d) => `${d.path}\nfanIn=${d.fanIn} fanOut=${d.fanOut}${d.summary ? `\n${d.summary}` : ''}`)

    // Labels: only for "important" nodes (fanIn ≥ 3 or has summary).
    // Showing every label on 200 nodes is unreadable AND laggy.
    const labelled = d3nodes.filter((d) => d.fanIn >= 3 || d.summary)
    const label = labelLayer.selectAll('text')
      .data(labelled)
      .enter()
      .append('text')
      .attr('class', 'glabel')
      .attr('dx', (d) => nodeRadius(d) + 3)
      .attr('dy', 3)
      .text((d) => {
        const i = d.path.lastIndexOf('/')
        return i >= 0 ? d.path.slice(i + 1) : d.path
      })

    sim.on('tick', () => {
      link
        .attr('x1', (d) => d.source.x)
        .attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x)
        .attr('y2', (d) => d.target.y)
      node.attr('cx', (d) => d.x).attr('cy', (d) => d.y)
      label.attr('x', (d) => d.x).attr('y', (d) => d.y)
    })

    sim.on('end', () => {
      // Sim hit alphaMin on its own — clear the failsafe.
      if (gState.convergenceTimer) {
        clearTimeout(gState.convergenceTimer)
        gState.convergenceTimer = null
      }
    })

    // Re-apply the current selection (e.g. across a refresh).
    if (gState.selectedPath) {
      applyGraphSelection(gState.selectedPath)
    }
  }

  // Recenter button: stop, recreate from the cached snapshot.
  $recenter?.addEventListener('click', () => {
    if (gState.snapshot) renderGraph(gState.snapshot)
  })

  // ─── Selection + side panel inline editor ─────────────────────────────

  function applyGraphSelection(path) {
    const svg = window.d3?.select($svg)
    if (!svg) return
    svg.selectAll('circle.gnode').classed('is-selected', (d) => d.path === path)
  }

  /** Click a graph node → focus the side panel and load the node's
   *  semantic detail. Bridges back to the existing renderSidePanel()
   *  logic by setting state.selected + delegating to the same helper. */
  async function selectGraphNode(path) {
    gState.selectedPath = path
    applyGraphSelection(path)
    state.selected = path
    // Find the node in the cached snapshot so we don't have to
    // refetch. /api/graph/node would also work but the snapshot is
    // already in memory and includes the same fields.
    const cached = gState.snapshot?.nodes?.find((n) => n.path === path)
    renderGraphSidePanel(cached)
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ))
  }

  /** Render the side panel in graph mode. Reuses the existing
   *  #side-title + #side-body DOM nodes so we don't double-paint a
   *  competing panel; clicking back to Tree just calls the original
   *  renderSidePanel() and overwrites our markup. */
  function renderGraphSidePanel(node) {
    if (!node) {
      $sideTitle.textContent = 'Select a node'
      $sideBody.innerHTML = '<p class="side-hint">Click a node in the graph to see its detail and edit its summary.</p>'
      $sideClose.hidden = true
      return
    }
    $sideTitle.textContent = node.path
    $sideClose.hidden = false
    const kindBadge = `<span class="gnode-kind gnode-kind-${escapeHtml(node.kind)}">${escapeHtml(node.kind)}</span>`
    const tagChips = (node.tags || []).map((t) => `<span class="gnode-tag">${escapeHtml(t)}</span>`).join('')
    $sideBody.innerHTML = `
      <div class="gnode-meta">
        ${kindBadge}
        <span class="gnode-stat">fanIn <b>${node.fanIn}</b></span>
        <span class="gnode-stat">fanOut <b>${node.fanOut}</b></span>
        <span class="gnode-stat">${Math.max(1, Math.round(node.sizeBytes / 1024))} KB</span>
      </div>
      <div class="gnode-summary-block">
        <label class="gnode-summary-label" for="gnode-summary-input">Summary (≤ 2000 chars)</label>
        <textarea id="gnode-summary-input" class="gnode-summary-input" maxlength="2000" rows="6" placeholder="What does this file do?">${escapeHtml(node.summary || '')}</textarea>
      </div>
      <div class="gnode-tags-block">
        <label class="gnode-summary-label" for="gnode-tags-input">Tags (comma-separated, ≤ 20 × 32 chars)</label>
        <input id="gnode-tags-input" class="gnode-tags-input" type="text" value="${escapeHtml((node.tags || []).join(', '))}" placeholder="core, api, deprecated" />
        <div class="gnode-tags-current">${tagChips || '<em class="side-hint">No tags yet.</em>'}</div>
      </div>
      <div class="gnode-actions">
        <button type="button" id="gnode-save" class="gnode-save-btn">Save</button>
        <span class="gnode-save-status" id="gnode-save-status"></span>
      </div>
      ${node.summaryUpdatedAt ? `<p class="side-hint">Last updated ${new Date(node.summaryUpdatedAt).toLocaleString()}.</p>` : ''}
    `
    const $save = document.getElementById('gnode-save')
    const $sumIn = document.getElementById('gnode-summary-input')
    const $tagIn = document.getElementById('gnode-tags-input')
    const $status = document.getElementById('gnode-save-status')
    $save.addEventListener('click', async () => {
      const summary = $sumIn.value
      const tags = $tagIn.value.split(',').map((t) => t.trim()).filter(Boolean)
      $save.disabled = true
      $status.textContent = 'Saving…'
      $status.className = 'gnode-save-status'
      try {
        // IMPORTANT: this is REST (/api/graph/node), NOT MCP. The MCP
        // tool set_node_summary is reserved for agents (it carries
        // the requiresConsent annotation). The dashboard always uses
        // the HTTP surface because the user is right here — the
        // consent gate doesn't apply.
        const res = await fetch('/api/graph/node', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: node.path, summary, tags }),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) {
          // Server returns { error: <code>, message: <human> }. Show
          // both so the user knows what to fix (e.g. "summary too
          // long").
          $status.textContent = `${body.error || 'save_failed'}${body.message ? ' — ' + body.message : ''}`
          $status.className = 'gnode-save-status is-error'
          $save.disabled = false
          return
        }
        // Optimistic update of the cached snapshot so a follow-up
        // click on the same node sees the new value without a refetch.
        if (gState.snapshot) {
          const cachedNode = gState.snapshot.nodes.find((n) => n.path === node.path)
          if (cachedNode) {
            cachedNode.summary = body.entry?.summary ?? summary
            cachedNode.tags = body.entry?.tags ?? tags
            cachedNode.summaryUpdatedAt = body.entry?.updatedAt ?? new Date().toISOString()
          }
        }
        $status.textContent = 'Saved'
        $status.className = 'gnode-save-status is-ok'
        $save.disabled = false
        // Subtle visual: the node ring turns purple to mark "has summary".
        const ring = $svg.querySelector(`circle.gnode[data-path="${CSS.escape(node.path)}"]`)
        if (ring) ring.classList.add('has-summary')
      } catch (err) {
        $status.textContent = String(err?.message || err)
        $status.className = 'gnode-save-status is-error'
        $save.disabled = false
      }
    })
  }

  // ─── SSE knowledge-graph-update consumer ──────────────────────────────

  /** Schedule a graph refresh, debounced so a burst of saves doesn't
   *  trigger a render-storm. 400 ms is enough to coalesce typing-rate
   *  events but still feels live. */
  function scheduleGraphRefresh() {
    if (gState.viewMode !== 'graph') return
    if (gState.pendingRefresh) return
    gState.pendingRefresh = setTimeout(() => {
      gState.pendingRefresh = null
      void fetchGraph()
    }, 400)
  }

  // Attach to the shared EventSource set up by the heat-rendering loop.
  // The connectSse() function exposes the live source on
  // window.__blastradiusSse so add-on modules can subscribe without
  // opening a second connection.
  function attachSse() {
    const es = window.__blastradiusSse
    if (!es) {
      // SSE not up yet — try again in 500 ms. Bounded by connectSse()
      // which fires synchronously during the bootstrap IIFE.
      setTimeout(attachSse, 500)
      return
    }
    es.addEventListener('knowledge-graph-update', () => scheduleGraphRefresh())
    // Also refresh on tree-update / repo-changed — the structural
    // graph can change when a file is added, deleted, or the active
    // repo flips.
    es.addEventListener('tree-update', () => scheduleGraphRefresh())
    es.addEventListener('repo-changed', () => scheduleGraphRefresh())
  }
  attachSse()

  // Window resize: rebuild from the cached snapshot so the simulation
  // uses the new viewport dimensions. Debounced 250 ms.
  let resizeTimer = null
  window.addEventListener('resize', () => {
    if (gState.viewMode !== 'graph') return
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      if (gState.snapshot) renderGraph(gState.snapshot)
    }, 250)
  })
})()

// ─── Hook-install banner (rc8.4) ──────────────────────────────────────────
//
// Self-contained IIFE: wires the .hook-banner element + .hook-modal in
// index.html to the /api/repo/hook-status + /api/repo/install-hook
// endpoints. No cross-talk with the heat-map / graph-view modules —
// just observes window.__blastradiusSse for `repo-changed` events and
// polls hook-status on boot.
//
// Visibility rule:
//   show banner ⇔ active repo is set AND hook status is `installed:
//   false` AND active repo is NOT in preferences.ignoredHookRepos
;(() => {
  const $banner       = document.getElementById('hook-banner')
  const $bannerRepo   = document.getElementById('hook-banner-repo')
  const $btnActivate  = document.getElementById('hook-banner-activate')
  const $btnDetails   = document.getElementById('hook-banner-details')
  const $btnIgnore    = document.getElementById('hook-banner-ignore')
  const $modal        = document.getElementById('hook-modal')
  const $modalBackdrop = document.getElementById('hook-modal-backdrop')
  const $modalClose   = document.getElementById('hook-modal-close')
  const $modalPath    = document.getElementById('hook-modal-settings-path')
  const $modalCmdWrap = document.getElementById('hook-modal-cmd-wrap')
  const $modalCmd     = document.getElementById('hook-modal-cmd')
  const $modalStatus  = document.getElementById('hook-modal-status')
  const $modalShow    = document.getElementById('hook-modal-show-cmd')
  const $modalInstall = document.getElementById('hook-modal-install')

  if (!$banner || !$modal) return // markup missing — nothing to wire

  /** Locally cached snapshot so click handlers don't need to re-fetch. */
  const hookState = {
    currentRepo: null,
    settingsPath: null,
    expectedCommand: null,
    installed: false,
    ignored: false,
  }

  function hideBanner() { $banner.hidden = true }
  function showBanner(repoPath) {
    if (!repoPath) return hideBanner()
    // Display only the basename — repo paths get long on Windows.
    const display = repoPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || repoPath
    $bannerRepo.textContent = display
    $banner.hidden = false
  }

  function showModal() {
    $modalPath.textContent = hookState.settingsPath || '.claude/settings.json'
    $modalStatus.hidden = true
    $modalStatus.textContent = ''
    $modalStatus.classList.remove('is-ok', 'is-error')
    $modalCmdWrap.hidden = true
    $modal.hidden = false
  }
  function hideModal() { $modal.hidden = true }

  /** Build the PS equivalent so users who prefer manual install can
   *  copy-paste it. Mirrors the documented install-hook.ps1 invocation. */
  function buildPsCommand(repoPath) {
    return `.\\scripts\\install-hook.ps1 -ProjectPath "${repoPath}"`
  }

  async function fetchHookStatus(repoPath) {
    if (!repoPath) return null
    try {
      const url = `/api/repo/hook-status?path=${encodeURIComponent(repoPath)}`
      const res = await fetch(url)
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }

  async function refresh() {
    // Pull current active repo + the per-repo opt-out list.
    let prefs = null
    try {
      const r = await fetch('/api/preferences')
      if (r.ok) prefs = await r.json()
    } catch { /* keep going — hide banner on failure */ }
    if (!prefs || !prefs.currentRepo) {
      hookState.currentRepo = null
      return hideBanner()
    }
    hookState.currentRepo = prefs.currentRepo
    const ignored = Array.isArray(prefs.ignoredHookRepos)
      ? prefs.ignoredHookRepos.some((p) => p && p === prefs.currentRepo)
      : false
    hookState.ignored = ignored
    if (ignored) return hideBanner()

    const status = await fetchHookStatus(prefs.currentRepo)
    if (!status) return hideBanner()
    hookState.installed = !!status.installed
    hookState.settingsPath = status.settingsPath
    hookState.expectedCommand = status.expectedCommand
    if (status.installed) return hideBanner()
    showBanner(prefs.currentRepo)
  }

  // Click handlers.
  $btnActivate.addEventListener('click', showModal)
  $btnDetails.addEventListener('click', showModal)
  $btnIgnore.addEventListener('click', async () => {
    if (!hookState.currentRepo) return
    try {
      // Read current list, append, persist. Server normalize() dedupes.
      const r = await fetch('/api/preferences')
      const prefs = r.ok ? await r.json() : { ignoredHookRepos: [] }
      const next = Array.isArray(prefs.ignoredHookRepos)
        ? [...prefs.ignoredHookRepos, hookState.currentRepo]
        : [hookState.currentRepo]
      await fetch('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ignoredHookRepos: next }),
      })
    } catch { /* best effort — banner hides regardless */ }
    hideBanner()
  })

  $modalClose.addEventListener('click', hideModal)
  $modalBackdrop.addEventListener('click', hideModal)
  $modalShow.addEventListener('click', () => {
    if (!hookState.currentRepo) return
    $modalCmd.textContent = buildPsCommand(hookState.currentRepo)
    $modalCmdWrap.hidden = false
  })
  $modalInstall.addEventListener('click', async () => {
    if (!hookState.currentRepo) return
    $modalInstall.disabled = true
    $modalShow.disabled = true
    $modalStatus.hidden = true
    $modalStatus.textContent = ''
    $modalStatus.classList.remove('is-ok', 'is-error')
    try {
      const res = await fetch('/api/repo/install-hook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: hookState.currentRepo }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok && body.ok) {
        $modalStatus.textContent =
          'Hook installed. Restart Claude Code in this repo for it to take effect.'
        $modalStatus.classList.add('is-ok')
        $modalStatus.hidden = false
        // Banner stays hidden after install — refresh() will confirm.
        setTimeout(() => { hideModal(); hideBanner() }, 1200)
        await refresh()
      } else {
        const reason = body.error || body.reason || `HTTP ${res.status}`
        $modalStatus.textContent = `Install failed: ${reason}`
        $modalStatus.classList.add('is-error')
        $modalStatus.hidden = false
      }
    } catch (err) {
      $modalStatus.textContent = `Install failed: ${String(err?.message ?? err)}`
      $modalStatus.classList.add('is-error')
      $modalStatus.hidden = false
    } finally {
      $modalInstall.disabled = false
      $modalShow.disabled = false
    }
  })

  // Boot: initial refresh + react to repo changes from anywhere in the app.
  refresh()
  const sse = window.__blastradiusSse
  if (sse && typeof sse.addEventListener === 'function') {
    sse.addEventListener('repo-changed', () => { refresh() })
    sse.addEventListener('hook-installed', () => { refresh() })
  }
})()

// ─── Export report (rc8.6) ────────────────────────────────────────────────
//
// Self-contained: wires the two export buttons in the iteration panel
// to /api/report.md (download) and /api/report.html (printable view).
// The query mirrors the dashboard's ACTIVE filters (same logic as the
// heat fetch in refreshHeat): a date range wins over the time-window,
// and the platform/agent filter always rides along — so the exported
// report is scoped identically to what's on screen. Server builds both
// from the live heat + knowledge-graph snapshot.
;(() => {
  const $md = document.getElementById('export-md')
  const $html = document.getElementById('export-html')
  const $status = document.getElementById('export-status')
  if (!$md || !$html) return

  // Build the report query string from the same state the heat map uses.
  // Keep this in lock-step with the URL assembly in refreshHeat().
  function reportQuery() {
    const params = new URLSearchParams()
    if (state.dateRange && state.dateRange.from && state.dateRange.to) {
      params.set('since', state.dateRange.from)
      params.set('until', state.dateRange.to)
    } else {
      params.set('window', state.windowName || 'session')
    }
    if (state.platform) params.set('platform', state.platform)
    return params.toString()
  }

  let statusTimer = null
  function setStatus(msg, isError, ms = 4000) {
    if (!$status) return
    $status.textContent = msg
    $status.classList.toggle('is-error', !!isError)
    $status.classList.toggle('is-ok', !isError)
    $status.hidden = false
    if (statusTimer) clearTimeout(statusTimer)
    if (!isError) statusTimer = setTimeout(() => { $status.hidden = true }, ms)
  }

  $md.addEventListener('click', async () => {
    $md.disabled = true
    try {
      const res = await fetch('/api/report.md?' + reportQuery())
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const blob = await res.blob()
      // Filename from the server's Content-Disposition, fallback otherwise.
      const cd = res.headers.get('content-disposition') || ''
      const m = cd.match(/filename="([^"]+)"/)
      const name = m ? m[1] : 'blastradius-report.md'
      // Blob + temp anchor download — reliable in both browser and the
      // Tauri webview (window navigation to a download URL is flaky there).
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      // The desktop WebView2 shell saves downloads silently (no native
      // dialog), so confirm the filename + where it landed explicitly —
      // otherwise the user can't tell the download happened at all.
      setStatus('✓ Saved “' + name + '” to your Downloads folder.', false, 8000)
    } catch (err) {
      setStatus('Export failed: ' + String(err && err.message ? err.message : err), true)
    } finally {
      $md.disabled = false
    }
  })

  $html.addEventListener('click', () => {
    // Print via a hidden, same-origin iframe that prints ITSELF. We load
    // the report with ?print=1, which makes the page run a tiny inline
    // window.print() on load. The parent never touches the iframe's
    // contentWindow — in the Tauri WebView2 shell that cross-frame
    // access throws a SecurityError ("Blocked a frame … from accessing a
    // cross-origin frame"), which is exactly what broke Print/PDF in the
    // .exe. window.open('_blank') is also a no-op there, so this iframe
    // path is the only thing that works in both the browser and desktop.
    const url = '/api/report.html?' + reportQuery() + '&print=1'
    const prev = document.getElementById('print-frame')
    if (prev) prev.remove()
    const frame = document.createElement('iframe')
    frame.id = 'print-frame'
    frame.setAttribute('aria-hidden', 'true')
    // Off-screen but still rendered (display:none would suppress print).
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;'
    frame.addEventListener('error', () => {
      setStatus('Could not load the report for printing.', true)
    })
    frame.src = url
    document.body.appendChild(frame)
    setStatus('Opening the print dialog… choose "Save as PDF" to export.')
  })
})()

// ─── Resizable panels (rc8.6) ─────────────────────────────────────────────
//
// Drag the gutters between the main pane and the side/iteration panels to
// set their width. The width lives in a CSS custom property on .layout
// (--side-w / --iter-w, consumed by the grid-template-columns clamp) and
// is persisted to localStorage so it survives reloads. Pointer Events +
// setPointerCapture make the drag robust even when the cursor leaves the
// 9px gutter; arrow keys provide a keyboard-accessible nudge.
;(() => {
  const layout = document.querySelector('.layout')
  if (!layout) return

  // Min/max MUST match the clamp() bounds in styles.css (.layout).
  const CONFIG = {
    side: { cssVar: '--side-w', min: 240, max: 620, storeKey: 'blastradius:sideWidth', panel: '.side-panel' },
    iter: { cssVar: '--iter-w', min: 220, max: 520, storeKey: 'blastradius:iterWidth', panel: '.iter-panel' },
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

  // Restore persisted widths before first paint of the rail.
  for (const cfg of Object.values(CONFIG)) {
    try {
      const raw = localStorage.getItem(cfg.storeKey)
      if (raw != null) {
        const n = clamp(parseInt(raw, 10), cfg.min, cfg.max)
        if (Number.isFinite(n)) layout.style.setProperty(cfg.cssVar, n + 'px')
      }
    } catch { /* localStorage blocked → fall back to CSS defaults */ }
  }

  const apply = (cfg, width) => {
    const w = clamp(Math.round(width), cfg.min, cfg.max)
    layout.style.setProperty(cfg.cssVar, w + 'px')
    try { localStorage.setItem(cfg.storeKey, String(w)) } catch { /* ignore */ }
  }

  for (const resizer of document.querySelectorAll('.panel-resizer')) {
    const cfg = CONFIG[resizer.dataset.resizes]
    if (!cfg) continue

    let startX = 0
    let startW = 0
    let pointerId = null

    const onMove = (ev) => {
      // Dragging the gutter LEFT widens the panel sitting to its right.
      apply(cfg, startW + (startX - ev.clientX))
    }
    const onUp = () => {
      resizer.classList.remove('is-dragging')
      document.body.classList.remove('is-resizing-panels')
      try { if (pointerId != null) resizer.releasePointerCapture(pointerId) } catch { /* ignore */ }
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      pointerId = null
    }

    resizer.addEventListener('pointerdown', (ev) => {
      const panel = document.querySelector(cfg.panel)
      if (!panel) return
      startX = ev.clientX
      startW = panel.getBoundingClientRect().width
      pointerId = ev.pointerId
      try { resizer.setPointerCapture(pointerId) } catch { /* ignore */ }
      resizer.classList.add('is-dragging')
      document.body.classList.add('is-resizing-panels')
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      ev.preventDefault()
    })

    // Keyboard: ←/→ nudge by 16px (left = wider, matching the drag
    // direction), Home/End jump to max/min.
    resizer.addEventListener('keydown', (ev) => {
      const panel = document.querySelector(cfg.panel)
      if (!panel) return
      const cur = panel.getBoundingClientRect().width
      let next = null
      if (ev.key === 'ArrowLeft') next = cur + 16
      else if (ev.key === 'ArrowRight') next = cur - 16
      else if (ev.key === 'Home') next = cfg.max
      else if (ev.key === 'End') next = cfg.min
      if (next != null) {
        ev.preventDefault()
        apply(cfg, next)
      }
    })
  }
})()
