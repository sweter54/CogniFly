//! Heartwood file sync: the daemon as a supervised child process and
//! its local socket API, exposed to the background window only.
//!
//! Errors are short codes (`DISABLED`, `NOT_INSTALLED`, `BAD_REQUEST`,
//! `NOT_RUNNING`, `TIMEOUT`, `BAD_RESPONSE`) mapped to Polish texts
//! by the UI.

pub mod config;
pub mod socket;
pub mod supervisor;
#[cfg(all(test, unix))]
mod testutil;

use serde_json::Value;
use std::path::Path;
use supervisor::{HeartwoodInfo, Launch, Phase, Supervisor};
use tauri::State;

/// Resolves config and binary and writes the config file.
///
/// Call: `prepare(server_url, ws_url, org, root)`.
/// Expects: the URLs built into the app (empty = disabled) and the
/// sync root chosen by CogniFly.
/// Output: the launch (root kept out of the work folder's git), or
/// `DISABLED`, `BAD_ROOT`, `ROOT_TOO_LONG`, `NOT_INSTALLED`,
/// `NO_EXE`, `CONFIG_WRITE`.
fn prepare(
    server_url: &str,
    ws_url: &str,
    org: &str,
    root: &str,
) -> Result<Launch, String> {
    let resolved =
        config::resolve(server_url, ws_url, org, Path::new(root))?;
    config::exclude_from_git(&resolved.root);
    let bin = config::find_binary()?;
    config::write(&resolved)?;
    Ok(Launch { bin, config: resolved })
}

/// Starts the daemon (or keeps the running one).
///
/// Call: `invoke('heartwood_start', { serverUrl, wsUrl, org, root })`.
/// Expects: the background window; a session already exists, since
/// the daemon asks this app for tokens.
/// Output: the state; the same data again is a no-op, other data
/// restarts the daemon. `DISABLED` / `NOT_INSTALLED` also stop a
/// running daemon and are reported by `heartwood_info`.
#[tauri::command]
pub async fn heartwood_start(
    server_url: String,
    ws_url: String,
    org: String,
    root: String,
    sup: State<'_, Supervisor>,
) -> Result<HeartwoodInfo, String> {
    match prepare(&server_url, &ws_url, &org, &root) {
        Ok(launch) => Ok(sup.start(launch).await),
        Err(code) => {
            if let Some(phase) = Phase::for_error(&code) {
                sup.stop(phase).await;
                sup.note_error(&code);
            }
            Err(code)
        }
    }
}

/// Stops the daemon (logout).
///
/// Call: `invoke('heartwood_stop')`.
/// Expects: nothing; stopping twice is fine.
/// Output: `Ok(())` once the child is killed.
#[tauri::command]
pub async fn heartwood_stop(sup: State<'_, Supervisor>) -> Result<(), String> {
    sup.stop(Phase::Disabled).await;
    Ok(())
}

/// Reports the daemon state.
///
/// Call: `invoke('heartwood_info')`.
/// Expects: nothing.
/// Output: `{ state, root, restarts, lastError }`.
#[tauri::command]
pub fn heartwood_info(sup: State<'_, Supervisor>) -> HeartwoodInfo {
    sup.info()
}

/// Sends one local API request to the daemon.
///
/// Call: `invoke('heartwood_call', { request: { cmd: 'status' } })`.
/// Expects: a request whose `cmd` is in `socket::ALLOWED`.
/// Output: the daemon's answer (also `ok: false`); `BAD_REQUEST`,
/// `NOT_RUNNING`, `TIMEOUT` (10 s, 120 s for long commands) or
/// `BAD_RESPONSE`.
#[tauri::command]
pub async fn heartwood_call(
    request: Value,
    sup: State<'_, Supervisor>,
) -> Result<Value, String> {
    let timeout = socket::timeout_for(socket::command(&request)?);
    let path = sup.socket().ok_or_else(|| "NOT_RUNNING".to_string())?;
    socket::call(&path, &request, timeout).await
}
