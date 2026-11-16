//! OS keychain access for the single CogniFly session entry.
//!
//! The webview never chooses the service or account name: every command
//! works on one fixed entry, so a compromised page cannot read other
//! keychain items. Values are opaque strings (JSON built by the UI).
//! Nothing here logs the stored value.

use keyring::Entry;

/// Keychain service name (matches the bundle identifier).
const SERVICE: &str = "pl.cognifly.aplikacja";
/// Keychain account name of the session entry.
const ACCOUNT: &str = "sesja";
/// Upper bound for a stored value; Cognito tokens are a few KB.
const MAX_VALUE_BYTES: usize = 32 * 1024;

/// Opens the fixed keychain entry.
///
/// Call: `entry()`.
/// Expects: the platform credential store to be available.
/// Output: the entry handle, or a short error code string
/// (`VAULT_UNAVAILABLE`) that is safe to show in the UI.
fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|_| "VAULT_UNAVAILABLE".to_string())
}

/// Reads the stored session.
///
/// Call: from the webview as `invoke('vault_read')`.
/// Expects: nothing; a missing entry is not an error.
/// Output: `Some(value)` when stored, `None` when absent,
/// `Err("VAULT_ERROR")` when the keychain refuses access.
#[tauri::command]
pub fn vault_read() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("VAULT_ERROR".to_string()),
    }
}

/// Stores (replaces) the session.
///
/// Call: `invoke('vault_write', { value })`.
/// Expects: `value` non-empty and at most `MAX_VALUE_BYTES` bytes.
/// Output: `Ok(())` once written; `Err("VAULT_BAD_VALUE")` for an
/// empty or oversized value; `Err("VAULT_ERROR")` on keychain failure.
#[tauri::command]
pub fn vault_write(value: String) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_VALUE_BYTES {
        return Err("VAULT_BAD_VALUE".to_string());
    }
    entry()?
        .set_password(&value)
        .map_err(|_| "VAULT_ERROR".to_string())
}

/// Deletes the stored session (logout).
///
/// Call: `invoke('vault_delete')`.
/// Expects: nothing; deleting a missing entry succeeds.
/// Output: `Ok(())`, or `Err("VAULT_ERROR")` on keychain failure.
#[tauri::command]
pub fn vault_delete() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("VAULT_ERROR".to_string()),
    }
}
