# Changelog

All notable changes to BlastRadius are documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/) and
this project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0-rc8.6] — 2026-05-29 — Report export, new-file diffs, resizable panels

Quality-of-life bundle, zero new dependencies:

1. **Export the session as a report** — a Markdown digest you can paste
   into a PR or IdeaBlast, and a printable HTML view (Ctrl/Cmd+P → Save
   as PDF). The export honors the **same filters as the dashboard**
   (time-window, agent/platform, and the date range), so the report
   always matches what's on screen.
2. **New files now show their contents in the diff** — a brand-new
   (untracked) file used to open an empty pane; it now renders its full
   contents as an "added" diff and is badged **NEW**.
3. **Resizable dashboard panels** — drag the gutters to set the width of
   the file-detail and iteration panels; the choice persists.

### Added

- **`GET /api/report.md`** — Markdown digest of the active repo honoring
  the same filters as `/api/heat`: `?window=` (session | iteration |
  hour | day), `?platform=` (agent filter), and the `?since=`/`?until=`
  date range. Contents: metrics (red/green/yellow + blast radius),
  edited / read / propagated files with their last agent, **the
  knowledge-graph annotations (summaries + tags persisted via the
  `set_node_summary` MCP tool — or an explicit "no annotations yet" note
  when none exist)**, and knowledge-graph stats when the graph is built.
  The header states its scope honestly (date range when active, agent
  filter when not "all"). Served as a download
  (`Content-Disposition: attachment`).

- **`GET /api/report.html`** — the same data as a self-contained,
  print-optimized HTML document (white background, no external assets,
  no scripts). Served inline so the browser renders it for Ctrl+P.

- **`src/server/reportBuilder.js`** — pure `buildMarkdownReport()` +
  `buildHtmlReport()`. No IO, no server coupling — given a data object
  they always produce the same string, which makes them unit-testable.

- **Export controls in the iteration panel** — "Download .md" (Blob +
  temp-anchor download, reliable in both the browser and the Tauri
  webview) and "Print / PDF" (opens the printable HTML). The export
  query mirrors the dashboard's **active filters** (date range when set,
  else the time-window; plus the agent/platform filter) using the same
  URL assembly as the live heat fetch — the report can't silently
  diverge from the heat map.

- **Resizable right-rail panels** — thin drag gutters between the main
  pane and the file-detail / iteration panels. The width lives in a CSS
  custom property on `.layout` (consumed by a `clamp()`-bounded
  `grid-template-columns`) and is persisted to `localStorage`, so it
  survives reloads. Gutters are `role="separator"` and keyboard-operable
  (←/→ nudge, Home/End jump to max/min); they're hidden in the narrow
  stacked layout where there's no vertical boundary to drag.

### Fixed

- **New / untracked files now render their contents in the diff.** A
  brand-new file fails both `git diff HEAD` (untracked files are
  ignored) and `git log` (no history), so the diff modal used to show an
  empty pane. `DiffProvider` now detects this case and renders the file
  as a pure "added" diff (every line a `+`), reusing the same diff2html
  pipeline. Guards for missing / non-regular / oversized (> 10 MB) /
  binary (NUL-byte) / empty files. The modal badges it a green **NEW
  FILE** (`source: 'untracked'`) instead of the old dim "nothing here"
  hint.

### Changed

- **Filter-aware export (folded into rc8.6).** `/api/report.md|html` and
  the export buttons now apply the window **and** the platform/agent
  filter **and** the date range — previously they only honored the
  window and hardcoded `platform: 'all'`, so a filtered dashboard still
  exported the full, unfiltered iteration. `/api/heat` and the report
  routes now share one `parseHeatFilters()` + `computeHeatForFilters()`
  pair (single source of truth), so they apply identical filters by
  construction.

### Security

- `buildHtmlReport` HTML-escapes every repo-originated value (file
  paths, agent names) — a path can legally contain `< > & " '`, and the
  HTML opens in a browser/print context, so unescaped content would be
  an injection vector. Covered by a dedicated "injection defense" test.
- The report routes take **no user-supplied paths** — always scoped to
  the active repo — so there's no traversal surface to validate.

### Tests

- `tests/reportBuilder.test.js` — 16 vitest cases (Markdown content,
  HTML document shape, HTML-escaping injection defense, empty-report
  resilience, **the date-range + agent-filter scope header, and escaping
  the client-controlled platform value**) + bug-bites-back on escaping.
- `tests/routes-report.test.js` — 10 vitest cases (Content-Type +
  attachment disposition for `.md`, inline HTML, window param, 503 with
  no active repo, **platform + date-range reflected in the report, and
  invalid/incomplete ranges → 400 matching the `/api/heat` contract**).
- Verified end-to-end against an isolated live server: a `platform=`
  filter drops the other agent's files, and the report's `red` count
  matches `/api/heat` for the same filter.
- `tests/diffProvider.test.js` — +9 cases: untracked files render their
  contents (source `untracked`, `stats.added > 0`); empty / binary /
  missing / no-trailing-newline edge cases; pure `buildAddedFilePatch()`
  + `looksBinary()` unit tests.
- `tests/e2e/panel-resize.spec.js` — Playwright: dragging the side gutter
  widens the panel + persists across reload, and the keyboard nudge path.
- **494 vitest total**, **9 Playwright** (+2 panel-resize).

### Build / Bundle

- Installers regenerated at WiX bundle version `1.0.0.14` (rc8.5
  was `.13`).

### Commits

- feat(report): export session as Markdown + printable HTML
- feat(report): include knowledge-graph annotations in the export
- feat(report): honor the dashboard's active filters in the export
- feat(ui): new-file diffs (badged NEW) + drag-resizable panels

---

## [1.0.0-rc8.5] — 2026-05-28 — Startup splash + server-stopped banner

Two reliability/polish fixes for the desktop `.exe`. The dashboard
opened via `run.bat` + browser was always fine; the `.exe` had a
race that showed the browser engine's "no connection" error on every
launch.

### Fixed — startup race (the "no connection" error)

- **The `.exe` showed WebView2's `ERR_CONNECTION_REFUSED` page on
  launch.** The Tauri shell spawns the sidecar Node server AND opens
  the webview pointing at `http://localhost:7842` at the same time;
  the webview reached the URL ~1-3 s before the server was listening,
  so it painted the browser engine's error page and never retried.
  (run.bat → browser never hit this because the user opens the
  browser *after* the server is already up.)

