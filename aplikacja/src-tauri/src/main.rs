// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Process entry point.
///
/// Call: started by the OS; takes no arguments.
/// Expects: nothing; all setup happens in `cognifly_lib::run`.
/// Output: with the `heartwood-token` argument, prints the access
/// token and exits (no Tauri, no single-instance); otherwise runs the
/// Tauri event loop until the app quits.
fn main() {
    if std::env::args().nth(1).as_deref() == Some(cognifly_lib::TOKEN_ARG) {
        std::process::exit(cognifly_lib::vault::print_token());
    }
    cognifly_lib::run()
}
