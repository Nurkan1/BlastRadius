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
use std::time::{Duration, Instant};

use tauri::path::BaseDirectory;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Port the Express server binds to. Mirrored in tauri.conf.json's
/// `frontendDist` / `devUrl`. Keep these three in sync if you ever
/// change it.
const SERVER_PORT: u16 = 7842;

/// How long to wait for the sidecar server to start before the splash
/// shows an error instead of spinning forever. 30 s covers a cold
/// first-run where dependency-cruiser builds the import graph on a
/// slow disk.
const SPLASH_TIMEOUT_SECS: u64 = 30;

/// Self-contained splash document. Shown while the sidecar Node server
/// boots, because the main window points at http://localhost:7842 and
/// WebView2 would otherwise paint its own ERR_CONNECTION_REFUSED page
/// (the "no connection" error) during the ~1-3 s the server takes to
/// start. No external assets, no fetch (CORS on the server is
/// same-origin-only — see src/server/security.js — so the splash can't
/// poll it from the browser; the Rust side does the readiness poll
/// natively over TCP instead). Rust calls `window.__brTimeout()` via
/// eval if the server never comes up.
const SPLASH_HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0d1117;color:#e6edf3;font-family:system-ui,'Segoe UI',sans-serif;overflow:hidden;user-select:none}
.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px}
.logo{font-size:40px;line-height:1}
.title{font-size:22px;font-weight:600;letter-spacing:.5px}
.title .accent{color:#f97316}
.spinner{width:26px;height:26px;border:3px solid rgba(255,255,255,.14);border-top-color:#f97316;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.msg{font-size:12px;color:#8b949e}
.err{display:none;font-size:12px;color:#ff9b94;max-width:340px;text-align:center;line-height:1.5;padding:0 24px}
.ver{position:fixed;bottom:14px;left:0;right:0;text-align:center;font-size:11px;color:#586069;letter-spacing:.3px}
</style></head><body>
<div class="wrap">
<div class="logo">&#9889;</div>
<div class="title">Blast<span class="accent">Radius</span></div>
<div class="spinner" id="sp"></div>
<div class="msg" id="msg">Starting the dashboard server&hellip;</div>
<div class="err" id="err"></div>
</div>
<div class="ver">v{{VERSION}}</div>
<script>
window.__brTimeout=function(){
var sp=document.getElementById('sp');if(sp)sp.style.display='none';
var msg=document.getElementById('msg');if(msg)msg.style.display='none';
var err=document.getElementById('err');
if(err){err.style.display='block';err.textContent='The server is taking longer than expected to start. Check ~/.blastradius/logs/server.log, then restart BlastRadius.';}
};
</script>
</body></html>"#;

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
/// ONE stable location — `~/.blastradius/logs` — shared by the server and
/// every observed repo's hook, regardless of which repo is active at boot.
/// An explicit `BLASTRADIUS_LOG_DIR` still overrides (dev / run.bat).
///
/// rc9.12: this used to prefer `<currentRepo>/logs` (read from
/// preferences.json) to match `install-hook.ps1`'s old default. But that was
/// resolved ONCE at startup from whatever repo happened to be current then,
/// so after an auto-switch the hook (writing `<new-repo>/logs`) and the
/// server (still reading the boot repo's dir, or the fallback) pointed at
/// different folders and the dashboard went empty. install-hook.ps1 and the
/// dashboard auto-installer now both target `~/.blastradius/logs`, so the
/// server canonicalises there too — no repo-dependent heuristic.
fn resolve_log_dir() -> PathBuf {
    if let Some(env) = std::env::var_os("BLASTRADIUS_LOG_DIR") {
        let p = PathBuf::from(env);
        let _ = std::fs::create_dir_all(&p);
        return p;
    }
    let mut base = home_dir();
    base.push(".blastradius");
    base.push("logs");
    let _ = std::fs::create_dir_all(&base);
    trace(&format!("log dir: {:?}", base));
    base
}

/// %USERPROFILE% on Windows, $HOME elsewhere, "." as a last resort.
fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
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

/// Reveal the (initially hidden) main window and give it focus. Called
/// either immediately (when a server was already running) or by the
/// readiness-poll thread once the sidecar starts answering.
fn reveal_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // CRITICAL: the main window is created hidden at startup, but its
        // webview navigates to http://localhost:7842 IMMEDIATELY — while
        // the sidecar is still booting. That navigation fails
        // (ERR_CONNECTION_REFUSED) and the webview parks on WebView2's
        // error page; webviews do NOT auto-retry a failed navigation. So
        // a bare show() would reveal that stale error page, not the
        // dashboard — shipping the very "no connection" bug this splash
        // is meant to fix, just deferred. Force a fresh navigation now
        // that the server answers. `navigate()` is a native call, so it
        // works even when the current document is the error page (unlike
        // eval'ing window.location, which the error page may not honor).
        if let Ok(url) = format!("http://localhost:{}", SERVER_PORT).parse() {
            let _ = w.navigate(url);
        }
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Write the splash document to a temp file and open it in a small,
/// borderless, always-on-top window. file:// is used (not data:)
/// because WebView2 reliably renders file:// as a top-level document
/// whereas data: URLs are sometimes blocked. Best-effort: any failure
/// here just means no splash (the poll thread still reveals main).
fn open_splash(app: &tauri::AppHandle) {
    let mut path = std::env::temp_dir();
    path.push("blastradius-splash.html");
    // rc9.10: stamp the app version into the splash so it's visible at boot.
    let html = SPLASH_HTML.replace("{{VERSION}}", env!("CARGO_PKG_VERSION"));
    if std::fs::write(&path, html).is_err() {
        trace("splash: failed to write temp html");
        return;
    }
    let url = format!("file:///{}", path.to_string_lossy().replace('\\', "/"));
    match url.parse() {
        Ok(parsed) => {
            let built = WebviewWindowBuilder::new(app, "splash", WebviewUrl::External(parsed))
                .title("BlastRadius")
                .inner_size(420.0, 300.0)
                .resizable(false)
                .decorations(false)
                .center()
                .always_on_top(true)
                .build();
            if let Err(e) = built {
                trace(&format!("splash: build failed: {}", e));
            }
        }
        Err(e) => trace(&format!("splash: url parse failed: {}", e)),
    }
}

/// Background readiness poll. Every 250 ms checks whether the sidecar
/// is answering on SERVER_PORT (a successful TCP connect — the server
/// only calls listen() after all async init finishes, so an open port
/// means "ready to serve"). On ready: reveal main + close splash. On
/// timeout: flip the splash to its error state via eval.
fn spawn_readiness_poll(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(SPLASH_TIMEOUT_SECS);
        loop {
            if is_port_in_use(SERVER_PORT) {
                trace("readiness poll: server is up");
                // Navigate the (still-hidden, still-on-the-error-page) main
                // webview to the now-live server, give the dashboard a beat
                // to paint BEHIND the splash, then reveal it and close the
                // splash. Doing the paint behind the splash avoids a white
                // flash in the transition. Safe to sleep here — this is a
                // background thread, not the UI/setup thread.
                if let Some(w) = app.get_webview_window("main") {
                    if let Ok(url) = format!("http://localhost:{}", SERVER_PORT).parse() {
                        let _ = w.navigate(url);
                    }
                    std::thread::sleep(Duration::from_millis(600));
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                if let Some(splash) = app.get_webview_window("splash") {
                    let _ = splash.close();
                }
                break;
            }
            if Instant::now() >= deadline {
                trace("readiness poll: TIMEOUT — server never came up");
                if let Some(splash) = app.get_webview_window("splash") {
                    let _ = splash.eval("window.__brTimeout && window.__brTimeout()");
                } else {
                    // No splash to show the error in — reveal main as a
                    // last resort so the user isn't left with nothing.
                    reveal_main(&app);
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    });
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
            // terminal and forgot. The server is ready NOW, so reveal
            // the main window immediately and skip the splash.
            if is_port_in_use(SERVER_PORT) {
                trace(&format!("port {} already in use → reusing", SERVER_PORT));
                reveal_main(app.handle());
                return Ok(());
            }

            // Server is NOT up yet — show the splash before anything that
            // can fail, so even a spawn failure surfaces the splash's
            // timeout error message instead of a hidden window + Edge
            // ERR_CONNECTION_REFUSED.
            open_splash(app.handle());

            // Start the readiness poll IMMEDIATELY — before node/script
            // resolution. It only checks the port, so it's independent of
            // whether the spawn below succeeds. If a FATAL branch returns
            // early (node.exe missing, etc.), the poll still runs and
            // times out into the splash's error state rather than spinning
            // forever. If the spawn succeeds, the poll reveals main and
            // closes the splash the moment the sidecar answers.
            spawn_readiness_poll(app.handle().clone());

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// is_port_in_use() is the readiness primitive the splash poll
    /// loop depends on. Verify it reports true for a bound port and
    /// false for a free one. We bind an ephemeral port (0 → OS picks)
    /// to avoid colliding with a real server on SERVER_PORT.
    #[test]
    fn port_in_use_detects_a_bound_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
        let port = listener.local_addr().unwrap().port();
        assert!(
            is_port_in_use(port),
            "expected is_port_in_use(true) for a bound listener on {}",
            port
        );
    }

    #[test]
    fn port_in_use_is_false_for_a_free_port() {
        // Bind then immediately drop to free a port we know nothing
        // else is on, then assert the probe reports it closed.
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
            listener.local_addr().unwrap().port()
        }; // listener dropped here → port released
        assert!(
            !is_port_in_use(port),
            "expected is_port_in_use(false) for a released port {}",
            port
        );
    }
}