- Fix in `src-tauri/src/lib.rs` + `tauri.conf.json`:
  - The main window now starts `visible: false`.
  - A borderless **splash window** (⚡ BlastRadius + spinner +
    "Starting the dashboard server…") shows immediately, loaded from
    a temp `file://` document.
  - A background thread polls the port (native TCP — no CORS, since
    the server is same-origin-only) up to 30 s. When the sidecar
    answers it **navigates the main webview fresh** (critical: the
    hidden webview was parked on the failed-navigation error page and
    won't auto-retry, so a bare `show()` would reveal that stale
    error — `navigate()` forces a clean load), lets the dashboard
    paint behind the splash to avoid a white flash, then reveals main
    and closes the splash.
  - On a 30 s timeout the splash flips to an actionable error
    pointing at `~/.blastradius/logs/server.log` instead of spinning
    forever.

### Added — server-stopped banner

- A red banner appears if the sidecar dies mid-session: the SSE
  connection fails `SERVER_DEAD_FAILURE_THRESHOLD` (3) consecutive
  times AND a confirming `/api/health` probe also fails. "Retry
  connection" re-probes and auto-dismisses when the server returns.
  A single transient reconnect blip never triggers it (the health
  probe confirms the server is actually down first).

- Decision logic extracted to `src/public/serverHealth.js`
  (`shouldShowServerDeadBanner`) so it's unit-testable in isolation.

### Tests

- `tests/serverHealth.test.js` — 6 vitest cases on the banner-trigger
  threshold logic + bug-bites-back.
- `src-tauri/src/lib.rs` `#[cfg(test)]` — 2 Rust cases on the
  port-readiness primitive the poll loop depends on.
- The splash window lifecycle itself is verified by visual smoke of
  the `.exe` (Tauri window orchestration can't be unit-tested, and
  `tauri dev` can't reproduce this app — its dev flow waits for a
  frontend dev server that the app itself spawns, a deadlock).

### Build / Bundle

- Installers regenerated at WiX bundle version `1.0.0.13` (rc8.4
  was `.12`).

### Commits

- (this release) feat(ux): startup splash + server-stopped banner

---

## [1.0.0-rc8.4] — 2026-05-27 — Auto-install hook from dashboard

Quality-of-life release fixing the most common new-user friction:
BlastRadius could detect a fresh local repo via the .git/ walker but
couldn't *observe* it until the user ran `scripts/install-hook.ps1`
manually for that repo. From rc8.4 onward, the dashboard surfaces a
banner the moment the active repo lacks the hook and offers a
one-click "Activate" with explicit consent.

### Added — UX

- **Hook-install banner under the topbar.** Visible when the active
  repo's `.claude/settings.json` does not contain the BlastRadius
  PostToolUse hook AND the repo is not in
  `preferences.ignoredHookRepos`. Three actions:
  - **Activate** — opens a modal with the exact path that will be
    written, an explanation of what the hook does, and two buttons.
  - **Details** — same modal, no install pre-armed.
  - **Don't show again** — persists the repo to
    `preferences.ignoredHookRepos`; banner never returns for that path.

- **Confirmation modal** with dual confirmation:
  - **Install now** — runs the Node-side installer, writes the
    `.claude/settings.json` entry, shows `Hook installed. Restart
    Claude Code in this repo for it to take effect.`
  - **Show command only** — reveals the PowerShell equivalent
    (`install-hook.ps1 -ProjectPath ...`) for users who prefer the
    manual flow.

- **`set_node_summary`-style consent.** The dashboard NEVER writes a
  settings.json without a click in the modal — even though the
  endpoint is reachable from a local-loopback request. The two-step
  banner → modal → button gating is the UX contract.

### Added — backend

- **`src/server/hookInstaller.js`** — pure Node module that
  reimplements the JSON-writing portion of
  `scripts/install-hook.ps1` byte-for-byte at the logical level.
  `getHookStatus(repoPath, opts)` for the read path,
  `installHook(repoPath, opts)` for the write path,
  `buildHookEntry(opts)` shared by both. Atomic tmp+rename writes,
  `.bak.yyyyMMdd-HHmmss` backups (same `Get-Timestamp` format the
  PowerShell uses), chmod 0600 on POSIX.

  One deliberate improvement over PS: idempotency is **JSON-semantic**
  instead of byte-equal string compare. A repo registered via the PS
  installer and later "re-activated" from the dashboard does NOT
  bounce on formatting differences — same logical entry returns
  `action: 'noop'`.

- **`GET /api/repo/hook-status?path=<absRepoPath>`** — read-only
  status check. Returns `{ installed, settingsExists, settingsPath,
  expectedCommand, currentCommand, reason }`. Tolerates paths outside
  `parentDir` (the installer rejects them via its own validation).

- **`POST /api/repo/install-hook` body `{ path }`** — write endpoint.
  **Load-bearing security gate**: the path MUST be inside
  `preferences.parentDir`. Anything outside returns 400
  `repo_outside_parent_dir` and the file is NEVER touched. NUL bytes,
  `..` traversal, and absolute non-directory paths are also rejected
  with 400 before the installer runs. On success, broadcasts SSE
  `hook-installed` so the banner disappears immediately.

- **`preferences.ignoredHookRepos`** — new array field on
  `~/.blastradius/preferences.json`. Same additive, validated pattern
  as `viewMode` (rc8.D). `normalize()` enforces array-of-strings,
  `load()` tolerates missing/malformed fields (forward-compat with
  pre-rc8.4 prefs files).

### Tests

- **`tests/hookInstaller.test.js`** (7 cases) — module-level: install
  into fresh repo, merge into existing `settings.json` without
  losing unrelated keys, idempotent second run, path traversal,
  missing `.git/`, status reporting before / after install.

- **`tests/routes-hook.test.js`** (6 cases) — Express integration via
  `makeRouter()` with hand-built fixtures: GET status (installed=
  false / true / traversal), POST install (success, parentDir gate,
  body traversal).

- **`tests/e2e/hook-banner.spec.js`** (2 Playwright cases) — sandbox
  parentDir + fresh fixture repo with `.git/` but no `.claude/`:
  banner appears, click Activate → click Install now → modal closes
  → banner disappears → `settings.json` on disk contains the
  expected hook entry. Second case: Don't show again → reload →
  banner stays hidden (persisted in `preferences.ignoredHookRepos`).

- **Three independent bug-bites-back cycles** (`hookInstaller.js`
  aside → 7/7 RED, `routes.js` stashed → 6/6 RED, UI trio stashed →
  2/2 RED). Each restored returns to GREEN.

### Internal

