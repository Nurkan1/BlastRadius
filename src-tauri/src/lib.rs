// BlastRadius Tauri shell.
//
// Responsibilities of this file:
//   1. On startup, spawn the bundled Node.js server (src/server/index.js)
//      using the bundled node.exe so the end user does NOT need Node
//      installed.
//   2. On exit, kill the spawned server.
//
// The WebView itself loads `http://localhost:7842` (configured in
// tauri.conf.json). We never serve the static frontend from inside the
// bundle — that's what caused the "wizard stuck on Scanning…" bug,
// because /api/* requests fell back to the SPA index.html and the
// frontend received HTML where it expected JSON.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::path::BaseDirectory;
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Port the Express server binds to. Mirrored in tauri.conf.json's
/// `frontendDist` / `devUrl`. Keep these three in sync if you ever
/// change it.
const SERVER_PORT: u16 = 7842;

/// State shared with the RunEvent::Exit handler so we can kill the
/// server child process when the user closes the window.
struct ExpressServerState {
    child: Arc<Mutex<Option<Child>>>,
}

/// Cheap synchronous TCP probe — used to detect a server we didn't
/// start (e.g. the developer is already running `npm start` from a
/// terminal). Avoids double-spawning in that case.
fn is_port_in_use(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", port).parse().unwrap(),
        Duration::from_millis(200),
    )
    .is_ok()
}

/// Resolve the absolute path to the bundled `node.exe`. Tauri stages
/// resources that were declared with a `../` prefix in `bundle.resources`
/// under a `_up_/` subdirectory of the resource root — but the resource
/// base path the API returns does NOT include that prefix. To survive
/// both layouts (the `_up_/`-wrapped one used by `cargo build` output
/// and any future layout the installer might produce), we try several
/// candidate sub-paths and use whichever actually exists on disk.
fn resolve_node_exe(app: &tauri::App) -> Option<PathBuf> {
    let candidates = [
        // Standard layout: resource root contains binaries/ directly
        // (the case we'd hit if Tauri ever stops nesting under _up_/).
        "binaries/node.exe",
        "binaries\\node.exe",
        // `../` form: lets Tauri's path normalizer drop us into the
        // `_up_/` directory it stages our resource at. This is the
        // form that actually resolves on `cargo build --release`
        // output AND on installed MSI / NSIS bundles produced from
        // a config that uses "../binaries/node.exe" in resources.
        "../binaries/node.exe",
        "..\\binaries\\node.exe",
    ];
    for candidate in candidates {
        if let Ok(path) = app.path().resolve(candidate, BaseDirectory::Resource) {
            if path.exists() {
                return Some(path);
            }
        }
    }
    None
}

/// Resolve the absolute path to the server entry script, plus the
/// working directory the server should run from. The cwd matters
/// because the Node `require()` resolver walks UP from cwd looking for
/// `node_modules`. Same dual-candidate strategy as resolve_node_exe()
/// — see that function for why both "src/..." and "../src/..." need
/// to be tried.
fn resolve_server_paths(app: &tauri::App) -> Option<(PathBuf, PathBuf)> {
    let candidates = [
        "src/server/index.js",
        "src\\server\\index.js",
        "../src/server/index.js",
        "..\\src\\server\\index.js",
    ];
    for candidate in candidates {
        if let Ok(script) = app.path().resolve(candidate, BaseDirectory::Resource) {
            if script.exists() {
                // cwd = the resource root containing src/ + node_modules/
                // + package.json. Three pops: index.js → server → src.
                let mut cwd = script.clone();
                cwd.pop();
                cwd.pop();
                cwd.pop();
                return Some((script, cwd));
            }
        }
    }
    None
}

/// Where to put the daily JSONL logs the hook writes.
///
/// Priority:
///   1. `BLASTRADIUS_LOG_DIR` env var if set (matches the run.bat
///      launcher convention).
///   2. The `logs/` directory under the user's currentRepo, read from
///      `~/.blastradius/preferences.json`. This matches how
///      `install-hook.ps1` bakes the `--log-dir` argument into the
///      `.claude/settings.json` of each observed repo — without this
///      step the hook writes to `<repo>/logs/` while the server reads
///      from `~/.blastradius/logs/` and the dashboard stays empty.
///   3. Fallback: `%USERPROFILE%\.blastradius\logs` (stable across
///      app updates, doesn't depend on any specific repo being set up
///      yet — used on a fresh first-run install).
fn resolve_log_dir() -> PathBuf {
    // 1. Honor an explicit override.
    if let Some(env) = std::env::var_os("BLASTRADIUS_LOG_DIR") {
        let p = PathBuf::from(env);
        let _ = std::fs::create_dir_all(&p);
        return p;
    }

    // 2. Try preferences.json → currentRepo + "/logs".
    let mut prefs_path = home_dir();
    prefs_path.push(".blastradius");
    prefs_path.push("preferences.json");
    if let Ok(text) = std::fs::read_to_string(&prefs_path) {
        if let Some(repo) = parse_current_repo(&text) {
            let logs = PathBuf::from(&repo).join("logs");
            if logs.exists() {
                trace(&format!("log dir from preferences.json: {:?}", logs));
                return logs;
            }
        }
    }

    // 3. Fallback to the per-user log dir under ~/.blastradius.
    let mut base = home_dir();
    base.push(".blastradius");
    base.push("logs");
    let _ = std::fs::create_dir_all(&base);
    trace(&format!("log dir falling back to: {:?}", base));
    base
}

