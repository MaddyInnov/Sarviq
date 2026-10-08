// SPDX-License-Identifier: Apache-2.0
// Prevents additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

/// Fixed loopback port the desktop backend listens on.
/// The bundled frontend detects Tauri (`window.__TAURI__`) and calls
/// `http://127.0.0.1:DESKTOP_API_PORT` for all API traffic.
const DESKTOP_API_PORT: &str = "4567";

struct SidecarState(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            // Data directory for SQLite DBs + providers.local.json (0600).
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&data_dir).expect("failed to create app data dir");

            // Spawn the runtime API as a Tauri sidecar. The sidecar binary is
            // produced by `scripts/build-desktop.sh` (bun --compile) and placed at
            // src-tauri/binaries/mvp-api-<target-triple>[.exe].
            // NOTE: verify the spawn/sidecar API against the installed
            // tauri-plugin-shell version when building with the Rust toolchain.
            let (mut _rx, child) = app
                .shell()
                .sidecar("mvp-api")
                .expect("failed to locate mvp-api sidecar")
                .args(["--port", DESKTOP_API_PORT])
                .env(
                    "DATA_DIR",
                    data_dir.to_string_lossy().to_string(),
                )
                .spawn()
                .expect("failed to spawn mvp-api sidecar");

            // Keep the child handle alive so the sidecar isn't reaped early.
            // tauri-plugin-shell also terminates sidecars when the app exits.
            if let Some(state) = app.try_state::<SidecarState>() {
                *state.0.lock().unwrap() = Some(child);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
