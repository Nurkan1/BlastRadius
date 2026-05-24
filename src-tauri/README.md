# BlastRadius Tauri shell

Wraps the BlastRadius Express server + dashboard in a native window.
The desktop installer (MSI / NSIS) bundles the server, its `node_modules`,
and a pinned Node.js binary so the end user does **not** need Node
installed on their machine.

## How it fits together

```
┌─────────────────────────────────────────────────────────────────┐
│ BlastRadius.exe (Tauri shell)                                   │
│                                                                 │
│  setup() in src/lib.rs ──── spawns ──► node.exe                 │
│                                          │                      │
│                                          ▼                      │
│                                    src/server/index.js          │
│                                    listens on :7842             │
│                                                                 │
│  WebView ──── loads ──► http://localhost:7842                   │
└─────────────────────────────────────────────────────────────────┘
```

- `tauri.conf.json` sets `frontendDist` and `devUrl` to the **same**
  URL (`http://localhost:7842`). The WebView always loads the live
  Express server, never the static files. This is what fixed the
  wizard-stuck-on-Scanning bug: the bundled build used to serve
  `src/public/index.html` from `tauri://` and every `/api/*` fetch
  returned HTML instead of JSON.
- `lib.rs` is the load-bearing piece. Its `setup()` callback resolves
  the absolute path to the bundled `node.exe` (under the app's
  resource directory), then `Command::new(node_exe).arg("…/index.js")`
  spawns the server, sets `BLASTRADIUS_LOG_DIR` + `BLASTRADIUS_PORT`,
  and stores the `Child` so we can kill it on app exit.
- `RunEvent::Exit` in `lib.rs` kills the child so closing the window
  cleans up the Node process. No more zombies on close.

## Build pre-requisite

Before `tauri build`, populate `src-tauri/binaries/node.exe`:

```bat
scripts\prepare-bundle.bat
```

The script downloads a pinned Node LTS (currently 22.x) into
`src-tauri/binaries/node.exe`. The file is gitignored so it doesn't
bloat the repo; CI / fresh checkouts always re-download.

## Build commands

```bat
:: dev — opens the window AND spawns the server (via lib.rs setup)
npx tauri dev

:: build — produces MSI + NSIS in src-tauri/target/release/bundle/
scripts\prepare-bundle.bat
npx tauri build
```

## Why we don't use the `tauri-plugin-shell` sidecar API

Two reasons:

1. `Command::new(absolute_path)` from `std::process` is enough and
   pulls in zero new dependencies. The plugin would add a Rust
   compilation unit + a JS package + permissions plumbing for one
   `spawn()` call.
2. The plugin's sidecar contract demands the binary name end in
   `-<target-triple>.exe` (e.g. `node-x86_64-pc-windows-msvc.exe`).
   That's friction every time we update Node and a leak of build-
   target details into the binaries directory. Naming the bundled
   binary plainly `node.exe` and resolving it via `BaseDirectory::
   Resource` is simpler and works across targets.

If we ever need to spawn multiple sidecars or expose them to the
frontend, revisit and pull in the plugin.