- **`tests/mcp/rate-limit.test.js`** — flake fix. The serial
  110-request loop assumed completion faster than the bucket's
  ~33ms-per-token refill. The 13 new vitest cases in rc8.4
  introduced enough parallel CPU contention to push the loop past
  the threshold. Swapped to `Promise.all(200)` concurrent burst so
  the bucket has no time to refill mid-test. Stable across 5/5
  consecutive runs.

- `makeRouter()` now accepts `logDir` as an explicit dep instead of
  reading `process.env.BLASTRADIUS_LOG_DIR` inside the new
  endpoints. Production wires from the same env var
  (`src/server/index.js`) — no behavior change. Tests pass any value.

### Compatibility

- **`scripts/install-hook.ps1` is unchanged.** The PowerShell flow
  remains the manual / CI path, and is the only option for repos
  OUTSIDE `parentDir` (the dashboard's POST endpoint refuses those
  by policy).

- **Existing `.claude/settings.json` files written by the PowerShell
  installer are recognized as-installed** — the JSON-semantic
  idempotency check matches the entry regardless of formatting.
  Clicking Activate in the dashboard for a repo that was already
  PS-installed returns `action: 'noop'` and the banner disappears.

### Build / Bundle

- Tauri NSIS + MSI installers regenerated at `1.0.0.12` (WiX bundle
  version, monotonic continuation: rc8.3 was `.11`, rc8.2 was `.10`,
  rc8.1 was `.9`, rc8 was `.8`).

### Test counts

- Vitest: **453 passed**, 4 skipped, 0 failed (+13 vs rc8.3 baseline)
- Playwright: **7 passed** (+2 vs rc8.3 baseline)
- `npm audit`: 0 vulnerabilities

### Commits

- `7407d25` — feat(hook): auto-install hook from dashboard (rc8.4)

---

## [1.0.0-rc8.3] — 2026-05-27 — summarize_progress sees past days

Patch release fixing one backend asymmetry surfaced during a Tech
Lead audit of the MCP surface. No UI changes, no new features.

### Fixed — MCP backend

- **`summarize_progress` returned `no_events_recorded` for any past-day
  window, even when `session-YYYY-MM-DD.jsonl` existed on disk.** The
  handler always read from the today-only in-memory buffer (`getEvents()`
  / `getEventsForRepo()`), never calling `loadDays()` to materialize the
  historical cache. Asymmetric vs `describe_node`, which has used the
  historical accessors since rc7.

  Fix in `src/mcp/tools.js`: when the caller passes `since` and/or
  `until`, await `loadDays({ from, to })` then route through
  `getEventsInRange()` / `getEventsForRepoInRange()` for both `useAll`
  branches. `RangeError` from `loadDays()` (range > MAX_RANGE_DAYS=30)
  is translated to a NO-DATA `reason: "range_exceeds_max_days"` response
  instead of bubbling as a protocol error.

  When neither `since` nor `until` is provided, the original synchronous
  `getEvents()` / `getEventsForRepo()` path is preserved — zero async
  overhead for the default "active iteration" call used by every Claude
  Desktop "what am I touching right now?" prompt.

### Tests

- New regression file `tests/mcp/summarize-progress-range.test.js` with
  two cases: past-day happy path + 31-day range error path. Uses a real
  `EventStore` against a tempDir so the JSONL seeding + historical load
  is exercised end-to-end through the real `createMcpServer`.

- Extended `fakeEventStore` in `tests/mcp/server.test.js` to cover the
  rc7+ historical API (`loadDays` / `getEventsInRange` /
  `getEventsForRepoInRange`). Previously uncovered because no test in
  that file exercised the historical path through `summarize_progress`
  — the new fix exercises it for the first time.

### Known limitation (not blocking)

- Path normalization in older JSONL entries (mixed forward-slash /
  backslash on Windows) may cause repo-relative filtering in
  `getEventsForRepoInRange()` to drop events that have absolute paths
  serialized inconsistently. Surfaces only on historical day queries
  against logs written by pre-rc7 hooks. Tracked separately — fix
  candidate for rc8.4.

### Commit

- `8071e03` — fix(mcp): summarize_progress now supports multi-day
  windows via eventStore.loadDays

---

## [1.0.0-rc8.2] — 2026-05-26 — Backend honesty: stats + orphans

Follow-up to rc8.1 catching two functional backend bugs the user
confirmed against `curl http://localhost:7842/api/graph` minutes
after rc8.1 shipped. The Help modal refresh that was originally
scheduled for rc8.2 lands here too, but as a cosmetic addendum —
the backend bugs are why this version exists.

### Fixed — backend

- **`GET /api/graph` was hiding aggregate stats from consumers.**
  The payload exposed `stats: { nodes, edges, cycles, orphans,
  withSummary }` as a nested object, but neither the dashboard nor
  the documented contract surfaced top-level counters. The dashboard
  was reading `body.stats.nodes` *and* doing client-side math against
  the (possibly truncated) `body.nodes` array — two reads that drift
  the instant the snapshot exceeds the 200-node default cap.

  Fix in `src/server/routes.js`: surface the counters as top-level
  fields with stable names, **always** describing the FULL snapshot
  regardless of slicing:

  ```json
  {
    "builtAt": "...",
    "totalNodes": 27,
    "totalEdges": 39,
    "cycleCount": 0,
    "orphanCount": 1,
    "withSummary": 1,
    "stats": { ... },          // ← backwards-compat alias preserved
    "nodes": [...],            // ← slice-capped at `limit`
    "edges": [...]
  }
  ```

  Dashboard's graph-pane header now reads `totalNodes`/`totalEdges`/
  `cycleCount`/`orphanCount`/`withSummary` from the backend with a
  `?? body.stats?.*` fallback chain for graceful degradation if
  someone runs a mixed build during an upgrade. No more
  `nodes.length` math anywhere.

- **`getOrphans()` silently missed `src/public/app.js`.** The
  `DEFAULT_ENTRY_POINTS` allowlist in `src/server/knowledgeGraph.js`
  was a Set of basenames (`'index.js'`, `'app.js'`, …). The basename
  `app.js` matched both `src/server/app.js` (a hypothetical
  legitimate entry) AND `src/public/app.js` (browser code
  dependency-cruiser can't parse, so it surfaces with fanIn=0
  fanOut=0 — a textbook orphan informativo). The collision excluded
  the public/app.js from every orphan query.

  Two changes:

  1. `DEFAULT_ENTRY_POINTS` is now a Set of **full repo-relative
     paths**: `src/server/index.js`, `src/hook/log-touch.js`,
     `src/hook/log-touch-antigravity.js`,
     `bin/blastradius-mcp.{mjs,cjs}`, `vitest.config.js`,
     `playwright.config.js`. No more basename collisions, no more
     accidental allowlist matches in user repos.
  2. Orphan rule tightened: `fanIn === 0 && fanOut === 0 &&
     !entryPoints.has(pathNorm)`. A node that imports anything
     (`fanOut > 0`) is participating in the graph as an importer
     and therefore not "isolated"; a node with both fans at zero
     IS isolated and gets surfaced unless the explicit allowlist
     vetoes it.

  After the fix, `curl /api/graph/orphans` against the BlastRadius
  self-observation surfaces `["src/public/app.js"]` instead of
  the empty list.

