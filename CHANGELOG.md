# Changelog

All notable changes to BlastRadius are documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/) and
this project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0-rc9.22] — 2026-05-31 — Multi-language graph: Rust support

### Added

- **The import graph now understands Rust**, joining JS/TS, Python and Go — the
  four most common AI-agent languages. A Cargo crate (`Cargo.toml`) gets the
  full graph: D3 view, reverse-import blast-radius propagation, orphans, cycles,
  `fanIn`/`fanOut`. New `resolvers/rust.js` is a **zero-dependency** scanner that
  models Rust's module TREE (the subtlest of the four):
  - Indexes each `.rs` file to its module path via Rust conventions
    (`lib.rs`/`main.rs` → crate root, `foo.rs` and `foo/mod.rs` → module `foo`,
    `a/b.rs` → `a::b`), relative to the nearest crate-root dir.
  - Edges from `mod NAME;` declarations (the structural module tree — inline
    `mod NAME { … }` is ignored) **and** from `use crate::… / self::… / super::…`
    paths resolved against the index (dropping trailing item segments;
    `use crate::Foo` → the crate-root file).
  - std/core and external crates (bare `use serde::…`) are ignored — the Rust
    analogue of `node_modules`. Skips `target/`.

### Changed

- `detectLanguage` / `detectLanguages` recognise `Cargo.toml` → `rust`
  (priority: jsts → go → rust → python). `.rs` joins the source extensions that
  trigger a graph rebuild. JS/TS, Python and Go paths are unaffected; a Rust
  repo just adds a new resolver behind the same `{ forward, reverse }` contract,
  and mixed repos union it in.

### Notes / limits (honest scope)

- Does not evaluate `#[path = "…"]`, `#[cfg(...)]`-gated modules, macro-generated
  modules, glob re-exports, or Cargo **workspace** cross-crate edges. Good
  enough for blast-radius impact.

### Tests

- New `resolver-rust.test.js` (12): fixture crate covering `mod` child
  declarations, `use crate::`/`super::` resolution, item-path trimming,
  std/external ignored, reverse BFS, and the parser units
  (`extractModDecls`, `extractUseClauses`, `expandUse`).

### Build / Bundle

- Installers at WiX bundle version `1.0.0.37` (rc9.21 was `.36`).

### Commits

- feat(graph): add a zero-dependency Rust resolver (module tree: mod decls +
  crate/self/super use paths); JS/TS + Python + Go paths unchanged

---

## [1.0.0-rc9.21] — 2026-05-31 — Consistent agent attribution in summarize_progress + describe_node

### Fixed

- **`summarize_progress` and `describe_node` now attribute the agent the same
  way `get_iteration_summary` does.** Both read the raw `ev.agent` field, which
  the Claude Code PostToolUse hook does NOT stamp — so per-file `agents` came
  back empty (`[]`) and `describe_node`'s `lastAgent` was `null`, even though
  `get_iteration_summary` correctly showed "claude". Both now run events through
  the shared, pure `inferAgent()` cascade (explicit agent → legacy
  antigravity-session → manual → default "claude"), so a Claude-hook event with
  no `agent` field resolves to "claude" and an explicit `agent` is preserved.
  Pure aggregation/attribution change — the event counts were already correct;
  this only fills in the agent labels.

### Tests

- New `summarize-progress-range.test.js` Case D: a real Claude-hook event (has
  `sessionId`, no `agent`) is attributed to "claude"; an explicit
  `agent: "antigravity"` is preserved. (Also documents that an event with
  neither `agent` nor `sessionId` is "manual" — scripted seeding.)

### Build / Bundle

- Installers at WiX bundle version `1.0.0.36` (rc9.20 was `.35`).

### Commits

- fix(mcp): attribute agents via the shared inferAgent cascade in
  summarize_progress + describe_node (was empty for no-`agent` Claude events)

---

## [1.0.0-rc9.20] — 2026-05-31 — System dashboard: BlastRadius observes itself

### Added — meta-observability panel (⌥S)

- **BlastRadius now monitors its own runtime**, on a channel completely isolated
  from the repos' event capture. A new toggled panel (the **⌥S** header button
  or **Alt+S**) shows three professional panes:
  - **Health** (left): uptime, memory (RSS / heap), Node version, PID, and the
    **MCP rate-limiter (token-bucket) state** — tokens left, capacity, refill.
  - **Console** (center): a dark, structured-log console that parses Pino JSON
    and **colours each line by level** (error = red, warn = amber, info = blue),
    with a **component / text filter**, level filters, follow-tail and clear.
    Each line shows its context tail (e.g. the `err` / EPERM detail behind a
    warning) and a **local** wall-clock timestamp that matches the machine.
  - **MCP requests** (right): live per-tool request counts.
  - **Optional full screen** (⤢, like the AI/commits panels) — the preference
    persists — so the three panes aren't cramped on a small window.

### Backend (isolated, zero latency impact)

