# BlastRadius

> Live impact map of Claude Code edits across your repos.
> Watches what Claude touches, paints the heat in real time, propagates
> change through your import graph, and shows the diff on click.

---

## What it does

BlastRadius is a **local-only dashboard** that observes every file your
Claude Code session reads, writes, or edits, and paints it on a tree
of your repository:

- **🔴 red** &nbsp; — Claude just edited this file.
- **🟠 orange** — Claude just read this file (no changes).
- **🟡 yellow** — this file imports something that turned red (the
  "blast radius").
- **⚪ cold** &nbsp; — nothing happened.

It also tracks how much of your repo was touched in different time
windows (current iteration, last hour, full session) and shows the
**git diff** of any red file inline.

It's **read-only** on your repositories. The server never writes to
your code; it only reads files, watches for changes, and runs
`git diff`. The only file it ever writes is its own preferences at
`~/.blastradius/preferences.json`.

### What it does NOT see

BlastRadius is wired specifically into **Claude Code's hook
system**. It does not see:

- Edits made in VSCode, Notepad, JetBrains, Cursor, or any other
  editor or IDE
- File saves from build tools, formatters, or git operations
- Anything happening before you installed the hook

If you make a change to a file by hand and BlastRadius shows nothing,
that's expected. It only lights up for Claude Code's `Read` / `Write` /
`Edit` tool invocations.

---

## Quickstart (5 minutes)

### Prerequisites

- **Node.js 18+** in your `PATH`
- **git** in your `PATH` (used by the diff viewer)
- **Claude Code** installed (the CLI or desktop app)
- **Windows** (the launcher is a `.bat`; the rest of the codebase is
  cross-platform, but the install script is PowerShell)

### 1. Install BlastRadius

```bash
cd C:\Users\YOU\Documents
git clone https://github.com/Nurkan1/BlastRadius.git
cd BlastRadius
npm install
```

### 2. Install the hook in each repo you want to observe

```powershell
.\scripts\install-hook.ps1 -ProjectPath C:\path\to\your\repo
```

This creates `<repo>/.claude/settings.json` with a `PostToolUse`
hook that fires after every Claude Code `Edit` / `Write` / `Read`.
The log directory is **baked into the hook command**, so no
environment variable setup is required.

Re-running the script is idempotent — only the BlastRadius entry
is replaced; other hooks in `settings.json` are preserved.

> ⚠️ Claude Code reads `.claude/settings.json` once at **session
> start**. If you have a Claude Code session already open in that
> repo, **restart it** for the hook to take effect.

### 3. Start the dashboard

```cmd
run.bat
```

or with a clean slate (wipes preferences + logs):

```cmd
run.bat CLEAN=1
```

Open <http://localhost:7842>.

### 4. Walk through the first-run wizard

The dashboard asks for a **parent directory** that contains the
repos you want to observe (e.g. `C:/Users/YOU/Documents`).
BlastRadius scans up to 3 levels deep looking for folders that
contain a `.git/` entry.

After the wizard, the dropdown in the header lists every repo it
found, with active ones (recent events) on top and idle ones
greyed out at the bottom. You can click any of them at any time
to switch the dashboard's focus.

### 5. Use Claude Code as you normally would

Every `Edit` / `Write` / `Read` Claude does on a hooked repo lands
on the dashboard in **under 3 seconds**.

---

## Daily use

### Workflow

1. **Open the dashboard** in a browser tab and leave it. (It's
   harmless even when the server is the only thing running — no
   network calls, no analytics, just a tab.)
2. **Work with Claude Code** in any repo where you installed the
   hook. The dashboard updates live.
3. **Click red files** to see exactly what changed (git diff in
   a side-by-side viewer).
4. **Press `Alt+I`** to toggle the *iteration panel*. When you
   start a new piece of work, click "Marcar fin de iteración" to
   reset the iteration clock — the panel then shows you metrics
   for the new iteration only.

### Reading the dashboard

```
┌────────────────────────────────────────────────────────────────┐
│ ⚡ BlastRadius  [IdeaBlast ▾] [auto]  [Iter Hour Session]  …  │  ← header
├────────────────────────────────────────────────────────────────┤
│ ▾ src/                                          │ src/App.tsx │  ← tree (left)
│   ▾ components/                                 │ heat: red   │     side panel (right)
│     🔴 App.tsx                                  │             │
│   ▸ hooks/                                      │ [Open diff] │
│   🟡 main.tsx                                   │             │
│ ▸ tests/                                        │             │
└────────────────────────────────────────────────────────────────┘
```