### Tests — bug-bites-back validated

- `tests/routes-graph.test.js` (2 new vitest cases) boots Express
  with `makeRouter()` and a hand-built snapshot, asserts both the
  top-level counter contract AND that the counters stay honest under
  `?limit=5` truncation. Reverting the routes fix breaks both
  scenarios at `expect(body.totalNodes).toBe(...) === undefined`.
- `tests/knowledgeGraph.test.js` (orphan section rewritten +
  expanded, +2 net new cases). Coverage now includes:
  - `fanOut > 0` nodes are NOT flagged as orphans regardless of
    fanIn — the participation rule.
  - **rc8.2 regression** — `src/public/app.js` with both fans at
    zero IS an orphan (the bug we just fixed).
  - **rc8.2 regression** — `src/server/index.js` is NEVER an
    orphan, covered both via fanOut > 0 AND via the allowlist
    short-circuit.
  - Custom `entryPoints` allowlist accepts full paths.

  Reverting the engine fix breaks 3 of these scenarios at exactly
  the expected assertions.

### Added — cosmetic (Help modal refresh + drift guardrail)

  Originally the headline of rc8.2; demoted now that two real bugs
  share the version. Still ships because the surface drift was
  legitimate and the new E2E suite is the only thing that prevents
  this class of bug from recurring.

- **Help modal "Tools & Resources" tab** in `src/public/index.html`:
  - Header now says "ten read-only tools, one mutating tool guarded
    by `requiresConsent`, and nine resources (plus one templated)"
    instead of the stale "four tools / six resources".
  - Tools section split into two tables: "observability (Phase 1,
    rc7)" with the 5 read-only tools (incl. the previously-omitted
    `list_days_with_activity`), and "Knowledge Graph (rc8+)" with
    the 5 new ones. `set_node_summary` carries a "write" pill so
    the mutation gate is visually obvious.
  - Resources section split into two tables: "observability
    (Phase 1)" and "Knowledge Graph (rc8+)".
  - NO-DATA reason-code list grew 9 new entries: `graph_not_ready`,
    `unknown_node`, `no_matches`, `cycles_none`, `orphans_none`,
    `summary_too_long`, `too_many_tags`, `tag_too_long`,
    `tag_invalid_type`.

- **Sample Prompts tab**: four new Knowledge Graph prompts —
  *Impact analysis before a refactor*, *Dead-code review*,
  *Cycle detection + remediation*, and *Persist what you've learned*
  (the consent-gated mutation example).

- **Playwright suite at `tests/e2e/help-modal.spec.js`** (3 new
  scenarios). Queries the live MCP server for `tools/list` /
  `resources/list` and asserts every name appears verbatim in the
  rendered Help modal. Reverting the index.html catalog updates
  makes all 3 scenarios fail at exactly the expected assertions.

- **`.help-pill-write`** CSS — a small amber chip on mutating tools
  so the consent gate doesn't blend into the read-only catalog.

### Internal

- E2E count: 2 → 5. Vitest count: 434 → 438 (+4: 2 routes-graph + 2
  net orphan). Total checks: **438 vitest + 5 Playwright + 27
  PowerShell = 470 checks, 0 failed.**
- `basename()` helper in `knowledgeGraph.js` removed (the orphan
  loop was its only caller).

### Build / Bundle

- Tauri NSIS + MSI installers regenerated at `1.0.0.10` for the WiX
  bundle version (monotonic continuation: rc8 was .8, rc8.1 was .9).

---

## [1.0.0-rc8.1] — 2026-05-26 — Graph view bugfix + E2E suite

Hotfix for two interlocking bugs discovered immediately after the
rc8 release shipped:

### Fixed

- **`.graph-empty` overlay leaked through `[hidden]`**. The empty-
  state pane (`<p id="graph-empty">`) used `display: flex` at higher
  CSS specificity than the user-agent `[hidden] { display: none }`
  rule. So even when JS set `hidden=true` after a successful graph
  load, the overlay stayed visible AND its `position:absolute;
  inset:0` box continued to occupy the canvas, **stealing every
  click**. Symptom: in graph mode the nodes rendered correctly but
  clicks did nothing and the "Knowledge Graph not ready yet." text
  hovered over a perfectly valid graph.

  Fix in `src/public/styles.css`:
    - explicit `.graph-empty[hidden] { display: none }` to anchor
      the visibility contract back to the attribute
    - `pointer-events: none` on `.graph-empty` itself as a
      belt-and-braces defense — the overlay is informational only
      and should never block interaction even if it's visible

- **`refreshHeat()` overwrote the Graph-mode side-panel editor**.
  When an SSE `heat-update` event arrived while the user was
  editing a node summary, `refreshHeat()` unconditionally called
  the Tree-mode `renderSidePanel()` which doesn't know about the
  inline editor markup → blew away the in-progress textarea and
  tag input. Fixed by gating that branch on
  `layout[data-view] !== 'graph'`.

### Added — E2E suite (Playwright)

  - `playwright.config.js`: spawns `node src/server/index.js` on
    port 43020 with a sandbox `BLASTRADIUS_HOME_DIR` so tests
    never touch the user's real `~/.blastradius/`. Sandbox seeds
    preferences with `viewMode='graph'` so the dashboard opens
    directly into the graph view.

  - `tests/e2e/graph-view.spec.js`: two scenarios.
    1. **"graph renders, overlay hides, nodes are clickable,
       editor shows"** — boots in graph mode, waits for the d3
       force-directed simulation to render ≥ 5 `circle.gnode`
       elements, asserts `#graph-empty` is BOTH `hidden` AND
       computed-style `display: none` (this is the rc8 bug
       guardrail), clicks `src/server/heatEngine.js`, asserts the
       inline editor inputs appear, writes a summary + tags,
       clicks Save, expects the status pill to flip to `is-ok`
       and the node ring to gain the `has-summary` purple stroke.
    2. **"Tree↔Graph toggle persists across reload"** — flips
       to Tree, reloads, asserts `layout[data-view]` is still
       `tree` (round-trip through `preferences.json`).

  Validated both directions: with the CSS fix the suite passes in
  ~10 s; reverting the fix makes the first scenario fail at
  `expect(emptyOverlay).toBeHidden()` exactly as designed.

