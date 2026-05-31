# BlastRadius MCP integration

BlastRadius v1.0.0-rc3 ships a read-only MCP (Model Context Protocol)
server embedded in the dashboard process. Any MCP-capable agent —
Claude Code, Antigravity 2.0, custom Anthropic SDK clients — can
consult the current iteration, summarize recent progress, list
iteration windows, and read git diffs through standardized JSON-RPC
calls.

The MCP surface is **strictly read-only** in this phase. Mutations
(closing an iteration, switching repos) remain UI-only until Phase
3 gates them behind explicit consent metadata.

---

## Protocol version

The server uses [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
**v1.29.0**, which speaks **MCP wire protocol version `2025-03-26`**
during the `initialize` handshake.

| Negotiation rule | Behavior |
|---|---|
| Client sends a version the server supports | Server echoes that version. |
| Client sends a newer version | Server downgrades to the highest version it speaks (`2025-03-26`). |
| Client sends an older version we still support | Server accepts the older version. |
| Client sends an unrecognized / dropped version | Server responds with the latest it speaks; client decides whether to proceed. |

**Verified client compatibility** (as of 1.0.0-rc3 release date):

| Client | Minimum version | Transport |
|---|---|---|
| Claude Code | 1.0+ | `streamable HTTP` (recommended) or `stdio` (Phase 2) |
| Antigravity 2.0 | any GA build | `streamable HTTP` |
| Anthropic SDK + custom client | `@modelcontextprotocol/sdk@^1.0.0` | any |

If your client speaks an older MCP wire version (e.g. `2024-11-05`),
the handshake still succeeds — the SDK is backwards compatible — but
some newer fields (e.g. `structuredContent` on tool responses) may
not be visible. The text block under `content[0].text` always carries
the same JSON payload as `structuredContent`, so older clients
degrade cleanly.

---

## Transport endpoint

```
POST  http://localhost:7842/mcp     ← client → server JSON-RPC requests
GET   http://localhost:7842/mcp     ← server-initiated SSE streams
DELETE http://localhost:7842/mcp    ← stateless: no-op (compat with stateful clients)
```

- **Transport**: Streamable HTTP (SSE-flavored). The SDK auto-detects
  whether to respond with batched JSON or an SSE stream based on the
  client's `Accept` header.
- **Mode**: Stateless. Each request opens a fresh transport bound to
  a shared `McpServer` instance — no session cookies, no `sessionId`,
  no cross-request leakage.
- **Rate limit**: dedicated token bucket of **100 burst, 30/sec
  sustained**. On exhaustion the server replies `429` with
  `Retry-After` and `{ "error": "rate_limited", "retryAfterSec": N }`.
- **Auth**: none. BlastRadius binds to localhost only and inherits the
  same trust boundary as the dashboard itself.

---

## Connecting a client

### Option A — one-shot setup via `install-hook.ps1 -RegisterMcp` (`v1.0.0-rc4`+)

The hook installer can register the MCP server in the matching agent's
global config in the same pass that installs the touch-event hook:

```powershell
# Claude Code: writes the entry into %USERPROFILE%\.claude.json
.\scripts\install-hook.ps1 -ProjectPath C:\projects\myrepo -Agent claude -RegisterMcp

# Antigravity 2.0: writes into %USERPROFILE%\.gemini\config\mcp_config.json
.\scripts\install-hook.ps1 -ProjectPath C:\projects\myrepo -Agent antigravity -RegisterMcp

# Both at once
.\scripts\install-hook.ps1 -ProjectPath C:\projects\myrepo -Agent both -RegisterMcp

# Non-default port (BLASTRADIUS_PORT was set)
.\scripts\install-hook.ps1 -ProjectPath C:\projects\myrepo -Agent claude -RegisterMcp `
  -McpUrl http://localhost:7878/mcp

# Preview without writing
.\scripts\install-hook.ps1 -ProjectPath C:\projects\myrepo -Agent both -RegisterMcp -DryRun
```

Idempotent: running it again with the same URL is a no-op
(`UNCHANGED`). Running it with a different URL writes a timestamped
backup before overwriting (suppressed with `-Force`). Other MCP
servers already registered by the user are preserved verbatim — the
underlying merger ([`scripts/register-mcp.mjs`](../scripts/register-mcp.mjs))
only touches the `mcpServers.blastradius` entry.

The merger is implemented in Node specifically to dodge Windows
PowerShell 5.1's `ConvertTo-Json`, which uses a vertical-alignment
indent that triples the file size and destroys the user's existing
2-space-indented JSON. Node's `JSON.stringify(obj, null, 2)` matches
what Claude Code and Antigravity emit natively.

### Option B — `claude mcp add` (manual, Claude Code only)

```bash
claude mcp add --transport http blastradius http://localhost:7842/mcp
```

Verify:

```bash
claude mcp list                # blastradius should appear "connected"
claude mcp get blastradius     # shows tools, resources, server version
```

In a Claude Code session, the model can now consult:

```
> Summarize my current BlastRadius iteration.
> List the last 3 iterations and tell me which files were hottest.
> What does the diff of src/server/routes.js look like right now?
```

### Option C — Claude Desktop via stdio shim (`v1.0.0-rc5`+)

Claude Desktop does not honor the http transport — its config
validator silently drops any entry shaped like `{ type: "http", url: ...}`.
For Desktop, the installer registers a bundled stdio shim
(`bin/blastradius-mcp.cjs`) that proxies stdio JSON-RPC to the
dashboard's `/mcp` endpoint.

```powershell
.\scripts\install-hook.ps1 -ProjectPath . -Agent claude -RegisterDesktop
```

Two non-obvious quirks the installer works around automatically:

1. **The server name is `blastradius-observability`, not `blastradius`.**
   Claude Desktop maintains an in-process persistent rejection
   blocklist by server name. Once it rejects an entry under a name
   (which can happen on an early misconfiguration), it silently
   deletes any subsequent entry under that same name on every
   config read. The alternative name permanently escapes the
   blocklist.

2. **The shim is registered as `.cjs`, not `.mjs`.** Claude
   Desktop's config validator additionally filters out any `args`
   entry that resolves to a `.mjs` file. The `.cjs` wrapper spawns
   the `.mjs` implementation as a child process and inherits its
   stdio.

After running the installer, **fully quit Claude Desktop** (system
tray icon → Quit) and reopen it. The new server then appears as
`blastradius-observability` alongside any other MCPs you have
registered. The BlastRadius dashboard must be running on the
configured port (`http://localhost:7842` by default) for the shim
to reach it.

### Antigravity 2.0

In Antigravity's MCP config (per-project, in `.agents/mcp.json`):

```json
{
  "servers": {
    "blastradius": {
      "transport": "http",
      "url": "http://localhost:7842/mcp"
    }
  }
}
```

Run `/reload` in the Antigravity session — Antigravity does not hot-reload
MCP config the same way it doesn't hot-reload hooks.

### Anthropic SDK (custom client)

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const transport = new StreamableHTTPClientTransport(
  new URL('http://localhost:7842/mcp'),
)
const client = new Client({ name: 'my-app', version: '1.0.0' })
await client.connect(transport)

const summary = await client.callTool({
  name: 'get_iteration_summary',
  arguments: {},
})
console.log(summary.structuredContent)
```

---

## Tools

Every tool returns `{ content: [{ type: 'text', text: <json> }], structuredContent: <same json> }`.

### `get_iteration_summary`
Returns the current iteration with metrics and per-file activity
attribution. Equivalent to `GET /api/iteration/summary`.

No arguments.

### `summarize_progress`
Aggregates JSONL events into per-file Edit/Write/Read counts and
per-agent attribution.

```jsonc
{
  "since": "2026-05-26T08:00:00Z",  // optional, defaults to iteration marker or now − 3 min
  "allRepos": false                 // optional, defaults to false
}
```

### `list_recent_iterations`
Iterations are inferred from event gaps. Each contiguous burst of
activity counts as one iteration.

```jsonc
{
  "limit": 10,                      // optional, max 50, default 10
  "gapMs": 180000                   // optional, [30000, 3600000], default 180000 (3 min)
}
```

### `get_file_diff`
Validated git diff of one repo-relative file. Path validation is
shared verbatim with `/api/diff` (single source of truth).

```jsonc
{
  "path": "src/server/routes.js",   // required, repo-relative
  "against": "HEAD"                 // optional, defaults to "auto"
}
```

### Knowledge Graph tools (`v1.0.0-rc8`+)

All five share a common prelude: resolve the active repo via
`getRepoContext()`, bail with NO-DATA `reason` (`no_active_repo` /
`needs_setup` / `graph_not_ready`) if the snapshot hasn't been built
yet, then read O(1) from the cached snapshot. Path inputs go through
the **same** `DiffProvider.validatePath` that gates `/api/diff` and
`get_file_diff` — single source of truth for CWE-22 defense.

#### `get_codebase_graph`
Returns the active repo as a graph: nodes (files) with
`fanIn / fanOut / kind / sizeBytes / summary / tags`, plus edges
(imports) scoped to the returned node set. Sorted by `fanIn` desc,
ties broken by path.

```jsonc
{
  "limit": 200,                              // optional, default 200, hard ceiling 1000
  "kinds": ["source", "test"],                // optional, subset of {source,test,config,doc,other}
  "minFanIn": 0,                              // optional
  "withSummaryOnly": false                    // optional
}
```

#### `get_nearest_neighbors`
Walks the import graph up (consumers) and / or down (dependencies)
for a given file. Depth clamped to `[1, 10]`. Returns `unknown_node`
when the path is valid but not in the graph (e.g. a newly created file
hasn't been picked up by the rebuild yet).

```jsonc
{
  "path": "src/server/routes.js",   // required, repo-relative
  "depth": 2,                       // optional, default 2
  "direction": "both"               // optional, "consumers" | "dependencies" | "both"
}
```

#### `describe_node`
Full node detail plus a cross-walk with the last 7 days of touch
events (`Edit` / `Read` / `Write` counts + last agent). Cheap because
`eventStore` already caches per-day and per-repo; cross-walk failure
is non-fatal — the structural part still returns.

```jsonc
{
  "path": "src/server/heatEngine.js"
}
```

#### `find_nodes`
Substring search over `path` / `summary` / `tags`. Scoring (higher =
more relevant): path starts with `q` → 10, tag exact match → 8,
summary contains `q` → 5, tag substring → 4, path substring → 3.
Returns up to `limit` matches sorted by score desc, ties broken by
path.

```jsonc
{
  "query": "auth",                       // required, 1..128 chars, case-insensitive
  "fields": ["path", "summary", "tags"], // optional, subset to search
  "limit": 200                           // optional, default 200, hard ceiling 1000
}
```

#### `set_node_summary` — **mutation**
Persists a per-file `summary` (≤ 2000 chars) and `tags` (≤ 20 × 32
chars) to `~/.blastradius/knowledge.json`. **Does not** modify any
file in the repo.

The tool ships with `annotations`:

```jsonc
{
  "readOnlyHint": false,
  "destructiveHint": false,
  "idempotentHint": true,
  "openWorldHint": false,
  "requiresConsent": true   // additive flag, stripped by the SDK at the wire
}
```

The combination `readOnlyHint:false + destructiveHint:false` is what
MCP clients (Claude Code, Claude Desktop) check to gate the call
behind a consent prompt. Defense-in-depth: the Zod schema caps
`summary.max(2000)` and `tags.max(20)`, so oversize input is
rejected at the protocol layer before our handler runs.

```jsonc
{
  "path": "src/server/heatEngine.js",
  "summary": "Pure heat color computation. No IO.",
  "tags": ["core", "pure", "windows"]
}
```

Error codes (surfaced as `reason` on the response):
`summary_too_long`, `too_many_tags`, `tag_too_long`,
`tag_invalid_type`, `invalid_path`, `escapes_root`, `absolute_path`,
`nul_byte`, `knowledge_store_unavailable`.

#### `get_setup_status` (rc9.19)
Read-only. Reports whether the BlastRadius PostToolUse hook is
installed and correct for the active repo, the `settings.json` path,
and where the hook writes its logs vs where the dashboard reads
(`serverLogDir`). Returns `{ ok, activeRepo, hookInstalled,
needsInstall, settingsPath, serverLogDir, expectedCommand,
currentCommand, reason }`. Call it before `install_hook`.

#### `install_hook` (rc9.19) — **mutation**
Installs / repairs the PostToolUse hook in the active repo's
`.claude/settings.json` so a user can ask Claude Code to "set up
BlastRadius" and have it done end-to-end. Idempotent (`action`:
`created` | `updated` | `noop`), preserves any other hooks, backs up
an existing settings file. Carries the same consent annotations as
`set_node_summary` (`readOnlyHint:false` + `destructiveHint:false`).

**Security:** the load-bearing invariant — it only ever writes inside a
repo under `preferences.parentDir`. A repo outside the declared
workspace is refused with `reason: 'repo_outside_parent_dir'` and
nothing is written. Other reasons: `no_active_repo`, `no_parent_dir`,
`server_misconfigured`, plus the installer's own
(`not_a_git_repo`, `settings_read_failed`, …).

---

## Resources

All resources return `{ contents: [{ uri, mimeType: 'application/json', text: <json> }] }`.

| URI | Description |
|---|---|
| `blastradius://health` | Server status, uptime, event count, active repo. |
| `blastradius://iteration/current` | Current iteration marker + summary fused. |
| `blastradius://repo/active` | Currently active repo path + short name. |
| `blastradius://repos` | All detected repos under `parentDir` ranked by activity. |
| `blastradius://events/recent` | Last 100 touch events on the active repo, newest first. |
| `blastradius://graph/summary` | Knowledge Graph stats counters (`v1.0.0-rc8`+). |
| `blastradius://graph/topology` | Full snapshot, capped at 200 nodes (`v1.0.0-rc8`+). For larger pulls use `get_codebase_graph` with a custom `limit`. |
| `blastradius://graph/cycles` | Strongly-connected components > 1 plus explicit self-edges. NO-DATA `reason` `cycles_none` for clean DAGs (`v1.0.0-rc8`+). |
| `blastradius://graph/orphans` | Files with `fanIn === 0` outside the `DEFAULT_ENTRY_POINTS` allowlist. Candidates for dead-code review. NO-DATA `reason` `orphans_none` when empty (`v1.0.0-rc8`+). |
| `blastradius://heat/{window}` | Heat map for window in `{session, iteration, hour, day}`. |

---

## NO-DATA contract

When a tool or resource cannot return a meaningful answer (no active
repo, no events in the window, wizard mode, invalid input), it
**never throws**. It always returns a structured object whose value
fields are `null` and whose `reason` is a short, stable
`lower_snake_case` string.

Example — calling `get_iteration_summary` with no active repo:

```json
{
  "iteration": null,
  "iterationStartedAt": null,
  "metrics": null,
  "activities": null,
  "reason": "no_active_repo"
}
```

Reason codes (stable across versions):

| Code | Meaning |
|---|---|
| `no_active_repo` | `preferences.currentRepo` is `null`. |
| `needs_setup` | Fresh install — dashboard in wizard mode. |
| `no_active_iteration` | `iterationMarker` has not been closed yet. |
| `no_events_in_window` | The window contains zero events. |
| `no_events_recorded` | The event store is empty (no hook activity today). |
| `unknown_window` | Caller asked for a window the server doesn't support. |
| `escapes_root` / `path_traversal` / `nul_byte` / `absolute_path` | Path validation failure (reused from `/api/diff`). |
| `invalid_ref` | Git ref didn't match the allowed character set. |
| `no_repos_under_parent_dir` | Detector found no repos. |
| `no_parent_dir` | `parentDir` is not configured. |
| `graph_not_ready` | KnowledgeGraph snapshot not yet built (rc8+). |
| `unknown_node` | Path is valid but absent from the current graph snapshot (rc8+). |
| `no_matches` | `find_nodes` returned zero results (rc8+). |
| `cycles_none` | The graph is a clean DAG — empty `cycles` array (rc8+). |
| `orphans_none` | Every non-entry-point file has at least one consumer (rc8+). |
| `knowledge_store_unavailable` | `set_node_summary` invoked but the singleton wasn't injected (rc8+). |
| `summary_too_long` / `too_many_tags` / `tag_too_long` / `tag_invalid_type` | KnowledgeStore cap defense (rc8+). |

LLM-facing rule of thumb: when `reason` is non-null, phrase the
user-facing answer using the reason ("no active iteration yet — close
one or wait for activity") instead of "the tool errored".

---

## Lifecycle and bundling

- The MCP server lives in the same process as the dashboard
  (`src/server/index.js`). When BlastRadius is closed, the MCP
  endpoint goes with it.
- The Tauri NSIS / MSI bundles automatically include `src/mcp/**`
  and `@modelcontextprotocol/sdk` via the existing `resources` glob
  in `src-tauri/tauri.conf.json`. No installer config changes were
  required.
- The stdio shim shipped in `v1.0.0-rc5` (`bin/blastradius-mcp.cjs`)
  is the production path for Claude Desktop and any other client
  that only speaks stdio. It is a proxy, not a second McpServer —
  it requires the dashboard to be running on the configured port
  (`http://localhost:7842/mcp` by default) to reach the actual MCP
  surface.

---

## Live usage panel + in-app Help (`v1.0.0-rc5`+)

The dashboard now ships two affordances that close the agent
integration loop without leaving the app:

- **MCP usage panel** (inside the iteration panel, opens with
  `Alt+I` then expand "MCP usage"): a live counter of MCP requests
  served since boot, broken down by tool / resource / method, and
  cross-tabbed by client (`claude-ai`, `claude-desktop`,
  `antigravity`, `mcp-sdk-client`, ...). Driven by `GET /api/mcp/stats`
  on initial load and the `mcp-stats-update` SSE event for live
  updates. If a unique-name DoS attempt or heavy legitimate traffic
  trips the in-memory cap (`MAX_DISTINCT_KEYS = 200`), a red banner
  surfaces the dropped-key count so the breakdown is never silently
  truncated.

- **In-app Help modal** (`Ctrl+/` or the header `?` button): four
  tabs covering Setup (copy-paste commands for every agent),
  Tools & Resources (the full surface), Sample Prompts (six
  ready-to-use bootstrap and query prompts for agents), and
  Troubleshooting (the four real-world Claude Desktop quirks
  documented above). All copy-to-clipboard via the Clipboard API
  with a textarea fallback.

Both are read-only — the panel does not call `/mcp`, and the Help
modal contains baked-in static content. Neither feature changes the
contract documented in this file; they exist to make the contract
discoverable.

---

## Counter semantics — per-request attribution and memory caps

Every request reaching `/mcp` is recorded in three places:

1. **Aggregate totals** — `totals.{tools, resources, other, total}`.
2. **By tool / resource / method name** — `byName[]`, sorted by
   count descending. Tool calls land under `tool:<name>`, resource
   reads under `resource:<uri>`, and other methods (chiefly
   `initialize`) under `method:<name>`.
3. **By client** — `byClient[]` and `byClientByName[]`. Identity is
   resolved in this order: explicit `clientInfo.name` from the
   `initialize` body (preferred, but only present on the handshake);
   falls back to a `User-Agent`-derived fingerprint for known
   vendors (`claude-ai`, `claude-code`, `claude-desktop`,
   `antigravity`, `mcp-sdk-client`, `node-client`, `manual-cli`).
   Any unrecognized UA collapses into a single `"unknown"` bucket —
   a deliberate privacy choice that also doubles as a per-client
   DoS defense.

Memory caps:

- `MAX_DISTINCT_KEYS = 200` per Map (`byName`, `byClient`, and each
  client's sub-breakdown inside `byClientByName`). Once at cap,
  existing keys still increment but new keys are silently dropped.
- `MAX_COUNT_PER_KEY = 1B` per individual key. Defends against
  integer drift if the dashboard runs for years against the same
  hot key.
- The number of dropped keys is exposed at `droppedKeys.{byName, byClient}`
  in `/api/mcp/stats` so the operator can detect either heavy
  legitimate traffic or a unique-name DoS attempt.
