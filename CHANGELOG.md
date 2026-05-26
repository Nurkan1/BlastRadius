# Changelog

All notable changes to BlastRadius are documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/) and
this project adheres to [Semantic Versioning](https://semver.org/).

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
