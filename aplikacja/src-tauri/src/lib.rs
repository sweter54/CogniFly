//! Thin native layer of the CogniFly desktop app.
//!
//! Only wiring lives here: official plugins (HTTP, notifications), the
//! keychain commands and window behaviour. All business logic is in the
//! TypeScript UI (`aplikacja/src`).

mod vault;

use tauri::WindowEvent;

/// Label of the hidden window that owns the session and the tray icon.
const BACKGROUND_WINDOW: &str = "background";

/// Hides a UI window instead of closing it.
///
/// Call: from the window-event hook with the window and its event.
/// Expects: any window; the background window is never shown, so it is
/// left alone.
/// Output: for `CloseRequested` on UI windows, prevents the close and
/// hides the window, so it can be shown again from the tray menu.
fn hide_on_close(window: &tauri::Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.label() != BACKGROUND_WINDOW {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

/// Configures logging (stdout + log file in the app log directory).
///
/// Call: `log_plugin()` while building the app.
/// Expects: nothing.
/// Output: the official log plugin at `Info` level. Webview errors
/// are forwarded here by the UI; tokens are never logged.
fn log_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri_plugin_log::{Target, TargetKind};
    tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir { file_name: None }),
        ])
        .build()
}

/// Builds and runs the application.
///
/// Call: `run()` from `main`.
/// Expects: `tauri.conf.json` and capabilities in `src-tauri`.
/// Output: blocks until quit. On macOS the app runs as a menu-bar
/// accessory (no Dock icon). Panics only if Tauri fails to start.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(log_plugin())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            vault::vault_read,
            vault::vault_write,
            vault::vault_delete
        ])
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            _app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            Ok(())
        })
        .on_window_event(hide_on_close)
        .run(tauri::generate_context!())
        .expect("failed to start CogniFly");
}
