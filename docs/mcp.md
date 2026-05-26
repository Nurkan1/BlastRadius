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
- For long-lived agent setups that need the MCP server even when
  the dashboard UI is closed, Phase 2 will ship a stdio shim
  (`bin/blastradius-mcp.mjs`) that can boot a headless Node
  instance on demand using the bundled `binaries/node.exe`.