| UI element | What it means |
|---|---|
| **Repo dropdown** | The active repo. Switch any time without reloading. |
| **`auto` / `manual` pill** | When `auto` is on (default), the server switches the active repo if another repo gets sustained activity (≥30s span). Click to disable. |
| **`Iteration` / `Hour` / `Session`** | Time window for the heat colors. "Iteration" = since last reset (or last 3 min). "Hour" = last 60 min. "Session" = no time filter (everything today). |
| **🔴 N 🟠 M 🟡 K** | Live counters for the current window. |
| **RADIUS X%** | `(red + orange + yellow) / totalFilesInRepo × 100`. Higher = more of the repo is "hot". |
| **LIVE / RECONNECTING** | SSE connection status. If it says reconnecting for more than a few seconds, the server probably crashed. |
| **`⌥I` button** | Open or close the iteration panel. Same as the `Alt+I` keyboard shortcut. |

### The iteration panel

The right panel (opens with `Alt+I`) breaks down the **current
iteration** with:

- N edited files / M read files
- K files affected by import propagation
- Blast radius % of the repo
- Time since last activity
- Start timestamp of the current iteration
- A red **"Marcar fin de iteración"** button that resets the
  iteration to "now". The next iteration starts from there.

---

## Glossary

### Colors

| Color | Trigger | When it's assigned |
|---|---|---|
| **Red** | `Edit` or `Write` event | A direct mutation by Claude Code. |
| **Orange** | `Read` event with no Edit/Write on the same file | The file was inspected but not changed. |
| **Yellow** | Transitive importer of a red file | BFS over the **reverse** import graph (1–3 levels deep, configurable). Only red files propagate; reads do not. |
| **Cold (no color)** | Nothing in this window | The file is not in the heat map at all. |

### Windows

| Window | Time range |
|---|---|
| **Iteration** | Events at or after the last "Marcar fin de iteración" click. If you never clicked it, defaults to the last 3 minutes. |
| **Hour** | Last 60 minutes. |
| **Session** | All events in the current day's log file. No time filter. |

### Repo states (in the dropdown)

| State | Meaning |
|---|---|
| **🟢 active (pulsing dot)** | Currently selected. |
| **active (not pulsing)** | Has events in the last 7 days. |
| **idle (greyed out)** | Detected as a `.git/` directory but no events recorded yet. |

---

## Multi-repo

BlastRadius is designed to observe **multiple repos at once**.

- The hook is installed per-repo (run `install-hook.ps1` once
  per repo). They all write to the same shared log directory.
