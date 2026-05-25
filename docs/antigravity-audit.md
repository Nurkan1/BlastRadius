# Antigravity Integration — Pre-Refactor Audit

> Date: 2026-05-25 · Baseline: 232 tests green · Target release: **v1.0.0-rc2**
>
> Living document. Kept under version control because the answers to "why
> default to claude?" and "why don't we hash big files?" should not have to
> be reconstructed from chat logs.

> ⚠️ **DEPRECATED ASSUMPTIONS** — read the *"What we learned the hard way"*
> section immediately below this banner first. The `hooks.json` contract
> described in every section beneath that one does **NOT** apply to
> Antigravity 2.0 GUI. Most of the original audit synthesized
> community-sourced information that turned out to be wrong or transferred
> from Claude Code. The skill-based reality is the section right below.
> The rest of this document is kept verbatim as historical record + as a
> trace of what we believed when we shipped commits `f62f657..b0f0223`.

## What we learned the hard way (post-validation, May 2026)

This section was written *after* commits `f62f657..b0f0223` (eight commits
of an Antigravity refactor) had already shipped and a single empirical
test on Windows demonstrated that the entire premise was wrong. The 16
"verified facts" the refactor was built on did not survive contact with a
real Antigravity 2.0 GUI install.

### (a) Honest acknowledgment — the original spec was fictional

The original audit (every section from *"Why this audit exists"* down,
plus the seven-commit plan, plus the spec table the refactor implemented
against) was anchored to a "verified contract" derived from community
posts, forum threads and tutorial content gathered before the empirical
test. None of those sources had actually run a hook against
Antigravity 2.0 GUI — they were repeating a model that either belonged to
an earlier prototype or had been transferred wholesale from Claude Code's
PostToolUse documentation.

Specifically, the following claims in the upper part of this doc are
**FALSE for Antigravity 2.0 GUI**:

- ❌ `.agents/plugins/<plugin>/hooks/hooks.json` configures hooks for the
  GUI agent. (The path exists in the SDK, not in the GUI runtime.)
- ❌ `PreToolUse` and `PostToolUse` events fire and pipe a JSON payload to
  stdin of the configured command. (Not in the GUI; only when the user
  runs the Python SDK directly.)
- ❌ The hook script must respond with `{"decision":"allow"}` on stdout.
  (Same — SDK only.)
- ❌ `${PLUGIN_ROOT}` is substituted by the engine at runtime. (Same.)
- ❌ Antigravity hot-reloads or does NOT hot-reload `hooks.json` (moot —
  no such file is loaded by the GUI).

The code in `src/hook/log-touch-antigravity.js` is correct for an SDK
caller. It is not correct for the GUI, because the GUI never invokes
hooks. Skills do.

### (b) Empirical validation methodology

Sequence of events that produced this section:

1. **Discovery**. The user ran an Antigravity GUI session against a
   workspace where the refactor's installer had laid down
   `.agents/plugins/blastradius/{plugin.json, log-touch-antigravity.js,
   hooks/hooks.json, log-touch.js}`. Gemini edited `CHANGELOG.md` inside
   the agent. The BlastRadius dashboard showed **zero events**. The
   day's JSONL log contained zero new lines.

2. **Diagnosis — filesystem inspection on the real machine**:
   - `~/.gemini/config/plugins/` listed several plugins; none had any
     `hooks/hooks.json` file. Everything inside was markdown.
   - `~/.gemini/config/skills/` was the directory the GUI actually
     reads from. Files there are `SKILL.md` with YAML frontmatter
     declaring `name` and `description`, plus a markdown body.
   - There is no hook binding format in the GUI runtime. The Python
     SDK does have programmatic hooks, but only users running agents
     via SDK ever see those — and "GUI users" is the actual majority.