### Internal

- New env var `BLASTRADIUS_HOME_DIR` on `src/server/index.js`
  propagates to both `PreferencesStore` and `KnowledgeStore`.
  Production never sets it; E2E tests pin to a sandbox dir.
- `KnowledgeStore` constructor now accepts an optional `homeDir`
  (symmetry with `PreferencesStore`).
- `vitest.config.js` excludes `tests/e2e/**` so Vitest doesn't
  accidentally pick up Playwright spec files.

### Build / Bundle

- Tauri NSIS + MSI installers regenerated at `1.0.0.9` for the WiX
  bundle version. **The rc8 installers should be considered
  defective; download rc8.1 instead.**

---

## [1.0.0-rc8] — 2026-05-26 — Knowledge Graph

The dashboard now understands the *structure* of the repo, not just its
recent activity. rc8 layers a strictly-additive Knowledge Graph on top
of the existing heat overlay: every source file becomes a node with
fanIn / fanOut / kind / sizeBytes / optional human-or-agent summary,
edges come from dependency-cruiser, and the whole thing is exposed
through HTTP + MCP + a new D3 force-directed view.

Local-first contract preserved: zero external graph DBs, all
persistence in `~/.blastradius/knowledge.json` (chmod 0600 on POSIX),
all path inputs flow through the same `DiffProvider.validatePath`
that gates `/api/diff`. The `log-touch.js` hook is unchanged and
still hits its <100 ms wallclock budget.

Shipped in four atomic phases (each green on its own commit):

  - **Phase A** — `feat(graph): add KnowledgeGraph engine and persistent store (rc8 phase A)` — `406fe45`
  - **Phase B** — `feat(api): expose Knowledge Graph via 6 /api/graph/* endpoints (rc8 phase B)` — `21e74c2`
  - **Phase C** — `feat(mcp): expose Knowledge Graph via 5 tools + 4 resources (rc8 phase C)` — `49cbe5b`
  - **Phase D** — `feat(ui): Tree↔Graph toggle + D3 force-directed Knowledge Graph (rc8 phase D)` — `55e6bc7`

### Added — Engine + persistence (Phase A)

- **`KnowledgeStore`** at `src/server/knowledgeStore.js` —
  multi-repo singleton backed by `~/.blastradius/knowledge.json`.
  Caps: summary ≤ 2000 chars, ≤ 20 tags per node × 32 chars per tag,
  5000 nodes per repo. Atomic tmp+rename writes; chmod 0600 on POSIX;
  corruption is renamed to `.bak.corrupted-<TS>` instead of being
  silently lost. Stable error codes: `summary_too_long`,
  `too_many_tags`, `tag_too_long`, `tag_invalid_type`, `invalid_path`,
  `invalid_repo`, `repo_node_cap_reached`.
- **`KnowledgeGraph`** at `src/server/knowledgeGraph.js` —
  composes the existing `graphResolver` (forward / reverse import
  maps, untouched) + `knowledgeStore` + `eventStore` into a per-node
  snapshot. Computes cycles via iterative Tarjan's SCC (yields to
  the event loop every 500 nodes via `setImmediate`), orphans
  (fanIn 0 outside the `DEFAULT_ENTRY_POINTS` allowlist), and
  per-node stats. fs.stat batched at concurrency 50. Lifecycle
  mirrors `GraphResolver`: atomic swap on `rebuild()`, last good
  snapshot wins on failure, `scheduleRebuild()` debounced 500 ms.
- **47 new vitest cases** at `tests/knowledgeStore.test.js`
  (25 cases) and `tests/knowledgeGraph.test.js` (22 cases).

### Added — HTTP API (Phase B)

Six new endpoints under `/api/graph/*`. The single mutation surface
(`POST /api/graph/node`) is the one the dashboard's inline editor
calls — agents go through MCP instead.

- `GET  /api/graph` — nodes + edges with `limit` / `kinds` /
  `minFanIn` / `withSummaryOnly` filters. Default cap 200, hard
  ceiling 1000.
- `GET  /api/graph/neighbors?path=&depth=&direction=` — BFS up
  (consumers), down (dependencies), or both. `depth` clamped [1, 10].
- `GET  /api/graph/node?path=` — single node detail.
- `POST /api/graph/node` — write summary + tags. Body
  `{ path, summary, tags }`. Atomic in-memory snapshot refresh +
  SSE broadcast `knowledge-graph-update`.
- `GET  /api/graph/cycles` — strongly-connected components > 1
  plus self-edges.
- `GET  /api/graph/orphans` — candidates for dead-code review.

All path inputs go through `DiffProvider.validatePath` — same
defense-in-depth used by `/api/diff` (NUL-byte rejection, absolute-
path rejection, dot-dot traversal blocked via the `startsWith(root +
sep)` check). Validation failures surface the canonical error codes:
`invalid_path`, `nul_byte`, `absolute_path`, `escapes_root`,
`invalid_direction`.

### Added — MCP surface (Phase C)

The MCP server now exposes **10 tools + 9 static resources + 1
templated resource** (was 5 + 5 + 1 in rc7).

- **`get_codebase_graph`** — `{ limit, kinds, minFanIn,
  withSummaryOnly }`. Same shape as `/api/graph`.
- **`get_nearest_neighbors`** — `{ path, depth, direction }`.
  Returns consumers + dependencies BFS.
- **`describe_node`** — full structural + semantic detail PLUS a
  cross-walk with the last 7 days of JSONL touch events.
- **`find_nodes`** — text search ranked path startsWith=10 > tag
  exact=8 > summary contains=5 > path contains=3.
- **`set_node_summary`** — *write*, the only mutation surface in
  the MCP layer. Annotations carry the 4 standard MCP mutation hints
  (`readOnlyHint:false`, `destructiveHint:false`,
  `idempotentHint:true`, `openWorldHint:false`) plus our additive
  `requiresConsent:true` flag for Phase 3 contract compliance.
  Optimistic in-memory snapshot refresh on success.
- **`blastradius://graph/summary`** — stats counters only.
- **`blastradius://graph/topology`** — full snapshot capped at 200
  nodes.
