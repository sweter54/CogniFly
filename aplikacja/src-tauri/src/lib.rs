//! Thin native layer of the CogniFly desktop app.
//!
//! Only wiring lives here: official plugins (HTTP, notifications, log,
//! opener for `claude://` links only),
//! the keychain commands and window behaviour. All business logic is in
//! the TypeScript UI (`aplikacja/src`).

mod vault;

use tauri::{AppHandle, Manager, RunEvent, Runtime, Window, WindowEvent};

/// Label of the hidden window that owns the session and the tray icon.
const BACKGROUND_WINDOW: &str = "background";
/// Label of the visible main window.
const MAIN_WINDOW: &str = "main";

/// Shows or hides the app in the Dock and the Cmd+Tab switcher.
///
/// Call: `set_in_dock(&app, true)` when the main window gets focus,
/// `false` when it is hidden.
/// Expects: macOS; a no-op elsewhere.
/// Output: switches the activation policy (Regular / Accessory), so
/// the open window can always be found, while a closed one leaves
/// only the menu-bar icon.
fn set_in_dock<R: Runtime>(app: &AppHandle<R>, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        let policy = if visible {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        let _ = app.set_activation_policy(policy);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, visible);
}

/// Window behaviour: hide instead of close, Dock presence.
///
/// Call: from the window-event hook with the window and its event.
/// Expects: any window; the background window is never shown.
/// Output: `CloseRequested` on a UI window hides it (it can be shown
/// again from the tray) and removes the Dock icon; focusing the main
/// window adds the Dock icon and Cmd+Tab entry.
fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() == BACKGROUND_WINDOW {
        return;
    }
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = window.hide();
            set_in_dock(window.app_handle(), false);
        }
        WindowEvent::Focused(true) if window.label() == MAIN_WINDOW => {
            set_in_dock(window.app_handle(), true);
        }
        _ => {}
    }
}

/// Brings the main window to the front.
///
/// Call: `show_main(&app)` when the Dock icon is clicked or the app
/// is launched a second time (single instance).
/// Expects: the `main` window from tauri.conf.json.
/// Output: none; the window is shown, unminimised and focused.
fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Handles app-level events.
///
/// Call: from the run loop with each event.
/// Expects: any event.
/// Output: a Dock-icon click (`Reopen`) shows the main window.
fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: RunEvent) {
    #[cfg(target_os = "macos")]
    if let RunEvent::Reopen { .. } = event {
        show_main(app);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

/// Configures logging (stdout + log file in the app log directory).
///
/// Call: `log_plugin()` while building the app.
/// Expects: nothing.
/// Output: the official log plugin at `Info` level. Webview errors
/// are forwarded here by the UI; tokens are never logged.
fn log_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
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
/// Output: blocks until quit. Starts as a menu-bar app; the Dock icon
/// appears only while the main window is open; only one instance runs.
/// Panics only if Tauri fails to start.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin: a second launch only focuses us.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(log_plugin())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            vault::vault_read,
            vault::vault_write,
            vault::vault_delete
        ])
        .setup(|app| {
            set_in_dock(app.handle(), false);
            Ok(())
        })
        .on_window_event(on_window_event)
        .build(tauri::generate_context!())
        .expect("failed to start CogniFly")
        .run(on_run_event);
}