3. **Validation of the skill-based approach** (controlled test):
   - A file was created at
     `~/.gemini/config/skills/blastradius-observer/SKILL.md`. Gemini
     itself wrote it based on the user's instructions describing the
     desired protocol.
   - A marker file `.blastradius` was placed at the workspace root so
     the skill body could gate activation on workspace context.
   - A fresh Antigravity conversation was opened, the trigger phrase
     was issued, and the agent activated the skill.
   - The agent then invoked, after every tool call, the command
     specified inside the skill body:
     ```
     node <BLASTRADIUS_PATH>/src/hook/log-touch-antigravity.js \
       --tool Read --path <abs path> \
       --session <UUID> --workspace <abs path>
     ```
   - The session id was a real conversation UUID, **not** the
     hardcoded `'antigravity-session'` literal the original
     `scripts/log-external.js` writes.

That single test invalidated five separate "verified facts" from the
upper sections of this doc.

### (c) The actual extension mechanism in Antigravity GUI

For a future contributor who needs to integrate with Antigravity 2.0 GUI,
the working surface is:

- **Location**: `~/.gemini/config/skills/<plugin-name>/SKILL.md`.
  Per-user, global across workspaces. There is currently no
  per-workspace skill directory the GUI consults.
- **Format**: a single Markdown file with YAML frontmatter:

  ```markdown
  ---
  name: blastradius-observer
  description: Observability hook for BlastRadius dashboard. Activates
    when the workspace root contains a .blastradius marker file.
  ---

  After every tool call (Read/Edit/Write/grep/etc.), invoke:

      node ${BLASTRADIUS_PATH}/src/hook/log-touch-antigravity.js \
        --tool <Read|Write|Edit> \
        --path <absolute path of the file just touched> \
        --session <current conversation id> \
        --workspace <absolute path of the workspace root>

  Do not skip this step. Run it BEFORE responding to the user.
  ```
- **Activation**: the agent matches the user's first turn against every
  skill's `description`. If it deems the skill relevant it loads the
  body into context and treats the instructions there as part of its
  system prompt for the conversation.
- **Compliance**: **best-effort, not deterministic**. The LLM may skip
  the step under heavy context, conflicting instructions, or simply
  because the prompt didn't reach high enough attention. Empirical
  estimate from the controlled test plus published reliability of
  similar agent skills: **85-95% coverage** in normal sessions, lower
  under context pressure.

The implication is that Antigravity observability via skills is a
fundamentally different *kind* of integration from Claude Code's
PostToolUse hook. The latter is deterministic — the agent process itself
spawns the hook, the hook either runs or the agent halts. The skill
approach is collaborative — the agent decides whether to honour the
instruction each time.

### (d) The hung-process bug

A second finding from the same test session, independent of the spec
mismatch:

- **Symptom**: after a single Antigravity test session of ~10 minutes
  with maybe a dozen tool calls, **11 `node.exe` processes** were left
  in Windows Task Manager. None was doing anything; each held
  30-80 MB of resident memory. They had to be killed with
  `Stop-Process -Name node` to recover the RAM.
- **Root cause**: `src/hook/log-touch-antigravity.js` reads stdin
  unconditionally — that is the entry point of `main()` after
  `emitAllow()`. When invoked via the skill protocol with CLI
  arguments (`--tool ... --path ...`) and **no piped stdin**, the
  script blocks forever inside `readStdin()` waiting for an `end`
  event that never arrives. The hook never reaches its `appendJsonl`,
  the process never exits, the parent agent never reaps it.
- **Fix required**: detect CLI-mode (presence of any `--tool`,
  `--path`, `--session`, `--workspace` flag) **before** any stdin
  read. In CLI mode the event is built from the argv and stdin is
  never touched. Stdin mode keeps its current behaviour with an added
  safeguard (~500 ms timeout on the stdin promise).
- **Status**: pending refactor (see `BACKLOG.md` —
  *Antigravity v1.0 — pending refactor* — MUST-DO items 1 and 2).

In production this bug is catastrophic. A typical 1-hour agent session
issues 50-150 tool calls; every one would leave a hung Node process.
A user would notice the RAM pressure within an hour. The current rc2
bundle ships this bug — `v1.0.0-rc2` cannot be tagged until it's fixed.

### (e) The skill-based observability trade-off

The decision matrix for the next iteration:

| Property | Claude Code (hook) | Antigravity (skill) |
| --- | --- | --- |
| Coverage | 100% deterministic — agent process spawns the hook | 85-95% best-effort — LLM compliance |
| Latency | bounded by hook timeout (5 s) | bounded by LLM agreeing to run the command |
| User install | Per-workspace via `install-hook.ps1 -Agent claude` | Per-user via `install-hook.ps1 -Agent antigravity` (refactor) writes one `SKILL.md` to `~/.gemini/config/skills/` |
| Failure mode | hook crash visible in agent stderr | silent skip; we only know coverage dropped because event count is low |
| Hostility surface | hook stderr contaminates LLM context | skill body counts as system prompt — long body adds tokens to every turn |

For v1.0 the chosen trade-off is: accept the 85-95% coverage on the
Antigravity side, document it honestly in the README's agent support
matrix, and surface the per-agent breakdown in the dashboard so a user
can see at a glance whether their Antigravity coverage looks healthy.
Determinism is not a feature we can provide on this side; pretending we
can would be worse than admitting the limit.

---

## Why this audit exists

BlastRadius shipped a UI tab labeled **Antigravity** and a CLI helper
(`scripts/log-external.js`) that lets a human pretend to be an
Antigravity agent. That is **not** an integration: it is a manual data
entry surface with a branded button. Before publishing v1.0 we need
either real Antigravity support or to remove the misleading affordances.

This document captures the audit performed against the **official
Antigravity hook contract** (Google DeepMind, plugin v2.0 schema). Each
finding is anchored to the file and line that produced it. Commands used
to verify are reproduced verbatim so a future contributor can replay the
audit and watch the same conclusions fall out.

---

## Official Antigravity hook contract (reference)

Verified from Google docs + community plugin examples. Captured here in
full because the upstream documentation has at least one known erratum
(early versions documented `.agent/hooks/` — the canonical path is
`.agents/plugins/<plugin>/hooks/hooks.json`).

### Where the configuration lives

Two valid scopes:

- **Per-project (local):** `<workspace>/.agents/plugins/<plugin>/hooks/hooks.json`
- **Per-user (global):** `~/.gemini/config/plugins/<plugin>/hooks/hooks.json`

A plugin v2.0 manifest is mandatory:

```
.agents/plugins/blastradius/
  ├── plugin.json            # { "name": "blastradius", ... }
  └── hooks/
      └── hooks.json
```

### `hooks.json` shape

Object with a root `hooks` key. **Not** a flat array — the loader rejects
arrays with a parse error.

```json
{
  "description": "BlastRadius observability hook for Antigravity",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "edit_file|patch_file|write_file|view_file|grep_search",
        "hooks": [
          {
            "type": "command",
            "command": "node ${PLUGIN_ROOT}/log-touch-antigravity.js",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [ ... same shape ... ]
  }
}
```

### Lifecycle events (3 layers)

| Layer | Enter | Exit | BlastRadius uses |
|---|---|---|---|
| Agent | Start | Stop | No |
| Model | BeforeModel | AfterModel / AfterAgent | No |
| Tool | **PreToolUse** | **PostToolUse** | **Yes — only these** |

### Tool → heat color mapping

