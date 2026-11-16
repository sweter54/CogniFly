// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Process entry point.
///
/// Call: started by the OS; takes no arguments.
/// Expects: nothing; all setup happens in `cognifly_lib::run`.
/// Output: runs the Tauri event loop until the app quits.
fn main() {
    cognifly_lib::run()
}