/// %USERPROFILE% on Windows, $HOME elsewhere, "." as a last resort.
fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Tiny hand-rolled extraction of the `currentRepo` field from
/// preferences.json. We don't pull in serde just for this one field —
/// the file is owned by our Node side, the schema is stable, and the
/// failure case (the function returns None) is what we want anyway.
fn parse_current_repo(json: &str) -> Option<String> {
    let key = "\"currentRepo\"";
    let after_key = json.find(key)?;
    let rest = &json[after_key + key.len()..];
    // Skip whitespace + the colon, then look for the opening quote.
    let colon = rest.find(':')?;
    let after_colon = &rest[colon + 1..];
    // Could be `null` (no repo selected yet).
    let trimmed = after_colon.trim_start();
    if trimmed.starts_with("null") {
        return None;
    }
    let q1 = trimmed.find('"')?;
    let after_q1 = &trimmed[q1 + 1..];
    let q2 = after_q1.find('"')?;
    Some(after_q1[..q2].to_string())
}

/// Append a line to the Tauri-shell trace log. Used to capture WHERE
/// the sidecar bootstrap got to even when the parent app has no
/// console (windows_subsystem = "windows") and the regular println!
/// calls are silently dropped.
///
/// IMPORTANT: this function MUST NOT call `resolve_log_dir()` —
/// `resolve_log_dir()` itself calls `trace()` for diagnostics, and
/// reciprocal calls would infinite-recurse and overflow the stack.
/// The trace log always lives at `~/.blastradius/logs/shell-trace.log`
/// regardless of where the runtime log dir ends up resolving to.
fn trace(line: &str) {
    let mut dir = home_dir();
    dir.push(".blastradius");
    dir.push("logs");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("shell-trace.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{}] {}", ts, line);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let child_arc: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let child_for_setup = Arc::clone(&child_arc);

    let app = tauri::Builder::default()
        .setup(move |app| {
            trace("setup() entered");
            // Logger only in debug builds — production windows shouldn't
            // emit stdout noise.
            if cfg!(debug_assertions) {
                let _ = app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                );
            }

            // Skip spawn entirely if something is already listening — we
            // get this when the developer ran `npm start` in another
            // terminal and forgot.
            if is_port_in_use(SERVER_PORT) {
                trace(&format!("port {} already in use → reusing", SERVER_PORT));
                return Ok(());
            }

            let node_exe = match resolve_node_exe(app) {
                Some(p) => {
                    trace(&format!("node.exe resolved: {:?}", p));
                    p
                }
                None => {
                    // Best-effort: dump every Resource search candidate
                    // for diagnostics. Probe a handful of common bases.
                    let probes = [
                        ("Resource binaries/node.exe", app.path().resolve("binaries/node.exe", BaseDirectory::Resource)),
                        ("AppData binaries/node.exe", app.path().resolve("binaries/node.exe", BaseDirectory::AppData)),
                        ("Resource ../binaries/node.exe", app.path().resolve("../binaries/node.exe", BaseDirectory::Resource)),
                    ];
                    for (label, p) in probes {
                        match p {
                            Ok(path) => trace(&format!(
                                "probe {} → {:?} (exists={})",
                                label, path, path.exists()
                            )),
                            Err(e) => trace(&format!("probe {} → ERR {:?}", label, e)),
                        }
                    }
                    trace("FATAL: bundled node.exe not found");
                    return Ok(());
                }
            };

            let (server_script, cwd) = match resolve_server_paths(app) {
                Some(p) => {
                    trace(&format!("server script: {:?} (cwd={:?})", p.0, p.1));
                    p
                }
                None => {
                    trace("FATAL: src/server/index.js not found in resources");
                    return Ok(());
                }
            };

            let log_dir = resolve_log_dir();

            // Redirect server stdout + stderr to a file under the log
            // dir so a crash leaves a trace the user can attach to a
            // bug report. Cheap; the server itself uses pino for
            // structured output, so the file is greppable.
            let log_file_path = log_dir.join("server.log");
            let stdout_file = std::fs::File::create(&log_file_path).ok();

            println!(
                "[tauri-shell] spawning: {:?} {:?} (cwd={:?}, log={:?})",
                node_exe, server_script, cwd, log_file_path
            );

            let mut cmd = Command::new(&node_exe);
            cmd.arg(&server_script)
                .current_dir(&cwd)
                .env("BLASTRADIUS_LOG_DIR", &log_dir)
                .env("BLASTRADIUS_PORT", SERVER_PORT.to_string())
                // Silence the experimental-flag warning Node 20 prints
                // for `--watch`. The server doesn't use --watch itself,
                // but the env var also covers any future experimental
                // flag use down the line.
                .env("NODE_NO_WARNINGS", "1");

            if let Some(ref file) = stdout_file {
                if let Ok(dup) = file.try_clone() {
                    cmd.stdout(std::process::Stdio::from(dup));
                }
                if let Ok(dup) = file.try_clone() {
                    cmd.stderr(std::process::Stdio::from(dup));
                }
            }

            // Suppress the cmd flash window the spawn would otherwise
            // pop up on Windows release builds.
            #[cfg(windows)]
            {
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }

            match cmd.spawn() {
                Ok(child) => {
                    let pid = child.id();
                    *child_for_setup.lock().unwrap() = Some(child);
                    trace(&format!("server spawned, pid={}", pid));
                }
                Err(err) => {
                    trace(&format!(
                        "FATAL: spawn failed: {} (node={:?}, script={:?})",
                        err, node_exe, server_script
                    ));
                }
            }

            Ok(())
        })
        .manage(ExpressServerState {
            child: Arc::clone(&child_arc),
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    let child_for_exit = Arc::clone(&app.state::<ExpressServerState>().child);
    app.run(move |_app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(mut child) = child_for_exit.lock().unwrap().take() {
                let _ = child.kill();
                println!("[tauri-shell] server child terminated");
            }
        }
    });
}