| Antigravity tool | Claude Code equivalent | Heat color |
|---|---|---|
| `edit_file` | Edit | red |
| `patch_file` | Edit | red |
| `write_file` | Write | red |
| `view_file` | Read | orange |
| `grep_search` | Read (multi-file) | orange |
| `run_command` | — | (excluded from matcher, see Design decision #3) |

### I/O contract

**Input via stdin (JSON, camelCase mandatory).** Example PreToolUse
payload:

```json
{
  "conversationId": "uuid-v4",
  "workspacePaths": ["/abs/path/to/workspace"],
  "transcriptPath": "/abs/path/to/transcript.jsonl",
  "artifactDirectoryPath": "/abs/path/to/artifacts",
  "stepIdx": 4,
  "toolCall": {
    "name": "edit_file",
    "args": {
      "Path": "/abs/path/to/file.ts",
      "Instructions": "..."
    }
  }
}
```

Paths in `toolCall.args.Path` are **always absolute**. `workspacePaths`
is an **array** (multi-workspace support).

**Output via stdout (JSON mandatory):**

```json
{ "decision": "allow" }
```

Valid `decision` values: `allow`, `deny`, `ask`, `force_ask`. BlastRadius
always returns `allow` — we are an observer, never a validator. **If we
fail to emit a valid JSON object on stdout, the engine applies the
fail-safe `deny` and blocks the agent's tool call.**

### Environment variables injected by Antigravity

| Variable | Claude Code equivalent | Use in BlastRadius |
|---|---|---|
| `ANTIGRAVITY_SESSION_ID` | sessionId | session id in JSONL |
| `ANTIGRAVITY_PROJECT_DIR` | cwd | repo path detection |
| `ANTIGRAVITY_STEP_IDX` | (n/a) | optional, debug only |
| `ANTIGRAVITY_TOOL_NAME` | tool | tool → heat mapping |
| `ANTIGRAVITY_TOOL_CWD` | (n/a) | only relevant for `run_command` |
| `PLUGIN_ROOT` | (n/a) | path to our plugin install |
| `PLUGIN_DATA` | (n/a) | per-plugin writable state |

### Execution constraints

- **PreToolUse is BLOCKING.** Exceed the timeout and the engine SIGKILLs
  us and applies fail-safe `deny`. Our hook must finish in **< 50 ms**.
- **PostToolUse is background.** Latency budget is laxer but we still
  target < 100 ms.
- **Default timeout: 30 s, hard max: 900 s.** We set `timeout: 5` defensively.
- **stderr is injected into the agent's context** if the hook fails.
  Our hook must **never** write to stderr in normal operation — anything
  we emit there becomes prompt pollution for the next model call.
- **No hot reload** of `hooks.json`. Schema changes require `/reload` or
  a restart of the Antigravity agent.

### Key differences from Claude Code (do not assume parity)

1. No native Edit/Write/Read distinction. We must map by `toolCall.name`.
2. `conversationId` ≠ Claude's `sessionId` semantically, but functionally
   equivalent for our purposes.
3. `workspacePaths` is an array. Claude Code is single-cwd. Path
   normalization must pick the workspace path that *contains* the file.
4. The hook only sees agent actions, never the human's manual edits.
   Same as Claude Code.
5. `${PLUGIN_ROOT}` resolves with `\` on Windows and `/` on Unix. Hooks
   must use `path.join` / `pathlib`, never naive string concat.

---

## Current implementation findings

Each row was verified against the working tree as of HEAD. Commands used
are reproduced in the **Evidence** column. Severity legend:

- **BLOCKER** — Antigravity will not be able to invoke our hook at all.
- **MAJOR** — Hook would invoke but produce wrong data or degrade
  agent UX (latency, contaminated context).
- **MINOR** — Works but inconsistent with the contract or our own
  conventions.

| # | Aspect | Current implementation | Required by contract | Status | Severity | Evidence |
|---|---|---|---|---|---|---|
| 1 | Location of `hooks.json` | Not present anywhere in repo | `.agents/plugins/blastradius/hooks/hooks.json` | ❌ | BLOCKER | `find . -name hooks.json -not -path "*/node_modules/*" -not -path "*/target/*"` → 0 hits |
| 2 | `plugin.json` manifest | Not present anywhere in repo | Mandatory at plugin root | ❌ | BLOCKER | `find . -name plugin.json -not -path "*/node_modules/*" -not -path "*/target/*"` → 0 hits |
| 3 | Format of `hooks.json` | N/A — file doesn't exist | Object with `hooks` root key | ❌ | BLOCKER | (consequence of #1) |
| 4 | Lifecycle event used | N/A — no installable hook | PreToolUse + PostToolUse | ❌ | BLOCKER | (consequence of #1) |
| 5 | Tool matcher | N/A | `edit_file\|patch_file\|write_file\|view_file\|grep_search` | ❌ | BLOCKER | (consequence of #1) |
| 6 | Input parsing | Reads `--path` / `--tool` / `--cwd` from argv | camelCase JSON via stdin per official schema | ❌ | BLOCKER | `scripts/log-external.js` lines 26-42 use `process.argv.slice(2)` |
| 7 | Output emission | Prints `[BlastRadius] Logged ...` to stdout (line 66). Engine would parse that as malformed JSON and fail-safe → `deny` | `{"decision":"allow"}` JSON to stdout, nothing else | ❌ | BLOCKER | `grep -n "decision\|stdout.write" scripts/log-external.js` → no matches |
| 8 | Tool → heat color mapping | Hardcoded from argv `--tool Read\|Write\|Edit` | Mapped from `toolCall.name` (5 distinct values) | ❌ | MAJOR | `scripts/log-external.js` line 28 default `'Write'` |
| 9 | Path normalization | `normalizePath(absPath, cwd)` with single cwd | Pick the `workspacePaths[i]` that **contains** the file; fall back to `[0]` | ❌ | MAJOR | `scripts/log-external.js` line 58 |
| 10 | Timeout configured in hook | N/A | `timeout: 5` in `hooks.json` | ❌ | MAJOR | (consequence of #1) |
| 11 | Multi-workspace handling | Not considered | `workspacePaths` is array, may have >1 entry | ❌ | MAJOR | n/a — feature does not exist |
| 12 | Cross-platform script invocation | `node scripts/log-external.js` (no `${PLUGIN_ROOT}`) | `node ${PLUGIN_ROOT}/log-touch-antigravity.js` | ❌ | MAJOR | (consequence of #1) |
| 13 | Antigravity env vars used | None — not even read as fallback | At minimum SESSION_ID, PROJECT_DIR, TOOL_NAME | ❌ | MAJOR | `grep -n "ANTIGRAVITY_" scripts/log-external.js` → 0 hits |
| 14 | Hook latency | Not measured. Hot path runs `hashFile` (stream read + crypto) + `appendJsonl` BEFORE exit. Probable 30-150 ms for normal-size files | < 50 ms for PreToolUse (else fail-safe deny) | ⚠️ | MAJOR | No perf test exists; manual reasoning over `log-touch.js` source |
| 15 | stderr silence | Writes `[BlastRadius] Log failed: <err>` to stderr on any I/O error (line 70) | Silent in normal operation; even on error, prefer file log over stderr | ⚠️ | MINOR | `scripts/log-external.js` line 70 |
| 16 | sessionId | Hardcoded literal `'antigravity-session'` for every event | Real `conversationId` from payload | ⚠️ | MAJOR | `scripts/log-external.js` line 61; `src/server/heatEngine.js` lines 143, 146, 276 all compare against the literal |
| 17 | Attribution in heatEngine | String compare against literal `'antigravity-session'` | Read an explicit `agent` field; fallback to sessionId heuristic only for legacy events | ⚠️ | MAJOR | `src/server/heatEngine.js` lines 273-281 |
| 18 | Antigravity-specific tests | 4 tests in `heatEngine.test.js` that exercise only the sessionId-literal filter | Schema parsing, multi-workspace path resolution, stdout decision contract, perf budget | ❌ | MAJOR | `grep -c "antigravity" tests/heatEngine.test.js` → 4, all in one describe block |
| 19 | UI filter by agent | Buttons "All / Claude / Antigravity / Manual" wired in `index.html` + CSS | Filter exists and works on the current data | ✅ | — | `src/public/index.html:55`, `src/public/styles.css:200` |
| 20 | `agent` field in JSONL | Schema is `{ts, tool, path, pathNorm, cwd, hash, sessionId}`. No `agent`. | Recommended explicit field for robust attribution post-refactor | ❌ | MINOR | `src/hook/log-touch.js` event builder — no `agent` key |

### Aggregate severity

| Severity | Count |
|---|---|
| BLOCKER | 7 |
| MAJOR | 9 |
| MINOR | 2 |
| PASS | 1 |
| ⚠️ (degraded) | 3 |

**Read:** what we call "Antigravity support" today is a UI tab over a
manual CLI. There is no machinery the Antigravity engine could invoke,
and even if it could, our output would trigger the fail-safe deny.
Removing the UI affordance would be more honest than shipping it as-is.
The refactor brings the implementation in line with the label.

---

## Design decisions

These decisions are settled. Future contributors can change them, but
they should know what alternatives were weighed and rejected.

### Decision 1 — Back-compat for events without an `agent` field

**Strategy:** the reader never trusts `agent` as the sole source of
truth. A pure function `inferAgent(event)` applies a cascade:

```js
function inferAgent(ev) {
  // 1. Explicit field on the event (new schema, post-refactor).
  if (typeof ev.agent === 'string' && ev.agent.length > 0) return ev.agent
  // 2. Legacy sessionId-based detection (the only marker we had before).
  if (ev.sessionId === 'antigravity-session') return 'antigravity'
  if (!ev.sessionId) return 'manual'
  // 3. Default for every other case — including all pre-refactor JSONL
  //    written by Claude Code's hook, which never carried `agent`.
  return 'claude'
}
```

**Why default to `'claude'` rather than `'unknown'`:** 100% of
pre-refactor JSONL events came from Claude Code's PostToolUse hook
(the only real producer; the Antigravity CLI with the hardcoded literal
sessionId is captured by stage 2 of the cascade). An `'unknown'` default
would silently break the UI's "Claude" filter for every historical event
the user has on disk.

**Canonical agent strings** (lowercase, exported as a const):
`'claude'`, `'antigravity'`, `'manual'`. Display names ("Claude Code",
"Antigravity", "Manual / CLI") live in a single presentation-layer map.
This also fixes a latent bug in `src/public/app.js:474` where the CSS
class is derived via `toLowerCase().replace(/[^a-z0-9]/g, '-')` and
produces `agent-claude-code` with a dash — the new canonical strings
have no spaces.

**Tests this decision earns** (in `tests/eventStore.test.js` and
`tests/heatEngine.test.js`):

| # | Test | Input | Expected |
|---|---|---|---|
| 1 | Legacy Claude event with no `agent` field → `claude` | `{ts, tool:"Edit", path, sessionId:"claude-abc"}` | `inferAgent → "claude"`; attribution → "Claude Code" |
| 2 | Legacy Antigravity event via old CLI → `antigravity` | `{... sessionId:"antigravity-session"}` (no `agent`) | `inferAgent → "antigravity"` |
| 3 | New event with explicit `agent:"claude"` → `claude` | `{... agent:"claude", sessionId:"claude-xyz"}` | `inferAgent → "claude"` |
| 4 | Explicit `agent:"antigravity"` overrides sessionId hint | `{... agent:"antigravity", sessionId:"some-uuid"}` | `inferAgent → "antigravity"` |
| 5 | Empty sessionId, no agent → `manual` | `{... sessionId:""}` | `inferAgent → "manual"` |
| 6 | Non-string `agent` (e.g. 42, null) ignored, falls through | `{... agent:42, sessionId:"claude-abc"}` | `inferAgent → "claude"` |
| 7 | Mixed JSONL file: half legacy, half new | one log file with both shapes interleaved | Both contribute to heat; no event dropped |
| 8 | heatEngine `platform=claude` filter includes legacy events | Events without `agent`, various sessionIds | All non-antigravity-session counted as claude |

`computeHeat`'s filter at `heatEngine.js:143-150` will be rewritten to
go through `inferAgent` rather than the literal string compare. That
rewrite lives in **commit 2** alongside the schema bump so no commit
between 2 and 6 is broken.

### Decision 2 — Hash policy for large files

**Decision:** files larger than 10 MB get `hash: "skipped:large-file"`
instead of a real SHA-256.

**Threshold rationale:** PreToolUse is blocking, target latency 50 ms.
At ~200 MB/s read on SSD and ~500 MB/s SHA-256 throughput, 10 MB
hashes in ~50 ms worst case. Anything larger blows the budget.

**Sentinel format** (string, never null or empty):

| Condition | `hash` value |
|---|---|
| File hashed OK | `"sha256:<64 hex chars>"` — unchanged from current format |
| File > 10 MB | `"skipped:large-file"` (new) |
| File unreadable (ENOENT, EACCES, …) | `"skipped:unreadable"` (new — also covers the previously-silent failure mode) |

The sentinel is a deliberate signal. Consumers can match on the prefix
(`hash.startsWith('skipped:')`) to filter out events without a real
hash if they need it.

**Implementation detail:** `fs.statSync(path).size` BEFORE opening the
stream. Stat is O(1) on NTFS/ext4 and costs < 1 ms; opening a 100 MB
stream just to abort it doesn't. The constant
`MAX_HASH_BYTES = 10 * 1024 * 1024` lives in `src/hook/log-touch.js` and
is shared by both hooks (Claude + Antigravity) so the policy stays in
one place.

**Why not the alternatives:**

- *Truncated hash* (first N bytes): breaks the identity property of
  `hash`. Two files with the same prefix (lockfiles, generated build
  outputs) would collide. Useless for the heat map's purposes.
- *Deferred hash* (compute off the hot path, patch the event later):
  introduces mutable state in the event store. Either we ship the
  event twice or we hold it back until the hash lands. The
  consumer (chokidar tail + SSE broadcast) is not designed for either.
  Too much new surface for a 50 ms budget.

The new Antigravity hook stats the file synchronously to decide
skip-vs-hash, then **emits `{"decision":"allow"}` on stdout before
awaiting the hash promise**. JSONL append happens in a `setImmediate`
so the agent's event loop is freed ASAP. Documented in the file header.

### Decision 3 — `run_command` excluded from the matcher

**Decision:** the matcher is `edit_file|patch_file|write_file|view_file|grep_search`. No `run_command`.

**Why not include it:**

- BlastRadius is a **file-touch heat map**. `run_command` doesn't touch
  files directly — it invokes `cargo`, `npm test`, formatters, etc. Its
  payload has no `toolCall.args.Path`.
- Inferring affected files from cwd or from process output is
  AI-style guessing, not a clean signal.
- Every matcher hit costs a hook invocation (~30-50 ms cold start of
  node). Antigravity will fire `run_command` constantly during a real
  session (build, test, lint). Paying that cost just to discard the
  event would visibly degrade agent UX.

**`grep_search` is included**, with one event emitted per distinct file
in the result set (typical `grep_search` payload exposes `results[].path`
or similar). Same mental model as "Claude read 47 files" — 47 orange
events. The exact field path in the `grep_search` payload is verified
against a real fixture in the perf/contract test of Fase 4.

**`run_command` telemetry is roadmap, not v1.0.** If we later want a
view of "tests the agent ran", we add a new event type `tool: "Run"`
that does NOT contribute to heat colors but lives in the log and powers
a future Activity timeline. Out of scope for rc2.

---

## Pre-flight checklist (run after commit 7, before tagging rc2)

These checks gate the v1.0.0-rc2 tag. Failure on any single line means
the tag does not land and we go back to the bench.

### 1. End-to-end with real Antigravity

- Install Antigravity agent on the dev machine.
- Run `scripts/install-hook.ps1 -ProjectPath <repo> -Agent antigravity`.
- Reload the Antigravity agent (`/reload`).
- In the agent session: ask it to edit a file inside `<repo>`.
- Watch the BlastRadius dashboard.
- **Pass criterion:** the edited file appears red in the tree, with
  agent attribution "Antigravity", within **3 seconds** of the edit
  landing on disk. Latency from edit → SSE broadcast is what counts;
  anything beyond 3 s means the hook ran but our pipeline is slow.

### 2. Legacy JSONL parses cleanly

- Take a session-YYYY-MM-DD.jsonl file from a Claude Code session
  written BEFORE the rc2 refactor (the user has these on disk from
  weeks of normal usage — pick the largest one).
- Boot BlastRadius with that file as the active day's log.
- **Pass criterion:** every event is loaded, every event attributes to
  "Claude Code" in the side panel and the platform filter. Zero events
  dropped. Counts match an offline `wc -l` of the file.

### 3. Installer smoke test on a clean machine

- VM or fresh Windows install with Node 18+ but no prior BlastRadius
  artifacts.
- Install NSIS bundle.
- Run `install-hook.ps1 -ProjectPath C:\test-repo -Agent both`.
- Verify on disk:
  - `<repo>/.claude/settings.json` exists with the Claude Code hook entry.
  - `<repo>/.agents/plugins/blastradius/plugin.json` exists.
  - `<repo>/.agents/plugins/blastradius/hooks/hooks.json` exists, parses
    as JSON, has the canonical `hooks.PreToolUse` and `hooks.PostToolUse`
    matcher.
- **Pass criterion:** both agents get their config, neither overwrites
  the other's, idempotent re-run leaves the file states unchanged.

### 4. Full test suite + new Antigravity tests

- `npm test` from a clean checkout.
- **Pass criterion:** at least 243 tests pass (232 existing + 11 new
  from `tests/log-touch-antigravity.test.js`). Zero skipped that
  weren't already skipped pre-refactor. Zero new failures.

---

## Commit plan (for reference; one section per landed commit will be
appended to this doc as we land each)

| # | Commit | Estimated time |
|---|---|---|
| 1 | `audit(antigravity): document divergence from official hooks contract` *(this commit)* | 15 min |
| 2 | `feat(events): add explicit "agent" field with back-compat default "claude"` | 30 min |
| 3 | `feat(antigravity): add dedicated log-touch hook compliant with official spec` | 60 min |
| 4 | `feat(antigravity): add plugin.json + hooks.json templates` | 20 min |
| 5 | `feat(installer): support both claude and antigravity in install-hook.ps1` | 45 min |
| 6 | `test(antigravity): cover official payload contract and performance` | 50 min |
| 7 | `chore(release): bump to v1.0.0-rc2 + regenerate NSIS/MSI installers` | 15 min |

**Compromise:** every existing test stays green after every commit. No
commit between 2 and 6 leaves the tree in a state where `npm test` fails.
Each commit is atomic and `git bisect`-able.

---

## Performance backlog post-v1.0

Commit 6 brought the Antigravity hook cold-start from ~127 ms to
~100 ms by extracting pure helpers from `log-touch.js` (which carries
`pino` and `dotenv`) into `log-touch-shared.js` (node:* builtins
only). Of the ~25 ms separating us from the 75 ms design target,
roughly 95 % is Node-runtime cold-start floor on Windows
(`node -e "process.stdout.write('hi')"` measures ~65 ms by itself).

Three avenues to recover that gap, in order of feasibility:

1. **Node `--build-snapshot` / `--snapshot-blob`.** Viable only when
   we ship the user's `node` binary alongside the plugin. Today the
   plugin in `<workspace>/.agents/plugins/blastradius/` runs under
   whatever `node` is on the user's PATH — we don't control its
   version, and snapshot blobs are version-specific. Pre-conditions
   for this to be worth pursuing:
   - We bundle a pinned `node.exe` next to the plugin (mirroring the
     Tauri sidecar pattern).
   - `install-hook.ps1` runs `node --build-snapshot log-touch-antigravity.js`
     during install and bakes the resulting `.blob` path into the
     hook command.
   - We accept the `ExperimentalWarning` to stderr or suppress it
     globally per the contract.
   Expected gain when applicable: 15-25 ms.

2. **`node:module` compile cache (Node 22+).** Less invasive than
   snapshots; caches compiled bytecode without freezing the JS heap.
   Activate via `node --use-compile-cache=…`. Becomes worth
   investigating once Node 22 is our minimum supported version (we
   currently support Node 18+ to match Claude Code's baseline).
   Expected gain: 10-15 ms.

3. **Pre-spawned daemon hook host.** The hook becomes a thin IPC
   client that connects to a long-running daemon (e.g. a UNIX socket
   under `~/.blastradius/sockets/` or a named pipe on Windows). The
   daemon owns the file watchers + JSONL appenders. Hook latency
   collapses to the IPC round-trip (~5 ms). This is the only path
   to sub-50 ms wallclock — and the only one worth building before
   we hit a real perf problem in the wild. Architectural change;
   only justified if Antigravity adoption proves the heat-map model
   and we start hearing perf complaints.

None of these are blockers for v1.0.0-rc2. The 100 ms ceiling stays
well under Antigravity's 5 s configured timeout and well under the
30 s default, so the hook is never going to trip the fail-safe deny
in practice. Listed here so a future contributor doesn't have to
re-derive the analysis.