- `src/server/logger.js` (new): the logger now fans out via `pino.multistream`
  to stdout **and** an **async** `~/.blastradius/system.log`
  (`sync: false` → never blocks the request path or the hook's <100 ms budget),
  plus an in-process live tap that streams entries to the dashboard.
- `src/server/routes/system.js` (new, isolated): `GET /api/system/logs`
  (tails the structured file, **skips malformed lines** with a throttled
  warning, ring-buffer fallback) and `GET /api/system/health`
  (memory, uptime, MCP stats, rate-limiter snapshot). Realtime tailing rides
  the existing `/api/events` SSE as a dedicated `system-log` event — no second
  EventSource.
- The MCP rate limiter gained a read-only `.snapshot()` for the health panel.

### Isolation guarantees (no impact on capture)

- The system-log pipeline never imports or touches `eventStore.js`, the
  JSONL capture path, the polyglot resolvers, or the atomic-write stores. Only
  `~/.blastradius/` is written. A throwing SSE consumer can never break logging.

### Tests

- `tests/system-observability.test.js` (8): live tap (ring + broadcaster,
  throwing-consumer safety), `/api/system/logs` fuzzing (skips garbage with a
  throttled warn) + ring fallback + limit cap, `/api/system/health` shape +
  never-500 resilience, and an **isolation/stress** test — a burst of system
  logs while an EventStore tails its own file captures every event with zero
  loss and never creates a session file.
- `tests/e2e/system-dashboard.spec.js` (5): renders all three panes, colours by
  level, streams a live SSE entry, filters by level + text, and Alt+S / Escape.

### Build / Bundle

- Installers at WiX bundle version `1.0.0.35` (rc9.19 was `.34`). Also ships the
  rc9.20-committed "About & Support" Help tab.

### Commits

- feat(system): meta-observability dashboard — multistream system log +
  /api/system/{logs,health} + isolated dark console panel (⌥S)

---

## [1.0.0-rc9.19] — 2026-05-31 — Assisted onboarding via MCP: get_setup_status + install_hook

### Added

- **Claude Code can now set BlastRadius up for you — end to end.** Two new MCP
  tools let the agent close the onboarding loop without any copy-paste:
  - **`get_setup_status`** (read-only): reports whether the BlastRadius hook is
    installed and correct for the active repo, the `settings.json` path, and
    where the hook writes its logs vs where the dashboard reads.
  - **`install_hook`** (consent-gated mutation): installs / repairs the
    PostToolUse hook in the active repo's `.claude/settings.json`. Idempotent
    (`created`/`updated`/`noop`), preserves any other hooks, backs up an
    existing settings file.
  - The user can simply tell Claude Code *"set up BlastRadius"* and the agent
    calls `get_setup_status` → `install_hook`. Complements the rc9.14 dashboard
    button + the rc9.13 self-diagnostics banner (the human-facing paths).

### Security

- **`install_hook` enforces the same load-bearing invariant as the HTTP route:**
  it only ever writes inside a repo under `preferences.parentDir`. A repo
  outside the declared workspace is refused with `repo_outside_parent_dir` and
  nothing is written (the `isInside` gate is mirrored from routes.js).
- Mutation hints (`readOnlyHint:false` + `destructiveHint:false`) mark it so
  MCP clients prompt for consent, exactly like `set_node_summary`.

### Isolation (no impact on existing behavior)

- Reuses the existing `hookInstaller.js` (`getHookStatus` / `installHook`); no
  changes to `eventStore.js`, the resolvers, atomic writes, or the hook's
  capture path. Reads stay side-effect-free.

### Tests

- New `tests/mcp/setup-tools.test.js` (5) via InMemoryTransport: status before
  vs after install, install writes the entry + is idempotent (`noop`), the
  parentDir security gate (refuses + writes nothing), and the no-active-repo
  NO-DATA path. `server.test.js` tool-list + the Help-modal catalog-sync e2e
  updated for the two new tools.

### Build / Bundle

- Installers at WiX bundle version `1.0.0.34` (rc9.18 was `.33`).

### Commits

- feat(mcp): add get_setup_status + consent-gated install_hook so Claude Code
  can set up / repair the BlastRadius hook itself (parentDir-gated)

---

## [1.0.0-rc9.18] — 2026-05-31 — Mixed-repo graph union (monorepos)

### Added

- **Monorepos with more than one language now get the UNION of all their
  language graphs**, not just the primary one. A repo that has, say, a Go
  backend (`go.mod`) and a Python service (`pyproject.toml`) — or a JS frontend
  plus a backend — now shows both subgraphs together: D3 view, reverse-import
  propagation, orphans, cycles and `fanIn`/`fanOut` span every language present.
  - New `detectLanguages()` lists every language with a marker (deterministic
    order: jsts → go → python). `build()` runs each resolver and merges the
    results. Because each resolver only emits keys for its own file extensions
    (`.js/.ts` vs `.py` vs `.go`), the maps are disjoint and the union is
    conflict-free — there are never cross-language edges.
  - The graph's `stats.language` becomes a joined label, e.g. `go+python`.

### Changed (safety / behavior-preserving)

- **Single-language repos are completely unaffected.** When only one marker is
  present, `build()` takes the exact same single-resolver path as before —
  verified by the full graph + Python + Go suites passing unchanged. The union
  only activates for repos with two or more language markers.
- Mixed resolvers run **sequentially**, not in parallel, because the JS/TS
  resolver briefly `process.chdir()`s (process-global) and overlapping it could
  race on the working directory. Each resolver keeps its own hard timeout.
- `detectLanguage()` (singular) is retained unchanged for back-compat (returns
  the one primary language).

### Notes / limits

- Per-language resolution rules are unchanged; this release only composes them.
  Cross-language edges (e.g. a Python service shelling out to a Go binary) are
  out of scope by design — those aren't import edges.

### Tests

- New `resolver-mixed.test.js` (8): a Go+Python fixture proves both subgraphs
  coexist in one graph, with no cross-language edges, correct module count, and
  per-language BFS; plus `detectLanguages` unit cases (multi-marker, fallback,
  and singular back-compat).

### Build / Bundle

- Installers at WiX bundle version `1.0.0.33` (rc9.17 was `.32`).

### Commits

- feat(graph): union the graphs of every language in a mixed repo (monorepos);
  single-language repos take the unchanged fast path

---

## [1.0.0-rc9.17] — 2026-05-31 — Multi-language graph: Go support

### Added

- **The import graph now understands Go**, joining JS/TS and Python. A Go module
  (`go.mod`) gets the full graph experience — D3 graph view, reverse-import
  **blast-radius propagation**, orphans, cycles, and `fanIn`/`fanOut` — exactly
  like the other languages. New `resolvers/go.js` is a **zero-dependency**
  scanner:
  - Reads the module path from `go.mod` (`module github.com/foo/bar`) and treats
    any import starting with it as internal; stdlib (`fmt`) and third-party
    (`github.com/other/x`) imports are ignored.
  - Go imports name **packages** (directories), so each internal import is
    expanded to **every `.go` file in that package's directory** — the right
    granularity for blast radius (touching any file in an imported package can
    affect its importers), and consistent with BlastRadius's file-keyed graph.
  - Skips `vendor/`, VCS/tool dirs, and Go-ignored `_`/`.`-prefixed dirs;
    bounded by a file cap + per-file size cap; runs under the same execution
    timeout as the other resolvers.

### Changed

- `detectLanguage()` now recognises `go.mod` → `go`. Priority order:
  JS/TS (`package.json`/`tsconfig`) → Go (`go.mod`) → Python (manifest) →
  fallback JS/TS. Existing JS/TS and Python repos are unaffected.
- `.go` joins the source extensions that trigger a graph rebuild on edit.

### Notes / limits (honest scope)

- Does not model implicit intra-package coupling (files in the same package
  that call each other without an import), build tags, or `replace` directives.
- One primary language per repo (mixed-repo graph union remains a future item).

### Tests

- New `resolver-go.test.js` (12): fixture Go module covering block + single +
  aliased imports, package→files expansion, stdlib/third-party ignored, reverse
  map, transitive BFS, no self-edges, and the parser unit (`go.mod` module path,
  `dirOf`).

### Build / Bundle

- Installers at WiX bundle version `1.0.0.32` (rc9.16 was `.31`).

### Commits

- feat(graph): add a zero-dependency Go resolver (package imports expanded to
  files); JS/TS + Python paths unchanged

---

## [1.0.0-rc9.16] — 2026-05-31 — Multi-language graph: Python support (pluggable resolvers)

### Added

- **The import graph now understands Python**, not just JS/TS. A Python repo
  (`pyproject.toml` / `requirements.txt` / `setup.py` / `Pipfile`) gets a full
  dependency graph — D3 graph view, reverse-import **blast-radius propagation**
  (the yellow ring), orphans, cycles, and `fanIn`/`fanOut` in `describe_node` —
  exactly like a JS/TS repo. The new `resolvers/python.js` is a **zero-dependency**
  scanner: it indexes the repo's own modules and resolves `import` /
  `from … import` (absolute **and** relative) to repo files; stdlib and pip
  imports are ignored (the Python analogue of `node_modules`).
- Everything else was already language-agnostic (heat-map, diffs, commits,
  AI assistant), so a Python project now lights up end-to-end.

### Changed (architecture, behavior-preserving for JS/TS)

- `graphResolver.build()` is now a **language dispatcher**: it detects the
  repo's primary language and delegates to a per-language resolver, all sharing
  the SAME `{ forward, reverse, stats }` contract. The JS/TS path (dependency-
  cruiser) is unchanged and takes priority on any repo with a
  `package.json` / `tsconfig.json` — so existing JS/TS graphs are byte-for-byte
  identical (verified by the existing graph + propagation suites).
- `.py` joins the source extensions that trigger a graph rebuild on edit.
- The Python resolver is bounded (file cap + per-file size cap) and runs under
  the same hard execution timeout as the JS path.

### Notes / limits (honest scope)

- Detection picks ONE primary language per repo (JS/TS wins when both markers
  exist). Mixed-repo graph union is a future enhancement — the abstract maps
  make it trivial to add later.
- The scanner is "good enough for blast-radius": it does not chase dynamic
  imports (`importlib`) or namespace packages without `__init__.py`.

### Tests

- New `resolver-python.test.js` (14): fixture package tree in a tmpdir covering
  absolute + relative (parent/sibling) imports, stdlib ignored, reverse map,
  transitive BFS, and the import-parser unit (aliases, multi-line parentheses,
  relative dots, module/package path mapping).

### Build / Bundle

- Installers at WiX bundle version `1.0.0.31` (rc9.15 was `.30`).

### Commits

- feat(graph): multi-language import graph via pluggable resolvers; add a
  zero-dependency Python resolver (JS/TS path unchanged)

---

## [1.0.0-rc9.15] — 2026-05-31 — Core hardening: agent-immune capture, timeouts, resilience tests

### Fixed

- **No event is ever lost when the hook writes a line in pieces.** The live
  tailer advanced its read offset to the end of the file even when the last
  bytes were a half-written line (an append still in flight). When the line
  completed, the next read started mid-line and the event was silently dropped.
  `tail()` now consumes only up to the last complete newline and leaves any
  trailing partial bytes pending for the next read — never split, never lost,
  never duplicated, regardless of how the agent or the OS chunks its writes.

### Changed / Hardened

- **Execution timeouts on every system operation** so a pathological or
  gigantic repo can't freeze the dashboard:
  - **git** (diffs) runs through simple-git with a hard `timeout.block` of 10s;
    a stuck git child is killed and the diff degrades to a friendly empty
    result while the tree keeps rendering.
  - **dependency-cruiser** (graph build) is raced against a 30s ceiling; on
    timeout the rebuild is abandoned and the dashboard keeps the last-known
    graph instead of hanging.
- **Corrupt-line warning.** The event store already skipped malformed JSONL
  lines; it now also emits a **throttled** `warn` (first occurrence, then every
  100) so a misbehaving agent's garbage output is observable without flooding
  the log or stalling the SSE stream.

### Tests

- New `eventStore-resilience.test.js`: **fuzzing-light** (random strings +
  malformed JSON never throw, never call `process.exit`, valid events intact)
  and **extreme concurrency** (100 events arriving in tiny interleaved chunks
  are captured exactly once — no loss, no duplicates). The concurrency test is
  the bug-bites-back driver for the `tail()` fix.
- New `exec-timeout.test.js` pins the timeout primitive (fast resolves, slow
  rejects with a typed `timeout` error, timer always cleared).

### Already solid (verified, untouched)

- Atomic writes (`preferences.json`, `knowledge.json`) via tmp + rename; the
  Claude Code hook's ≤95ms fail-safe firewall with `exit 0`; read-only access
  to observed repos (only `~/.blastradius/` is ever written).

### Build / Bundle

- Installers at WiX bundle version `1.0.0.30` (rc9.14 was `.29`).

### Commits

- fix(eventStore): never drop an event whose JSONL line is appended across a
  tail() boundary; warn (throttled) on corrupt lines
- perf(server): hard execution timeouts for git diffs and the graph build so a
  giant repo can't freeze the dashboard

---

## [1.0.0-rc9.14] — 2026-05-30 — Assisted onboarding: "Copy prompt for Claude Code"

### Added

- **"Copy prompt for Claude Code" — let your AI assistant install/repair the
  hook.** A non-technical Claude Code user doesn't need to know what a hook is
  or where `.claude/settings.json` lives. When BlastRadius detects a missing or
  misconfigured hook, both the install modal and the self-diagnostics banner
  now offer a **Copy prompt for Claude Code** button. It puts a precise,
  ready-to-paste instruction on the clipboard — the user pastes it into Claude
  Code, and Claude Code performs the install/repair (handling path quirks,
  PowerShell execution policy, and the `settings.json` merge the in-app
  installer can't always do).
  - The prompt is generated by the server for the user's exact machine: it
    embeds the real `settings.json` path, the canonical hook entry, and the log
    directory. Three scenarios are worded appropriately: fresh **install**,
    **reinstall** (out-of-date / wrong log folder), and **repair** of a corrupt
    settings file.
  - **Privacy / safety:** the prompt carries only paths and the hook entry
    BlastRadius would write itself — never the contents of any user file
    (zero-data-retention). It instructs Claude Code to run only the bundled
    installer or make a declarative `settings.json` edit — never to download
    and run anything. It is copied on an explicit click; nothing executes.
  - New `GET /api/repo/hook-status` and `GET /api/diagnostics` responses carry
    a `claudePrompt` field for actionable cases; a new pure `repairPrompt.js`
    module builds it (unit-tested, including a no-leak assertion).

### Build / Bundle

- Installers at WiX bundle version `1.0.0.29` (rc9.13 was `.28`).

### Commits

- feat(onboarding): "Copy prompt for Claude Code" to install/repair the hook
  from the install modal and the diagnostics banner

---

## [1.0.0-rc9.13] — 2026-05-30 — Timezone-proof day boundary + self-diagnostics banner

### Fixed

- **A clock or timezone change no longer empties the dashboard.** The daily log
  file (`session-YYYY-MM-DD.jsonl`) and the server's "which day is this?"
  logic both derived the date from the machine's **local** time, but every
  event timestamp is written in **UTC** (`toISOString()`). When the PC's clock
  or timezone moved (travel, DST, a manual time correction), "today" could
  shift to a different file than the one events were being appended to — so the
  iterations/heat view looked empty even though logging was working.
  - **The day key is now derived in UTC everywhere.** `dayKey` (the hook +
    server filename) and the event-store range helpers (`dateKey`,
    `toUtcDayStart`, `enumerateDays`) all use `getUTC*`, so the day boundary is
    independent of the machine's timezone and the filename always agrees with
    the UTC timestamps it contains. The midnight boundary is now stable no
    matter what the local clock says.

### Added

- **Self-diagnostics banner.** BlastRadius now actively detects the class of
  **silent misconfiguration** that caused the rc9.12 "empty dashboard" bug and
  surfaces it as a visible, one-click-fixable banner instead of failing
  quietly. A new `GET /api/diagnostics` endpoint compares where the installed
  hook *writes* its logs against where the server *reads* them; if they differ,
  the dashboard shows **"BlastRadius isn't seeing your activity in this repo"**
  with the exact paths and a **Reinstall hook** button that repoints the hook
  in place. Dismissible, and re-checked automatically when the active repo
  changes. A drifted-but-correct hook command is reported as a quieter info
  note; corrupt `settings.json` is flagged as a warning.

### Build / Bundle

- Installers at WiX bundle version `1.0.0.28` (rc9.12 was `.27`).

### Commits

- fix(time): derive the daily log-file day key in UTC so a clock/timezone
  change can't desync the filename from its UTC timestamps
- feat(diagnostics): add /api/diagnostics + dashboard banner that surfaces a
  hook/server log-dir mismatch with a one-click reinstall fix

---

## [1.0.0-rc9.12] — 2026-05-30 — Fix: hook and server now share one log dir

### Fixed

- **Iterations/heat went empty after a repo switch or relaunch.** The hook
  and the server were reading/writing **different** log folders, so events
  were captured but never shown. Root cause: `install-hook.ps1` defaulted the
  hook's `--log-dir` to `<repo>/logs`, while the server's `resolve_log_dir()`
  only used `<currentRepo>/logs` when that repo happened to be active **at
  boot** — after an auto-switch (or when the boot repo had no `logs/`) the
  server fell back to `~/.blastradius/logs` and the two diverged → the
  dashboard stayed at 0 events.
  - **Both now standardise on `~/.blastradius/logs`** — one stable per-user
    location, independent of which repo is active. `install-hook.ps1`'s
    default `-LogDir` is now `~/.blastradius/logs`, and the server resolves
    there directly (the fragile boot-time `<repo>/logs` heuristic — and its
    `parse_current_repo` helper — are gone). `BLASTRADIUS_LOG_DIR` still
    overrides for dev. The dashboard's auto-installer already used the
    server's log dir, so it was unaffected.

### Upgrade note

- If your hook was installed pointing at `<repo>/logs` (the old default),
  re-run `install-hook.ps1` (or use the dashboard's "Install hook" banner) so
  it writes to `~/.blastradius/logs`. Existing `<repo>/logs/*.jsonl` files can
  be copied into `~/.blastradius/logs/` to bring past history forward.

### Build / Bundle

- Installers at WiX bundle version `1.0.0.27` (rc9.11 was `.26`).

### Commits

- fix(hook): standardise hook + server on ~/.blastradius/logs (was a split
  that left the dashboard empty after a repo switch)

---

## [1.0.0-rc9.11] — 2026-05-29 — Commit investigation panel

### Added

- **Commit investigation panel** (the **⎇** button in the top bar). Browse
  recent commits and the files each one touched, then **click any file to
  open its diff pinned to that commit** — git archaeology without dropping to
  a terminal. A professional two-pane modal: commits on the left, the
  selected commit's files (with A/M/D/R status) on the right, with an
  optional **full-screen** toggle (⤢) just like the AI panel.
  - The per-file diff shows **what that commit changed** (`<sha>^..<sha>`, the
    root commit vs git's empty tree) — a new `getCommitDiff()` + `commit=`
    query param, *not* the old `against=<sha>` (which is `<sha>`..working-tree
    and would render empty when the file is unchanged since). Source pill
    reads "commit `<sha>`".
  - The drilled-in diff modal **stacks above** the commits modal (z-index),
    and body scroll stays locked while it's open over the panel.
  - Read-only git: `GET /api/commits` (recent commits, capped at 100) and
    `GET /api/commits/:sha/files` (`git diff-tree --root -M`, validated ref,
    capped at 500 files). Same loopback + rate-limit posture as `/api/diff`.
  - Follows a repo switch (resets + reloads); the date-range diff note is
    suppressed for a commit-pinned diff (it's correctly scoped).

### Tests

- `tests/routes-commits.test.js` — **+7** (real temp git repo → DiffProvider →
  route: list newest-first, a commit's files with status, root via `--root`,
  `commit=<sha>` shows `sha^..sha` (not empty), root commit as added,
  malformed ref → 400, no repo → 503).
- `tests/e2e/commits.spec.js` — **+2** Playwright (open → pick commit → files
  → click opens a diff with `commit=<sha>`; no-repo message).
- **578 vitest** (+7), **22 Playwright** (+2). All green.

### Build / Bundle

- Installers at WiX bundle version `1.0.0.26` (rc9.10 was `.25`).

### Commits

- feat(commits): investigation panel — browse commits + files, pinned diffs
- feat(server): GET /api/commits and /api/commits/:sha/files (read-only git)

---

## [1.0.0-rc9.10] — 2026-05-29 — Honest diff scope + version on the splash

### Added

- **Version on the startup splash.** The boot splash now shows the app
  version (e.g. `v1.0.0-rc9.10`), stamped from the crate version at build
  time — so you can tell at a glance which build is launching.
- **Diff-scope note.** When a past **date range** is filtered, the diff modal
  shows a note explaining that the diff is git's *current* state, not scoped
  to that window. (Filters drive the heat map, which is built from the event
  log; the diff comes from git.)
- **Help → Troubleshooting** gains a "Why doesn't the diff change when I
  filter by date?" entry: the heat map is filter-aware (event log), the diff
  is git (current state), and BlastRadius records *when* files were touched —
  not their past *contents* — so a historical diff isn't reconstructable.

### Tests

- `tests/e2e/report-export.spec.js` — fixed a stale assertion: since rc9.4 the
  agent filter is canonicalized to its display label, so the report header
  reads "Agent: Claude" (not the lowercase button value). It had been red
  since rc9.4 because only the AI e2e was being run; the **full** Playwright
  suite is now part of release verification.
- **571 vitest**, **20 Playwright**. All green.

### Build / Bundle

- Installers at WiX bundle version `1.0.0.25` (rc9.9 was `.24`).

### Commits

- feat(ui): show the app version on the startup splash
- feat(ui): note that diffs are git-current, not date-scoped; explain in Help
- test(e2e): fix stale agent-filter label assertion; run the full e2e suite

---

## [1.0.0-rc9.9] — 2026-05-29 — Switching repos no longer needs an app restart + readable file names

Two fixes from real-world use of the AI page.

### Fixed

- **The AI panel now follows a repo switch.** Its heat-map, conversation,
  advice counter, and grounding were cached and never reset when you switched
  the active repo, so they kept showing the *previous* repo — the only way to
  clear them was to close and reopen the whole app. The panel now listens for
  the same `repo-changed` event the dashboard already uses (attaching to the
  shared EventSource): it aborts any in-flight reply, starts a fresh
  conversation, drops the old advice count, and re-fetches the heat map +
  conversation list for the new repo. No restart needed.
- **Full file names in the heat panel.** Long paths were truncated with an
  ellipsis and couldn't be read; they now wrap so the whole name is visible.
  The sidebar is a touch wider (340px) to suit.
- **The diff hover-tooltip no longer escapes the window.** If the tree was
  rebuilt during the 1s hover delay (a heat update or repo switch), the
  hovered row became detached and reported a 0×0 rect — dumping the
  "+N −N · click to open diff" tooltip into the top-left corner, clipped off
  screen. It now bails on a detached row and clamps to the viewport (flipping
  to the row's left edge when it would overflow on the right).

### Tests

- `tests/e2e/ai-assistant.spec.js` — **+1** Playwright (a `repo-changed` event
  clears the transcript and restores the hint without an app restart).
- **571 vitest**, **7 Playwright** (+1). All green.

### Build / Bundle

- Installers at WiX bundle version `1.0.0.24` (rc9.8 was `.23`).

### Commits

- fix(ai): reset the assistant panel when the active repo changes
- fix(ui): wrap long file names in the heat panel instead of truncating

---

## [1.0.0-rc9.8] — 2026-05-29 — AI page honors the dashboard's active filters

Bug fix: the AI assistant's heat-map panel and its grounding ignored the
dashboard filters, so it always showed the full session / all agents — the
files you were actually looking at (and wanted to **Explain**) didn't appear.
Same class of bug rc8.6 fixed for report export, this time in the AI page.

### Fixed

- **The AI heat-map panel now mirrors your active filters** — window, agent,
  and date range. It builds its `/api/heat` URL from the same shared
  `buildHeatUrl()` the dashboard uses, instead of a hardcoded
  `window=session&platform=all`. The files you're viewing now show up in the
  panel and can be **Explain**ed.
- **The assistant is grounded in the same slice.** The chat sends the active
  filters with each turn; the server runs them through the shared
  `parseHeatFilters()` validator and grounds `gatherReportData()` with them.
  An invalid filter never blocks the chat — it falls back to the full session.
- The panel re-fetches on each open (and the ⟳ button refreshes mid-session),
  so it picks up whatever filters are active then.

### Tests

- `tests/routes-ai.test.js` — **+2** (grounding honors a client-sent agent
  filter; an invalid date range falls back to the full session without a 400).
- **571 vitest total** (+2), **6 Playwright**. All green; real-Ollama sanity
  confirms the chat accepts `body.filters`.

### Build / Bundle

- Installers at WiX bundle version `1.0.0.23` (rc9.7 was `.22`).

### Commits

- fix(ai): heat panel + grounding honor the dashboard's active filters
- refactor(server): parseHeatFilters accepts a body source (shared validator)

---

## [1.0.0-rc9.7] — 2026-05-29 — AI replies render as Markdown (tables, lists, code)

The assistant's answers now read like documentation, not a wall of text.
Still zero new dependencies — a ~180-line vanilla renderer, no `marked` /
`markdown-it` / `showdown`.

### Added

- **Markdown rendering in the chat.** Assistant replies render **tables**
  (with column alignment), **bullet/numbered lists**, **fenced code blocks**,
  inline `code`, **bold**, headings, and proper **paragraphs / line breaks**
  — so structured answers stop collapsing into one run-on line. New module
  `src/public/markdown.js`, imported by the dashboard.

### Security

- **Escape-first, always.** The renderer HTML-escapes every piece of model
  text *before* any structural pass, and only ever emits its own fixed tag
  set. A `<script>` / `onerror=` in a reply can never reach `innerHTML` as
  live markup. Fenced code and table cells are escaped too. User turns stay
  literal `textContent`. **Copy** still copies the RAW Markdown, not the
  rendered HTML.
- Linear-time, non-backtracking regexes — a huge (8k-token) reply can't
  freeze the WebView.

### Tests

- `tests/markdown.test.js` — **+17** (XSS defense, tables + alignment +
  ragged rows, lists, headings, paragraph/line-break handling, bold/inline
  code, code-block preservation, large-input perf).
- `tests/e2e/ai-assistant.spec.js` — **+1** Playwright (a table reply renders
  a real `<table>` + `<pre>` in the bubble; Copy still grabs raw Markdown).
- **569 vitest total** (+17), **6 Playwright** (+1). All green.

### Build / Bundle

- Installers at WiX bundle version `1.0.0.22` (rc9.6 was `.21`).

### Commits

- feat(ui): render assistant Markdown — tables, lists, code, paragraphs
- feat(ui): dependency-free, escape-first Markdown renderer (markdown.js)

---

## [1.0.0-rc9.6] — 2026-05-29 — AI learns from diffs + honest session metrics

The assistant becomes a teacher. Still zero new dependencies, still 100%
local (Ollama on `127.0.0.1:11434`).

### Added

- **Explain a change.** Edited (red) files in the full-screen heat-map panel
  now have an **Explain** button. Click it and the assistant receives that
  file's real git diff and explains **what changed and why, in plain terms,
  so you learn** — flagging anything risky. The diff is attached server-side
  (via the diff provider that already powers the diff modal), so it never
  bloats the transcript or the persisted history; the visible turn stays a
  short question. Large diffs are capped so they can't overflow the context.
- **Session timeline in grounding.** The assistant now knows when the
  session **started** (first tracked event) and the most recent activity, so
  it can answer "when did I start / what's the latest?".
- **Effort by agent.** Per-agent action counts (Edit/Read/Write) are fed to
  the assistant as an honest proxy for "how much did the agent do" — Claude
  vs Antigravity vs Manual.
- **Honest token usage.** The local assistant's own estimated token spend is
  accumulated per project and surfaced to the model — **clearly labeled as
  the assistant's tokens, not the coding agent's**. BlastRadius does not
  capture the coding agent's token usage, so the model is explicitly told
  not to invent a number for it.

### Changed

- `DiffProvider.getDiff()` now also returns the raw unified `patch` (used
  in-process by the explain flow). The `/api/diff` HTTP response strips it,
  so the diff-modal payload is unchanged.

### Tests

- `tests/ai/context.test.js` — +1 (session start, per-agent effort, honest
  assistant-usage disclaimer).
- `tests/ai/conversationStore.test.js` — +1 (per-project token accumulation;
  `usage()`; missing-tokens back-compat).
- `tests/routes-ai.test.js` — +2 (diff attached to the system message, not
  the transcript; graceful no-diff fallthrough).
- **556 vitest total** (+4). Verified end-to-end against **real Ollama**: a
  real git diff is attached and the model explains the new function (6/6).

### Build / Bundle

- Installers at WiX bundle version `1.0.0.21` (rc9.5 was `.20`).

### Commits

- feat(ai): explain a file's diff to teach the user what changed and why
- feat(ai): feed session timeline + per-agent effort into grounding
- feat(ai): accumulate honest local-assistant token usage per project
- feat(server): expose raw patch from getDiff (stripped from /api/diff)

---

## [1.0.0-rc9.5] — 2026-05-29 — AI: bigger memory, context warning, full screen + heat-map panel

Quality-of-life on the assistant. Still zero new dependencies, still 100%
local (Ollama on `127.0.0.1:11434`).

### Added

- **Bigger conversation memory.** The chat now requests an explicit context
  window (`options.num_ctx`, default **8192**) from Ollama. The daemon's
  default is much smaller and silently drops the oldest turns once a chat
  grows past it — so long conversations kept "forgetting" the start. Ollama
  clamps the request to whatever the model supports, so over-asking is safe.
- **Context-budget warning.** The server returns a rough usage estimate
  (`usage: { estimatedTokens, contextLimit }`) with every reply; the panel
  shows a clear bar once the prompt is estimated at ≥75% of the window
  ("context is ~80% full — consider a New chat") so you're never silently
  truncated. The estimate is approximate by design (no tokenizer on the
  server) and is only used to drive the hint.
- **Full-screen chat.** A ⤢ button expands the assistant to the whole
  window; the choice is remembered. Esc steps back to the windowed modal,
  a second Esc closes it.
- **Heat-map side panel (full screen).** Alongside the chat, a live panel
  shows the same heat map the assistant is grounded in — files coloured
  red (edited) / yellow (propagated) / green (read), most-relevant first.
  **Click a file to drop its path into the composer** and ask about it.
  A ⟳ refreshes it; with no active repo it says so.

### Tests

- `tests/ai/ollama.test.js` — +1 (`options.num_ctx` sent; default + custom;
  `contextLimit` exposed).
- `tests/routes-ai.test.js` — +2 (chat response carries a `usage` estimate;
  the client's context window is reflected).
- **548 vitest total** (+3). Verified against **real Ollama** (chat works
  with `num_ctx`, `usage` returned with `contextLimit` 8192).

### Build / Bundle

- Installers at WiX bundle version `1.0.0.20` (rc9.4 was `.19`).

### Commits

- feat(ai): request a wider context window (num_ctx) + report usage
- feat(ui): full-screen chat + heat-map side panel (click to insert path)
- feat(ui): context-budget warning bar

---

## [1.0.0-rc9.4] — 2026-05-29 — AI hardening (security + hidden-bug audit follow-up)

A hardening pass over the AI assistant after a two-track review (security
+ hidden bugs). **This is the first published release of the rc9.2 vision
and rc9.3 delete/Stop/Copy/model-memory work** — both were built but never
shipped; rc9.4 folds them in and supersedes them. Still zero new
dependencies, still 100% local (Ollama on `127.0.0.1:11434`).

### Fixed — critical

- **Real photo attachments now work.** The global body cap is 64 KB, which
  is correct for every JSON endpoint *except* `/api/ai/chat` — a vision
  message carries base64 image data that is legitimately several MB, so
  real photos were rejected with a 413 before the handler ever ran. A
  dedicated `express.json({ limit: '40mb' })` is now mounted on that single
  path *first* (the global 64 KB parser then no-ops for it via `req._body`),
  so every other route keeps the tight cap. The ceiling clears the route's
  own envelope (4 images × ~6 MB) — the finer per-image checks still bound it.

### Fixed — security

- **Rate limit on `POST /api/ai/chat`** — the most expensive endpoint (a
  120 s Ollama generation that pins CPU/GPU). Token bucket: small burst,
  then ~1 every 5 s — invisible to a human, cuts a runaway loop or a
  no-cors POST flood from another tab short. Parameters are injectable so
  tests assert the 429 path deterministically.
- **Per-project conversation isolation** — the on-disk bucket is now the
  repo basename **plus a short hash of the full path**, so two different
  repos that share a basename (`~/work/api`, `~/oss/api`) can no longer
  share history or the advice counter. The UI still shows the friendly
  basename — the hash never surfaces.
- **No silent truncation** — over-long message content is rejected with an
  explicit `content_too_long` 400 instead of being quietly cut mid-line.
- **Agent filter clamp** — `?platform=` is matched case-insensitively
  against a closed set and resolved to a canonical display label, so an
  arbitrary string can never be interpolated into the (un-escaped Markdown)
  report and the header reads "Claude" rather than "claude".
- **Image validation tightened** — base64 attachments are stripped of any
  `data:` prefix and all whitespace, then validated on charset, padding and
  length, so a multi-MB whitespace blob can't slip through.
- **Ollama 400 mapping** — only classified as `model_unsupported` when the
  daemon actually says so; other 400s map to a generic `bad_request` so the
  user isn't mis-told their model choice is wrong.

### Fixed — hidden bugs

- **Conversation title no longer mutates.** It is pinned once at creation;
  previously, after the 200-message cap sliced off the first user turn, the
  title silently re-derived to a mid-thread follow-up.
- **One Escape closes one modal.** A single Esc keypress cascaded through
  every stacked modal (diff / settings / help / report / AI) at once — now
  the first handler consumes the key and the rest bail on `defaultPrevented`.
- **Error path keeps the turn consistent.** On a failed/aborted send the
  user message stays in both the transcript DOM and the in-memory history
  (they were diverging — bubble on screen, array popped), so a retry never
  replays a history that doesn't match what the user sees.
- **No leaked abort listeners.** The signal-combiner used for cancelable
  Ollama calls now detaches its listeners from *both* signals when either
  fires, so the long-lived caller signal doesn't accumulate them.
- **No image-cap race.** The attach handler re-checks the 4-image cap inside
  each async `FileReader.onload`, so a multi-file drop can't push past it.
- **Outgoing history is trimmed** to the last 30 turns client-side, well
  under the server's 40-message cap, and a 413 / non-JSON error response now
  surfaces a friendly "attachment too large" message instead of throwing raw.

### Tests

- `tests/routes-ai.test.js` — +1 (rate-limit: bucket drains → 429), plus the
  functional cases now inject a wide bucket; project label asserted as the
  friendly basename.
- `tests/routes-report.test.js` — agent-filter cases pass capitalized and
  lowercase `?platform=` and confirm the canonical label in the header.
- **545 vitest total**, 4 skipped. Full suite green.

### Build / Bundle

- Installers at WiX bundle version `1.0.0.19` (rc9.3 was `.18`).

### Commits

- fix(ai): dedicated 40mb body parser for chat so real images work
- feat(ai): rate-limit POST /api/ai/chat (injectable token bucket)
- fix(ai): isolate conversations per repo path; pin title at creation
- fix(ui): one Escape closes a single modal; keep failed turn consistent
- fix(server): clamp platform filter case-insensitively to a canonical label

---

## [1.0.0-rc9.3] — 2026-05-30 — AI panel: delete conversations, Stop, model memory

Polish + optimization for the assistant panel. Zero new dependencies.

### Added

- **Delete a conversation** — a 🗑 button on the open conversation with an
  **inline confirmation** (no native dialog — WebView2 handles those
  inconsistently). `DELETE /api/ai/conversations/:id` (validates the id;
  400 bad / 404 missing). The advice counter is left intact (cumulative).

- **Stop a generation** — while a reply is streaming back the Send button
  becomes a red **Stop**. Pressing it (or the client disconnecting) aborts
  the request **and** the server aborts the Ollama call, so the local
  model stops generating instead of burning compute on an answer nobody
  is waiting for. `ollama.chat()` now accepts an `AbortSignal`; the route
  wires `res` 'close' (guarded by `writableFinished`) to it.

- **Copy a reply** — every assistant message has a one-click **Copy**
  button (Clipboard API, with an execCommand fallback for WebView2), so
  anything useful Ollama says is easy to grab. Shows "Copied ✓".

- **Remembers your model** — the selected Ollama model is saved to
  `localStorage` and restored next time (if still installed).

### Tests

- `tests/ai/conversationStore.test.js` — +1 (delete: removes the file,
  false for unknown/invalid).
- `tests/ai/ollama.test.js` — +1 (caller `AbortSignal` is passed to fetch).
- `tests/routes-ai.test.js` — +1 (DELETE 200 → 404 → 400 contract).
- `tests/e2e/ai-assistant.spec.js` — +1 Playwright (delete with inline
  confirm resets the panel); the round-trip test also clicks Copy and
  verifies the reply lands on the clipboard.
- A regression caught by the suite: a naïve `req` 'close' listener marked
  every completed request as "aborted" (Node fires it after the body is
  read) and hung the chat — fixed to `res` 'close' + `writableFinished`.
- Verified against **real Ollama**: chat still returns normally, then the
  conversation deletes (list empties).
- **544 vitest total** (+3), **18 Playwright** (+1).

### Build / Bundle

- Installers at WiX bundle version `1.0.0.18` (rc9.2 was `.17`).

### Commits

- feat(ai): delete conversations, Stop generation, remember model
- feat(ai): copy an assistant reply to the clipboard

---

## [1.0.0-rc9.2] — 2026-05-30 — AI image attachments (vision)

Attach an image to the chat and the assistant can **see it**. Gemma 3/4
(and other Ollama vision models) read screenshots, diagrams, or error
shots. Still local-only, still zero new dependencies.

### Added

- **Image attachments in the chat composer** — a 🖼 button (file picker)
  **and paste** (Ctrl+V an image). Thumbnails preview above the input
  with a remove (×); up to 4 per message. The user bubble shows the
  attached images inline.

- **`POST /api/ai/chat` accepts per-message `images`** — base64 (a stray
  `data:` prefix is stripped), validated (count ≤ 4, size ≤ ~6 MB each,
  base64 charset) and forwarded to Ollama on the message (`ollama.chat`
  already passes `messages` through verbatim). A message may now be
  **image-only** (no text).

### Notes / limits

- Images apply to the **turn** they're attached to; they are not re-sent
  on later turns and are **not persisted** in the saved conversation
  (text only — base64 would bloat the store). Multi-turn image memory is
  a later enhancement.
- Vision requires a vision-capable model (e.g. `gemma3`, `gemma4`); a
  text-only model will reject the image and the error is surfaced.

### Security / privacy

- Images never leave the machine (same loopback Ollama proxy). The route
  caps count + size and validates the base64 charset; the in-bubble
  preview uses a trusted `data:` URL we built from the user's own file.

### Tests

- `tests/ai/ollama.test.js` — +1 (images forwarded to Ollama).
- `tests/routes-ai.test.js` — +4 (preserve images, strip data: prefix,
  image-only allowed, reject too-many / non-base64).
- `tests/e2e/ai-assistant.spec.js` — +1 Playwright (attach a PNG via the
  file input → thumbnail → POST carries base64 → bubble shows the image →
  thumbs clear).
- Verified end-to-end against **real Ollama**: a solid-red PNG sent to
  `gemma4` → it answered "Rojo".
- **541 vitest total** (+5), **17 Playwright** (+1).

### Build / Bundle

- Installers at WiX bundle version `1.0.0.17` (rc9.1 was `.16`).

### Commits

- feat(ai): image attachments in the chat (vision models)

---

## [1.0.0-rc9.1] — 2026-05-30 — AI conversations, advice counter, chat polish

Builds on the rc9.0 assistant: your chats are now **saved per project**
and restored when you reopen the panel, a **per-project advice counter**
tracks how much help you've taken, and the pending reply shows a minimal
animated **"Reading your repo… / Thinking…"** state so you know it's
working. Still local-only, still zero new dependencies.

### Added

- **`src/server/ai/conversationStore.js`** — persists conversations to a
  GLOBAL folder, never inside the repo:
  `~/.blastradius/conversations/<project>/<id>.json` (+ `_counter.json`).
  UUID ids (validated before any path is built → no traversal), project
  names sanitized to a single safe segment, atomic writes (tmp + rename),
  per-conversation message cap. No new deps (`node:fs/promises` +
  `node:crypto`).

- **Conversation routes** — `POST /api/ai/chat` now persists the turn and
  returns `{ conversationId, adviceCount }`; `GET /api/ai/conversations`
  lists the active project's recent conversations + counter;
  `GET /api/ai/conversations/:id` returns one (400 on a bad id, 404 when
  missing). Best-effort — a save failure never fails the chat.

- **Chat UI (rc9.1)** — a **History** dropdown (reopen a past
  conversation), a **+ New** button (start fresh), and an **advice
  counter** chip ("N advices · this project"). The most recent
  conversation auto-restores on open. A minimal animated pending state
  (bouncing dots) cycles **"Reading your repo…" → "Thinking…"**; honors
  `prefers-reduced-motion`.

### Security / privacy

- Conversations live under `~/.blastradius/` (outside the repo → no git
  pollution), consistent with preferences/knowledge. Loopback-only AI,
  no egress, no keys — unchanged from rc9.0.

### Tests

- `tests/ai/conversationStore.test.js` — 8 vitest (save/load round-trip,
  stable id on overwrite, list ordering, per-project counter, name
  sanitization, traversal-id rejection).
- `tests/routes-ai.test.js` — +2 (chat persists + returns id/counter;
  `:id` 400/404 contract) → 11 total.
- `tests/e2e/ai-assistant.spec.js` — +1 Playwright (history restore,
  advice counter, "New" reset, counter update on send).
- Verified end-to-end against **real Ollama**: a real chat saved to
  `~/.blastradius/conversations/<project>/<uuid>.json` + `_counter.json`,
  listed and re-fetched correctly.
- **536 vitest total** (+12), **16 Playwright** (+1).

### Build / Bundle

- Installers at WiX bundle version `1.0.0.16` (rc9.0 was `.15`).

### Commits

- feat(ai): persist conversations + per-project advice counter
- feat(ai): chat history dropdown, New chat, animated thinking state

---

## [1.0.0-rc9.0] — 2026-05-30 — Local AI planning assistant (Ollama)

A local-only planning assistant, wired to your own **Ollama** daemon. Ask
about next steps, security, or which library to use — replies come from a
model running on your machine, **grounded in your live BlastRadius state**
(what you edited, what it propagates to, the graph, the annotations).
Nothing leaves the box; no cloud, no API keys, no cost. Zero new
dependencies. Conversation persistence (rc9.1) and image attachments
(rc9.3 — Gemma 3/4 are vision-capable) follow.

### Added

- **`src/server/ai/ollama.js`** — a tiny client for the local Ollama
  daemon (`127.0.0.1:11434`, fixed — no SSRF surface). `listModels()`
  (`/api/tags`, never throws — a stopped Ollama is `available:false`) and
  `chat()` (`/api/chat`, non-streaming). Embedding-only models (bge,
  nomic-embed, mxbai, …) are demoted in the list so the picker defaults to
  a chat model. Node 20 global `fetch` — no new deps.

- **`GET /api/ai/models`** and **`POST /api/ai/chat`** — server-side proxy
  to Ollama. The proxy is **required**, not a convenience: the dashboard's
  CSP is `connect-src 'self'`, so the webview can't reach `:11434`
  directly. The chat route validates the model + messages, caps them, and
  prepends the system prompt **server-side** (the client can't drop it).

- **AI assistant modal** — opened from the header `✦ AI` button. Model
  selector + transcript + composer (Enter sends, Shift+Enter newline).
  The system prompt instructs the model to **reply in the user's
  language** (BlastRadius is BG/ES/EN). When Ollama isn't running the
  panel says so and disables sending.

- **Grounding (`src/server/ai/context.js`)** — when a repo is active the
  chat route reuses `gatherReportData()` (the same data behind the report
  export) and feeds the assistant a compact TEXT snapshot of the live
  state: edited files + last agent, propagation, knowledge-graph stats,
  and annotations. The model stops answering blind — ask "what did I
  change?" and it cites the actual files. Text, not an image: LLMs reason
  better over structured text and it works with any model. The block
  carries **authoritative counts** (so the model reports exact numbers
  instead of miscounting a truncated list) and the **last-activity
  timestamp** (so "when?" has an answer). Best-effort — a context-build
  failure never blocks the chat. Every list is capped and the block is
  length-bounded so a large repo can't blow the context.

### Security / privacy

- Loopback-only, fixed host\:port — a request can only ever reach the
  local Ollama daemon. No API keys, no egress; preserves the local-first /
  zero-data-retention identity.
- Replies render via `textContent` (no HTML injection); the server caps
  message count + length and rejects non-`user`/`assistant` roles (the
  system prompt can't be injected by the client).

### Tests

- `tests/ai/ollama.test.js` — 12 vitest (listModels availability +
  embedding demotion, chat success, and OllamaError code mapping:
  unreachable / model_not_found / model_unsupported / bad_status /
  malformed).
- `tests/routes-ai.test.js` — 9 vitest (model passthrough, system-prompt
  prepend, validation 400s, error→status mapping, no-client degradation,
  **grounding injected into the system message when a repo is active**).
- `tests/ai/context.test.js` — 6 vitest (grounding format, authoritative
  counts, last-activity timestamp, list caps, empty-report resilience,
  hard length cap).
- `tests/e2e/ai-assistant.spec.js` — 2 Playwright (modal opens + model
  list + chat round-trip via mocked `/api/ai/*`; Ollama-down state).
- Verified end-to-end against **real Ollama**: models sorted (embedding
  last); a Spanish prompt got a correct Spanish answer; with seeded
  activity, "¿qué archivo edité?" cited the exact path, "¿cuántos?"
  returned the exact count, and "¿cuándo?" returned the timestamp.
- **526 vitest total** (+27), **15 Playwright** (+2).

### Build / Bundle

- Installers at WiX bundle version `1.0.0.15` (rc8.6 was `.14`).

### Commits

- feat(ai): local Ollama planning assistant — proxy routes + chat modal
- feat(ai): ground the assistant in live BlastRadius state

---

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

- **`src/server/reportBuilder.js`** — pure `buildMarkdownReport()`,
  `buildHtmlReport()` (standalone document) + `buildReportFragment()`
  (scoped fragment for the in-app modal). No IO, no server coupling —
  given a data object they always produce the same string, which makes
  them unit-testable. `?embed=1` on `/api/report.html` selects the
  fragment.

- **Export controls in the iteration panel** — "Download .md" (Blob +
  temp-anchor download, with a clear "✓ Saved to your Downloads folder"
  confirmation) and "Print / PDF" (opens an **in-app report modal** and
  prints from there — see Fixed). The export query mirrors the
  dashboard's **active filters** (date range when set, else the
  time-window; plus the agent/platform filter) using the same URL
  assembly as the live heat fetch — the report can't silently diverge
  from the heat map.

- **Resizable right-rail panels** — thin drag gutters between the main
  pane and the file-detail / iteration panels. The width lives in a CSS
  custom property on `.layout` (consumed by a `clamp()`-bounded
  `grid-template-columns`) and is persisted to `localStorage`, so it
  survives reloads. Gutters are `role="separator"` and keyboard-operable
  (←/→ nudge, Home/End jump to max/min); they're hidden in the narrow
  stacked layout where there's no vertical boundary to drag.

### Fixed

- **"Print / PDF" works in the desktop app — via an in-app modal.** The
  Tauri WebView2 shell fights every popup/iframe print path: it blocks
  `window.open('_blank')`, blocks cross-frame `iframe.contentWindow.print()`
  ("Blocked a frame … from accessing a cross-origin frame"), and the
  server CSP (`script-src 'self'`) blocks an iframe's inline self-print
  script. So "Print / PDF" now opens an **in-app report modal**: the
  server returns an embeddable fragment (`?embed=1`, scoped `<style>` +
  `.br-report` div, allowed by the CSP's `style-src 'unsafe-inline'`)
  that's injected as real DOM — no iframe, no cross-origin. "Print / Save
  as PDF" calls the main window's own `window.print()`, and an
  `@media print` rule isolates `#report-modal` so only the report sheet
  prints (not the dashboard). Robust in both the browser and the `.exe`.

- **"Download .md" now confirms the save.** The desktop WebView2 shell
  saves blob downloads silently (no native dialog), so the button now
  shows a clear "✓ Saved “<file>” to your Downloads folder" status — you
  can tell the export happened and where it went.

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
  widens the panel + persists across reload, gutter-to-boundary alignment
  with the iteration panel open (catches the swapped-offset regression),
  and the keyboard nudge path.
- `tests/e2e/report-export.spec.js` — Playwright: "Print / PDF" opens the
  in-app report modal with the report content (no popup, no iframe,
  `window.open` never called), the modal's print button calls
  `window.print()`, and the modal honors the active filters.
- **499 vitest total**, **13 Playwright** (+3 panel-resize, +3 report-export).

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
