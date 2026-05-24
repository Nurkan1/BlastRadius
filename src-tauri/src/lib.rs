use std::process::{Command, Child};
use std::sync::{Arc, Mutex};
use std::net::TcpStream;
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

fn is_port_in_use(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

struct ExpressServerState {
    child: Arc<Mutex<Option<Child>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let child_arc = Arc::new(Mutex::new(None));
  let child_arc_clone = Arc::clone(&child_arc);

  let app = tauri::Builder::default()
    .setup(move |app| {
      if cfg!(debug_assertions) {
        let _ = app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        );
      }

      use tauri::path::BaseDirectory;

      let current_dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
      
      // Attempt to resolve the server script path robustly
      let mut server_dir = current_dir.clone();
      let mut found = false;

      // 1. Walk up from current working directory to look for src/server/index.js (development fallback)
      for _ in 0..5 {
          if server_dir.join("src/server/index.js").exists() {
              found = true;
              break;
          }
          if !server_dir.pop() {
              break;
          }
      }

      let (final_cwd, server_script) = if found {
          (server_dir, std::path::PathBuf::from("src/server/index.js"))
      } else {
          // 2. Resolve via Tauri Resource directory (production bundled path)
          if let Ok(resource_path) = app.path().resolve("src/server/index.js", BaseDirectory::Resource) {
              if resource_path.exists() {
                  let mut dir = resource_path.clone();
                  dir.pop(); // Pop index.js
                  dir.pop(); // Pop server
                  dir.pop(); // Pop src
                  (dir, resource_path)
              } else {
                  (current_dir.clone(), std::path::PathBuf::from("src/server/index.js"))
              }
          } else {
              (current_dir.clone(), std::path::PathBuf::from("src/server/index.js"))
          }
      };

      let mut log_dir = std::env::var("USERPROFILE")
          .map(std::path::PathBuf::from)
          .unwrap_or_else(|_| {
              std::env::var("HOME")
                  .map(std::path::PathBuf::from)
                  .unwrap_or_else(|_| std::path::PathBuf::from("."))
          });
      log_dir.push(".blastradius");
      log_dir.push("logs");
      let log_dir_str = log_dir.to_string_lossy().to_string();

      // Ensure the log directory exists
      let _ = std::fs::create_dir_all(&log_dir);
      
      // Attempt to open/create the server log file for redirecting stdout and stderr
      let stdout_file = std::fs::File::create(log_dir.join("server.log")).ok();

      println!("Express server resolved path: script={:?}, cwd={:?}", server_script, final_cwd);
      println!("Express server logging to: {:?}", log_dir.join("server.log"));

      // Spawn Node.js Express server in the background if not already running
      if is_port_in_use(7842) {
          println!("BlastRadius server is already running on port 7842. Skipping background spawn.");
      } else {
          let mut cmd = Command::new("node");
          cmd.arg(&server_script)
             .current_dir(&final_cwd)
             .env("BLASTRADIUS_LOG_DIR", &log_dir_str)
             .env("BLASTRADIUS_PORT", "7842");

          if let Some(ref file) = stdout_file {
              if let Ok(clone) = file.try_clone() {
                  cmd.stdout(std::process::Stdio::from(clone));
              }
              if let Ok(clone) = file.try_clone() {
                  cmd.stderr(std::process::Stdio::from(clone));
              }
          }

          #[cfg(windows)]
          {
              const CREATE_NO_WINDOW: u32 = 0x08000000;
              cmd.creation_flags(CREATE_NO_WINDOW);
          }

          match cmd.spawn() {
              Ok(child) => {
                  *child_arc.lock().unwrap() = Some(child);
                  println!("BlastRadius server spawned in background by Tauri.");
              }
              Err(e) => {
                  eprintln!("Failed to spawn BlastRadius server: {}", e);
              }
          }
      }

      Ok(())
    })
    .manage(ExpressServerState { child: child_arc_clone })
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  let child_arc_exit = Arc::clone(&app.state::<ExpressServerState>().child);
  app.run(move |_app_handle, event| {
    if let tauri::RunEvent::Exit = event {
      if let Some(mut child) = child_arc_exit.lock().unwrap().take() {
        let _ = child.kill();
        println!("BlastRadius server process terminated by Tauri.");
      }
    }
  });
}