- **`blastradius://graph/cycles`** — SCC > 1 + self-loops; NO-DATA
  reason `cycles_none` for clean DAGs.
- **`blastradius://graph/orphans`** — fanIn 0 candidates excluding
  the entry-point allowlist.

NO-DATA reasons added (no tool / resource ever throws on absence):
`graph_not_ready`, `unknown_node`, `no_matches`, `cycles_none`,
`orphans_none`, `knowledge_store_unavailable`, plus the three
DiffProvider codes (`escapes_root`, `absolute_path`, `nul_byte`).

**27 new vitest cases** at `tests/mcp/knowledge-graph.test.js`.

### Added — Dashboard UI (Phase D)

- **Tree ↔ Graph toggle** in the topbar. Same visual language as
  the existing window-toggle / range-toggle bars; uses a purple
  underline (`#b07cff`) to distinguish "structural" from the time
  windows.
- **Persistence: `viewMode` in `preferences.json`** — values
  `'tree' | 'graph'`, default `'tree'`. Restored on boot before the
  first render so there's no Tree→Graph flicker on reload. Unknown
  on-disk values fall back to `'tree'` silently (forward-compat).
- **D3 force-directed renderer** — reads `/api/graph`, paints nodes
  with the live heat overlay (red / green / yellow / neutral, purple
  ring when a summary exists). Aggressive `alphaDecay: 0.06` so 200
  nodes converge in ~150 ticks instead of ~1000; an 8 s `setTimeout`
  failsafe `.stop()` catches degenerate graphs that never reach
  alphaMin; the `.on('end')` handler clears the failsafe on the
  success path. Pan + zoom via `d3.zoom` (0.2–4× scale). Drag pins a
  node while dragging, releases on mouseup. Labels only for nodes
  with fanIn ≥ 3 OR a persisted summary (showing every label on 200
  nodes is unreadable AND laggy). Window resize debounced 250 ms.
  Simulation is `.stop()`ped when leaving graph mode → zero idle CPU.
- **Inline summary + tags editor** in the side panel. Calls
  `POST /api/graph/node` (REST, *not* MCP — the consent gate doesn't
  apply when the user is right here). Server-side error codes
  (`summary_too_long`, `too_many_tags`, `tag_too_long`, …) surface
  verbatim. Optimistic update of the cached snapshot on success.
- **SSE consumer** — `knowledge-graph-update`, `tree-update`, and
  `repo-changed` all schedule a debounced (400 ms) graph refresh
  when graph view is active. Wired through the shared
  `window.__blastradiusSse` EventSource (no second connection).

### Internal

- New file count: 4 new source files (`knowledgeStore.js`,
  `knowledgeGraph.js`, `tests/knowledgeStore.test.js`,
  `tests/knowledgeGraph.test.js`, `tests/mcp/knowledge-graph.test.js`).
- 77 new vitest cases (25 Store + 22 Graph + 27 MCP + 3 preferences
  viewMode) bring the suite from 358 → 434 passing (4 skipped).
- `npm audit` clean (0 vulnerabilities).
- PowerShell installer suite still green (27 asserts, 0 failed).

### Build / Bundle

- Tauri NSIS + MSI installers regenerated at `1.0.0.8` for the
  WiX bundle version.

---

## [1.0.0-rc7] — 2026-05-26

### Added

- **Multi-day historical event loading** (`src/server/eventStore.js`).
  New additive surface on `EventStore`:
  `loadDays({ from, to })`, `getEventsInRange()`,
  `getEventsForRepoInRange()`, `listDaysWithActivity()`, plus the
  exported `MAX_RANGE_DAYS = 30` cap. The live `tail()` /
  `loadInitial()` path stays byte-equivalent to rc6 — historical
  reads go to a separate `historicalEvents` Map and never pollute
  the live array. The current day (if it falls inside the
  requested range) is served from the live tail, never re-read
  from disk, to avoid racing the watcher.

- **`/api/heat?since=YYYY-MM-DD&until=YYYY-MM-DD`** for date-range
  heat-map queries. Backward compatible — without these params the
  endpoint behaves exactly like rc6. Strict validation with
  machine-readable error codes:
  `date_range_incomplete`, `date_range_invalid`,
  `date_range_inverted`, `date_range_too_wide`. The
  shape-valid-but-impossible-date case (e.g. 2026-02-30) is caught
  by a `parseYmd()` round-trip check, not just the regex.

- **`GET /api/days`** enumerates session-*.jsonl files under the
  log directory with byte sizes, sorted desc, capped at 30
  entries.

- **Dashboard date-range selector** in the header. Presets:
  Today (default = live), Yesterday, 7d, 30d, Custom… (inline
  floating panel with two native `<input type='date'>` + Apply
  button). While a non-Today preset is active, the
  Iteration/Hour/Session toggle is disabled (the date range IS the
  time filter) and SSE heat-update nudges from the live store are
  ignored.

- **`summarize_progress.until`** — optional ISO timestamp upper
  bound for the MCP aggregation tool. Defaults to "no upper bound
  / now". Lets agents bound the window on both sides for
  end-of-day digests, post-mortems, etc. Inverted ranges are
  silently dropped (mirrors the lenient parsing of `since`).

- **New MCP tool: `list_days_with_activity`** — zero-argument
  discovery primitive that returns every YYYY-MM-DD with a
  session-*.jsonl on disk, sorted desc, capped at 30. Agents call
  this first to know which days have data before passing a window
  to `summarize_progress`.

- **2 new Sample Prompts** in the in-app Help modal:
  "End-of-day digest" and "Weekly review" — both exercise
  `list_days_with_activity` + `summarize_progress` with single-day
  bounds.

### Internal

- 24 new vitest cases across two files:
  `tests/eventStore-historical.test.js` (20 cases for the new
  EventStore surface) and 4 added cases in `tests/mcp/server.test.js`
  for the `until` arg and the `list_days_with_activity` tool.
- The streaming-readline parser was extracted to a private
  `#readJsonlFile()` helper shared between the live tail and the
  historical loader so both follow identical skip-blank / skip-
  malformed rules.
- The 11 original `tests/eventStore.test.js` cases continue to
  pass against the refactored internals — the extract is
  behaviour-preserving.

### Build / Bundle

- Tauri NSIS + MSI installers regenerated at `1.0.0.7` for the WiX
  bundle version.

---

## [1.0.0-rc6] — 2026-05-26

### Fixed (security — HIGH)

