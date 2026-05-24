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

/// Resolve the absolute path to the bundled `node.exe`. In dev (running
/// from `npx tauri dev`) the resource is alongside the source tree; in
/// a packaged build it lives under the app's resource directory. Tauri
/// abstracts both via `BaseDirectory::Resource`.
fn resolve_node_exe(app: &tauri::App) -> Option<PathBuf> {
    let candidates = ["binaries/node.exe", "binaries\\node.exe"];
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
/// `node_modules`.
fn resolve_server_paths(app: &tauri::App) -> Option<(PathBuf, PathBuf)> {
    let script = app
        .path()
        .resolve("src/server/index.js", BaseDirectory::Resource)
        .ok()?;
    if !script.exists() {
        return None;
    }
    // cwd = the resource root (three pops: index.js → server → src → root)
    let mut cwd = script.clone();
    cwd.pop();
    cwd.pop();
    cwd.pop();
    Some((script, cwd))
}

/// Where to put the daily JSONL logs the hook writes. We default to
/// `%USERPROFILE%\.blastradius\logs` so the path is stable across app
/// updates and doesn't get wiped when the user reinstalls.
fn resolve_log_dir() -> PathBuf {
    let mut base = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    base.push(".blastradius");
    base.push("logs");
    let _ = std::fs::create_dir_all(&base);
    base
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let child_arc: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let child_for_setup = Arc::clone(&child_arc);

    let app = tauri::Builder::default()
        .setup(move |app| {
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
                println!(
                    "[tauri-shell] something is already on :{}, will reuse it",
                    SERVER_PORT
                );
                return Ok(());
            }

            let node_exe = match resolve_node_exe(app) {
                Some(p) => p,
                None => {
                    eprintln!(
                        "[tauri-shell] FATAL: bundled node.exe not found. \
                        Run scripts/prepare-bundle.bat before `tauri build`."
                    );
                    return Ok(());
                }
            };

            let (server_script, cwd) = match resolve_server_paths(app) {
                Some(p) => p,
                None => {
                    eprintln!(
                        "[tauri-shell] FATAL: src/server/index.js not found in resources."
                    );
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
                    *child_for_setup.lock().unwrap() = Some(child);
                    println!("[tauri-shell] server spawned");
                }
                Err(err) => {
                    eprintln!(
                        "[tauri-shell] failed to spawn server: {} (node={:?}, script={:?})",
                        err, node_exe, server_script
                    );
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