- The dashboard always shows **one repo at a time** ("the active
  repo"). The dropdown lets you switch.
- With `auto` on, the server switches the active repo when
  another repo gets sustained activity (≥ 2 events spanning ≥30s
  in the last 60s).
- The import graph is built per-repo and cached for 5 minutes.
  Switching repos triggers a graph rebuild for the new one in
  the background (red/orange show up immediately; yellow lands a
  second later).

### How to add a new repo to the dashboard

1. `./scripts/install-hook.ps1 -ProjectPath C:\path\to\new\repo`
2. Restart any Claude Code session already open in that repo.
3. Edit any file with Claude Code → the repo flips from idle to
   active in the dropdown.

### How to remove a repo

1. Delete `<repo>/.claude/settings.json` (or just the BlastRadius
   entry if you have other hooks).
2. The repo stays in the dropdown until it falls out of the 7-day
   activity window. The dashboard never deletes anything on its
   own.

---

## Troubleshooting

### The dashboard is empty after editing files

1. **Did you restart Claude Code?** The hook is loaded once at
   session start. Sessions opened before you ran `install-hook.ps1`
   never fire it.
2. **Is the hook actually invoked?** Check the JSONL log:
   ```cmd
   type C:\Users\YOU\Documents\BlastRadius\logs\session-YYYY-MM-DD.jsonl
   ```
   If lines are being added when Claude edits files, the hook
   works and the issue is somewhere on the server.
3. **Is the server still running?** The header badge should say
   `LIVE`. If it says `RECONNECTING` for more than 30 seconds, the
   server crashed. Run `run.bat` again.

### `run.bat` fails: "node not found"

Add Node 18+ to your `PATH`, or edit the bat to use the full path
to `node.exe`.

### The yellow propagation never shows anything

- Your codebase needs **static imports** that `dependency-cruiser`
  can resolve. For TypeScript/JavaScript repos it should "just
  work" once you have a `tsconfig.json` in the repo root.
- For other languages (Python, Go, Rust, …) there is no built-in
  parser, so the graph is empty and you'll see red/orange but
  never yellow. That's a known limitation.

### I want to change the parent directory

In the dropdown menu (where you switch repos), click
**⚙ Cambiar directorio padre…**. A small modal lets you point at
a different directory. If the current repo is no longer a child
of the new parent, the wizard runs again to pick a new repo.

### How do I wipe everything and start fresh?

```cmd
run.bat CLEAN=1
```

This deletes `~/.blastradius/preferences.json` and clears the
JSONL log. The next start drops into the wizard.

### Where are the logs?

Daily JSONL files in `<BlastRadius>/logs/`. The path is fixed at
install time (via the `-LogDir` parameter of `install-hook.ps1`)
and baked into the hook command in `<repo>/.claude/settings.json`.

---

## Architecture

```
   ┌──────────────────────────────────────────────────────────┐
   │                CLAUDE CODE (in observed repo)             │
   │                                                           │
   │   tool: Edit / Write / Read on src/foo.ts                 │
   │            │                                              │
   │            ▼  PostToolUse hook                           │
   │   .claude/settings.json → "node log-touch.js --log-dir…" │
   └──────────────────────────────────────────────────────────┘
                                │ stdin JSON
                                ▼
   ┌──────────────────────────────────────────────────────────┐
   │   HOOK   src/hook/log-touch.js (Phase 1)                  │
   │   • Parse stdin → tool, file_path, session_id             │
   │   • Hash the file (sha256 stream)                         │
   │   • Append one JSONL line to logs/session-YYYY-MM-DD.jsonl│
   │   • Exit in <100ms; never blocks Claude                   │
   └──────────────────────────────────────────────────────────┘
                                │ file system
                                ▼
   ┌──────────────────────────────────────────────────────────┐
   │   SERVER   src/server/                                    │
   │                                                           │
   │   eventStore       — tails the JSONL file (chokidar)      │
   │   treeScanner      — walks repo, respects .gitignore      │
   │   graphResolver    — dependency-cruiser, reverse graph    │
   │   heatEngine       — pure fn: events → {files, metrics}   │
   │   diffProvider     — simple-git diff → diff2html HTML     │
   │   iterationMarker  — in-memory "iteration started at…"    │
   │   repoDetector     — scans parentDir for .git/ folders    │
   │   preferences      — atomic-write ~/.blastradius/prefs    │
   │   sse              — Server-Sent Events broadcaster       │
   │   routes           — Express router (/api/*)              │
   └──────────────────────────────────────────────────────────┘
                                │ HTTP + SSE
                                ▼
   ┌──────────────────────────────────────────────────────────┐
   │   DASHBOARD   src/public/  (browser)                      │
   │                                                           │
   │   index.html  — shell + 3-panel layout                    │
   │   styles.css  — dark theme + heat-color CSS variables     │
   │   app.js      — D3 tree, EventSource, modals              │
   └──────────────────────────────────────────────────────────┘
```

### API summary

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness probe + diagnostics |
| `GET /api/tree` | Repo tree of the active repo |
| `GET /api/heat?window=iteration\|hour\|session` | Heat map + metrics |
| `GET /api/events` | Server-Sent Events stream |
| `GET /api/diff?path=…&against=HEAD` | Validated git diff (HTML) |
| `GET /api/iteration` | Current iteration marker |
| `POST /api/iteration/close` | Advance the iteration marker |
| `GET /api/repos` | Detected repos under parentDir |
| `GET /api/repos/active` | Currently active repo |
| `POST /api/repos/select` | Switch the active repo |
| `GET /api/preferences` | Full prefs + `needsSetup` flag |
| `POST /api/preferences` | Merge into prefs (validates parentDir) |

### Security model

- **All paths in `/api/diff` and `/api/repos/select` are
  validated.** Three layers: reject NUL bytes, reject absolute
  paths, reject anything that resolves outside `repoRoot` /
  `parentDir`.
- **git is invoked via `simple-git`'s argv-style API** — no shell
  interpolation. The `against` parameter is whitelisted against
  `[A-Za-z0-9_./@~^-]{1,100}` so a malicious `?against=HEAD;rm -rf /`
  is rejected before git is touched.
- **The repository graph is never exposed** by any API endpoint.
  It stays internal to the server.
- **No CORS headers.** The dashboard is intended for `localhost`
  only.
- **No authentication.** Per the threat model in `CLAUDE.md`, this
  is a local-only developer tool. Do not expose it to the
  internet.

---

## Tests

```bash
npm test        # vitest run — 183 tests, ~2 seconds
```

Coverage at a glance:

| Suite | Tests | What it checks |
|---|---|---|
| `log-touch.test.js` | 35 | Hook IO, path normalization, JSONL append, CLI args |
| `heatEngine.test.js` | 35 | Pure heat computation across all windows + edge cases |
| `heatEngine.propagation.test.js` | 13 | Yellow propagation against a fixture repo |
| `graphResolver.test.js` | 26 (2 POSIX) | Dependency-cruiser wrapper, BFS, cycles, fan-in |
| `diffProvider.test.js` | 25 | Path traversal, ref injection, integration against a real git repo |
| `preferences.test.js` | 21 (2 POSIX) | Persistence, atomic write, corruption recovery |
| `repoDetector.test.js` | 28 (2 POSIX) | Multi-repo scan, activity ranking, auto-switch logic |

POSIX-tagged tests cover symlink and `chmod` behavior that's not
testable on Windows without elevated permissions.

---

## Limitations

1. **Only Claude Code.** Edits from other editors / build tools
   are invisible. By design — the data source is the Claude Code
   PostToolUse hook.
2. **Windows-focused tooling.** The `.bat` launcher and `.ps1`
   installer are Windows-specific. The hook and server are
   cross-platform, but porting the launcher to bash is a small
   to-do.
3. **No auth, no remote.** Localhost only. The threat model
   assumes a single user on a trusted machine.
4. **Per-machine config.** The hook command in
   `.claude/settings.json` contains an absolute path to the
   BlastRadius checkout. Each contributor must re-run
   `install-hook.ps1` after cloning.
5. **Yellow propagation needs static imports.** Languages without
   a dependency-cruiser parser (Python, Go, Rust, …) get an
   empty graph. Red and orange still work fine.
6. **Single-day log files.** The hook rotates to a new JSONL at
   midnight (local time). If you keep the dashboard open across
   the day boundary, you'll see the eventStore re-load with
   yesterday's contents archived.
7. **In-memory iteration marker.** Restarting the server resets
   the marker to "no iteration started" (falls back to the 3-min
   heuristic).

---

## Roadmap (rough)

- [ ] Bash launcher equivalent for macOS / Linux.
- [ ] Multi-day log aggregation in the session window.
- [ ] In-dashboard help overlay (eliminate the
      "I don't know what blast radius means" UX hole).
- [ ] Optional persistence of the iteration marker.
- [ ] Recursion into git submodules for the import graph.

---

## Phases (history of the codebase)

Built in five phases, each landing in independently revertable
commits:

| Phase | What it added |
|---|---|
| **F1** | `log-touch` PostToolUse hook + JSONL writer + standalone verifier |
| **F2** | Express server, chokidar watcher, SSE, D3 dashboard |
| **F3** | Import graph + reverse-BFS yellow propagation |
| **F4-A** | Diff modal (hover tooltip + sandboxed git diff + diff2html viewer) |
| **F4-B** | Iteration panel (live metrics + "end iteration" button + Alt+I shortcut) |
| **F5** | Multi-repo: parent-dir scanning, preferences file, first-run wizard, repo selector, auto-switch |

---

## License

TBD. For now: personal-use only.

---

## Credits

Built with:

- [Express](https://expressjs.com/) (HTTP server)
- [chokidar](https://github.com/paulmillr/chokidar) (file watching)
- [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) (import graph)
- [simple-git](https://github.com/steveukx/git-js) (sandboxed git)
- [diff2html](https://diff2html.xyz/) (diff rendering)
- [D3.js](https://d3js.org/) (tree visualization)
- [pino](https://getpino.io/) (structured logging)
- [Vitest](https://vitest.dev/) (testing)

All vendored or CDN-served; no build step.