- **Server now binds to `127.0.0.1` by default, not every interface.**
  Through rc5, `app.listen(PORT)` was called without a host argument,
  which on Node defaults to the dual-stack unspecified address `::`
  (every IPv4 and IPv6 interface). On any developer workstation on a
  shared network — corporate LAN, café Wi-Fi, coworking, WSL2 with
  bridged networking — every device on the same broadcast domain
  could reach `/api/*`, `/api/diff?path=…`, and `/mcp` without
  authentication. The threat model published in `SECURITY.md` asserted
  the opposite ("local-only, no public surface"), so the bug was also
  a documentation contradiction visible to every public-repo visitor.

  Discovered by a pre-public OWASP audit. Now the default is explicit:
  `HOST = process.env.BLASTRADIUS_HOST || '127.0.0.1'`. Power users
  who deliberately want the previous behaviour (running the dashboard
  inside a VM and reaching it from the host, exposing through a
  reverse proxy, …) can set `BLASTRADIUS_HOST=0.0.0.0`. Any
  non-loopback value triggers a loud warning log at startup advising
  the operator to add their own auth layer.

  Verified empirically: `curl http://127.0.0.1:7842/api/health`
  succeeds; `curl http://<LAN-IP>:7842/api/health` times out with
  *connection refused*. Regression test in
  `tests/server-bind.test.js` (4 cases) guards against future
  "let me just remove the host arg" refactors.

  CWE-1327 (Binding to an Unrestricted IP Address) · OWASP A05.

### Internal

- `.env.example` documents the new `BLASTRADIUS_HOST` variable with
  its threat-model note.
- Comment block in `src/server/security.js` updated to match the new
  default (was claiming "0.0.0.0 by default" — now correctly says
  `127.0.0.1`).

### Build / Bundle

- Tauri NSIS + MSI installers regenerated at `1.0.0.6` for the WiX
  bundle version.

---

## [1.0.0-rc5] — 2026-05-26

### Added

- **Stdio MCP shim** (`bin/blastradius-mcp.cjs` + `bin/blastradius-mcp.mjs`).
  A thin bidirectional bridge that speaks the stdio JSON-RPC
  transport on one side and the dashboard's HTTP MCP endpoint on
  the other. Required for Claude Desktop (its config validator
  silently drops `type: http` entries) and useful for any other
  client that only supports stdio. The `.cjs` wrapper exists
  because Claude Desktop's validator additionally filters out any
  `args` entry pointing at a `.mjs` file. Includes drain-on-stdin-
  close, defensive error envelopes for unreachable upstreams or
  garbage Content-Types, and `MCP_DEBUG=1` toggle.

- **`install-hook.ps1 -RegisterDesktop`**. New flag that installs
  the stdio shim into Claude Desktop's config at
  `%APPDATA%\Claude\claude_desktop_config.json`. Two empirical
  workarounds documented inline in the function synopsis and
  applied automatically:
  (1) the server is registered under the rename
  `blastradius-observability` because Claude Desktop maintains an
  in-process persistent rejection blocklist by server name —
  once "blastradius" is rejected, it stays banned;
  (2) the args entry references the `.cjs` wrapper to escape the
  `.mjs` validator filter.
  Independent of `-Agent` — works alongside `-Agent claude`,
  `-Agent antigravity`, or `-Agent both`.

- **MCP request counter** (`src/mcp/stats.js` + `GET /api/mcp/stats`
  + SSE event `mcp-stats-update`). Live in-memory counter that
  records every MCP request handled since dashboard boot, broken
  down by JSON-RPC method (tools/call, resources/read, other), by
  tool / resource / method name, and by client. Identity for the
  per-client breakdown is resolved from explicit `clientInfo.name`
  when present, with a User-Agent fallback for known vendors
  (claude-ai, claude-code, claude-desktop, antigravity,
  mcp-sdk-client, node-client, manual-cli); unrecognized UAs
  collapse into a single `"unknown"` bucket — deliberate privacy
  choice that also bounds the per-client Map size. The flush
  callback is SSE-debounced server-side to ≤ 2 events per second
  so chatty agents cannot saturate the broadcaster.

- **In-app Help modal** (header `?` button or `Ctrl+/`).
  Full-screen overlay with four tabs in high-level English:
  Setup (copy-paste commands for Claude Code, Claude Desktop,
  Antigravity 2.0, custom Anthropic SDK), Tools & Resources (the
  full surface plus the stable NO-DATA reason-code catalog),
  Sample Prompts (six bootstrap / query prompts), and
  Troubleshooting (the four Claude Desktop quirks discovered
  empirically). Every code block has a hover Copy button with
  Clipboard-API + textarea fallback.

- **Collapsible MCP usage panel** in the iteration panel. Shows
  total requests, per-method split, time since last request, and a
  cross-tab byName × byClient breakdown. Empty state links straight
  to the Help modal. Updates live via the existing SSE channel —
  no second EventSource opened.

### Fixed (security and correctness audit before release)

- **MCP queries from different agents were silently mixed in the
  counter.** The MCP spec only carries `clientInfo.name` on the
  `initialize` call, so every subsequent `tools/call` and
  `resources/read` arrived without a session identity. The dashboard
  was showing handshake counts as "client activity" while the
  actual workload was unattributable.
  Fix: pass the HTTP User-Agent into recordCall and normalize known
  fingerprints; every request now attributes to its originating
  agent. New cross-tab `byClientByName` answers "how many times did
  claude-ai vs antigravity call get_iteration_summary?".

- **`byName` / `byClient` could grow unbounded under hostile input.**
  A client sending `tools/call` with unique random names within the
  rate limit would inflate Map memory ~5 MB/hour. Cap added at
  `MAX_DISTINCT_KEYS = 200` with a secondary
  `MAX_COUNT_PER_KEY = 1B` for integer-drift safety. Dropped keys
  surface via `droppedKeys` in `/api/mcp/stats` and a red banner in
  the dashboard panel — the breakdown is never silently truncated.

- **Defensive number coercion in the panel render**: `row.count` is
  wrapped in `Number()` before HTML interpolation. Combined with the
  existing `escapeHtml` on every text field, the panel cannot be
  tricked into rendering hostile HTML even via a contrived server
  snapshot.

### Internal

- 8 new vitest cases for the attribution + caps invariants
  (`tests/mcp/stats.test.js` grows from 12 → 20 cases).
- 5 new vitest cases for the stdio shim
  (`tests/mcp/stdio-shim.test.js`): handshake, multi-line ordering,
  drain-on-stdin-close, upstream unreachable, garbage Content-Type.
- 2 new PowerShell scenarios (8 assertions) for `-RegisterDesktop`
  in `tests/install-hook/register-mcp.test.ps1` — total 27 passing
  assertions in the installer suite.
