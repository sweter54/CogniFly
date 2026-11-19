//! File picker shown over the visible main window.
//!
//! The JS dialog API attaches the panel to the calling window. File
//! actions run in the hidden background window, so a panel opened
//! there can stay invisible while the app waits for it. This command
//! shows the main window and attaches the panel to it instead.

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

/// Label of the visible main window (tauri.conf.json).
const MAIN_WINDOW: &str = "main";

/// Lets the user pick files, starting in `root`.
///
/// Call: `invoke('pick_files', { root })` from the background window.
/// Expects: an absolute folder to start in (`''`: the OS default).
/// Output: the chosen absolute paths, `[]` when cancelled. The main
/// window is shown and focused first and is the panel's parent.
#[tauri::command]
pub async fn pick_files<R: Runtime>(
    app: AppHandle<R>,
    root: String,
) -> Result<Vec<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Wybierz pliki");
    if !root.is_empty() {
        dialog = dialog.set_directory(&root);
    }
    if let Some(main) = app.get_webview_window(MAIN_WINDOW) {
        let _ = main.show();
        let _ = main.set_focus();
        dialog = dialog.set_parent(&main);
    }
    dialog.pick_files(move |picked| {
        let _ = tx.send(picked);
    });
    let picked = rx.await.map_err(|_| "PICKER".to_string())?;
    Ok(paths_of(picked))
}

/// Lets the user pick one folder, starting in `start`.
///
/// Call: `invoke('pick_folder', { start, title })` from the background
/// window.
/// Expects: a start folder (`''`: the OS default) and a panel title.
/// Output: the chosen absolute folder, `None` when cancelled; shown
/// over the main window like `pick_files`.
#[tauri::command]
pub async fn pick_folder<R: Runtime>(
    app: AppHandle<R>,
    start: String,
    title: String,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title(title);
    if !start.is_empty() {
        dialog = dialog.set_directory(&start);
    }
    if let Some(main) = app.get_webview_window(MAIN_WINDOW) {
        let _ = main.show();
        let _ = main.set_focus();
        dialog = dialog.set_parent(&main);
    }
    dialog.pick_folder(move |picked| {
        let _ = tx.send(picked);
    });
    let picked = rx.await.map_err(|_| "PICKER".to_string())?;
    Ok(paths_of(picked.map(|p| vec![p])).into_iter().next())
}

/// Turns the dialog result into plain path strings.
///
/// Call: `paths_of(picked)`.
/// Expects: the callback value of `pick_files`.
/// Output: absolute paths; entries that are not file paths dropped.
fn paths_of(picked: Option<Vec<tauri_plugin_dialog::FilePath>>) -> Vec<String> {
    picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tauri_plugin_dialog::FilePath;

    #[test]
    fn cancelled_gives_no_paths() {
        assert!(paths_of(None).is_empty());
    }

    #[test]
    fn picked_paths_are_kept() {
        let p = FilePath::Path(PathBuf::from("/r/a.txt"));
        assert_eq!(paths_of(Some(vec![p])), vec!["/r/a.txt".to_string()]);
    }
}