- Full suite: 329 vitest cases green (no regressions from rc4).
- SPA fallback regex untouched (still excludes `/api/` and `/mcp(/...)?`
  prefixes).

### Build / Bundle

- Tauri NSIS + MSI installers regenerated at `1.0.0.5` for the WiX
  bundle version. New entries added to the `resources` glob so the
  stdio shim and installer scripts ship inside the installer
  payload: `../bin/blastradius-mcp.{mjs,cjs}`,
  `../scripts/install-hook.ps1`, `../scripts/register-mcp.mjs`.

---

## [1.0.0-rc4] — 2026-05-26

### Added

- **`install-hook.ps1 -RegisterMcp` flag.** The hook installer now
  registers BlastRadius as an MCP server in the matching agent's
  global config in the same idempotent pass that installs the touch
  hook. With `-Agent claude`, writes to
  `%USERPROFILE%\.claude.json` (`mcpServers.blastradius` with
  `type: http`, `url: <McpUrl>`); with `-Agent antigravity`, writes
  to `%USERPROFILE%\.gemini\config\mcp_config.json` (using
  `serverUrl`, the field Antigravity expects — not `url`). With
  `-Agent both`, both files are updated. The override
  `-McpUrl http://localhost:<port>/mcp` covers non-default ports.
  See `docs/mcp.md` for the full contract and
  `tests/install-hook/register-mcp.test.ps1` for the 6-scenario
  test suite.

- **`scripts/register-mcp.mjs`.** Node-based MCP config merger
  invoked by the installer. Reads the entry JSON from stdin (Windows
  arg quoting otherwise strips inner double-quotes), preserves
  every other top-level key and every other server already
  registered, writes a timestamped `.bak.<TIMESTAMP>` before
  destructive changes, and emits `JSON.stringify(obj, null, 2)` so
  the file's existing 2-space indentation is preserved. Refuses to
  overwrite a malformed JSON file (surfaces the parse error so the
  user can fix it before retrying).

### Fixed

- **Installer no longer corrupts the user's existing `.claude.json`
  formatting.** The original PowerShell-based merge used
  `ConvertTo-Json`, which on Windows PowerShell 5.1 emits a
  vertical-alignment indent that triples the file size and destroys
  the native 2-space-indented JSON. The Node-based merger
  introduced in this release writes a normal 2-space-indented JSON
  matching what Claude Code and Antigravity emit themselves.

- **Installer uses `$env:USERPROFILE` instead of the automatic
  `$HOME` variable** when resolving the config file path. The
  automatic `$HOME` is bound once at PowerShell startup and ignores
  in-process `$env:HOME` overrides, which made the
  `Register-ClaudeMcp` / `Register-AntigravityMcp` functions
  impossible to test inside a temporary sandbox without
  contaminating the real user config.

### Internal

- Added `tests/install-hook/register-mcp.test.ps1` — 6 scenarios,
  18 assertions, all in pure PowerShell (no Pester dependency).
  Each scenario runs the installer in-process against a freshly
  created temp directory and asserts: file creation, idempotency
  (no rewrite + no backup on no-op), merge preservation of unrelated
  top-level keys and other servers, the `serverUrl`-vs-`url`
  difference between Antigravity and Claude, custom `-McpUrl`
  passing through, and `-Agent both` writing to both configs.

### Build / Bundle

- Tauri NSIS + MSI installers regenerated at `1.0.0.4` for the WiX
  bundle version.

---

## [1.0.0-rc3] — 2026-05-26

### Added

- **MCP server (read-only, Phase 1).** BlastRadius now exposes a
  Model Context Protocol server at `http://localhost:7842/mcp`,
  embedded in the same Tauri/Express process as the dashboard. AI
  agents (Claude Code, Antigravity 2.0, any Anthropic SDK client)
  can call read-only tools and resources to consult the current
  iteration, summarize recent progress, list iteration windows, and
  fetch validated git diffs — without compromising the existing
  HTTP `/api/*` surface. See [`docs/mcp.md`](docs/mcp.md) for the
  full protocol contract, NO-DATA shape, and client setup commands.
  Tools: `get_iteration_summary`, `summarize_progress`,
  `list_recent_iterations`, `get_file_diff`. Resources:
  `blastradius://health`, `iteration/current`, `repo/active`,
  `repos`, `events/recent`, `heat/{window}`. Dedicated token-bucket
  rate limiter (100 burst, 30/sec sustained) sized for agent
  polling traffic. Path validation reused verbatim from `/api/diff`
  — single source of truth.

### Changed

- **Heat color scheme: orange → green for read-only files.** The
  semaphore now reads cleanly as red (edited) / yellow (propagated) /
  green (read). The previous orange tone was visually
  indistinguishable from yellow on the dark theme, blurring the line
  between "read" and "propagated". Renamed across the data model
  (`heatEngine.js`, `routes.js`), the frontend (`app.js`,
  `index.html`, `styles.css`), tests, and docs. The new CSS variable
  is `--heat-green: #52b788`. **Breaking** for any external
  consumer reading raw color strings from `/api/heat` or
  `/api/iteration/summary` (`metrics.orange` → `metrics.green`,
  `files[path] === 'orange'` → `'green'`). The MCP surface launches
  with the new shape from day one — no migration debt.

### Internal

- Bumped `@modelcontextprotocol/sdk` to `^1.29.0` and `zod` to
  `^4.4.3` as direct dependencies.
- Added 17 new vitest cases under `tests/mcp/`: 16 end-to-end
  handshake / discovery / NO-DATA contract / happy-path tests
  through `InMemoryTransport.createLinkedPair()`, plus a rate-limit
  burst test against a real Express mount.
- SPA fallback regex now excludes both `/api/` and `/mcp(/...)?`
  prefixes so misrouted MCP calls return router-level errors
  instead of an HTML payload.

### Build / Bundle

- Tauri NSIS + MSI installers regenerated at `1.0.0.3` for the WiX
  bundle version. The existing `resources` glob in
  `src-tauri/tauri.conf.json` already covers the new `src/mcp/**`
  module and the SDK's `node_modules/@modelcontextprotocol/**`
  payload — **no installer config changes were required**.

---

## [1.0.0-rc2] — earlier

- Antigravity hook integration finalized; installer script
  (`scripts/install-hook.ps1`) supports `-Agent claude|antigravity|both`.
- NSIS + MSI installer regeneration baseline.

(For older history, see `git log` — the CHANGELOG was introduced at rc3.)
