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

/// Minimum remaining validity for the Heartwood token command.
const TOKEN_MIN_LEFT_MS: u64 = 10_000;

/// Extracts a still-valid access token from the session JSON.
///
/// Call: `fresh_access_token(raw, now_ms, min_left_ms)`.
/// Expects: `raw` is the session JSON written by the UI
/// (`accessToken`, `expiresAt` in epoch milliseconds).
/// Output: the token, or `None` for bad JSON, missing/empty fields,
/// or fewer than `min_left_ms` milliseconds of validity left.
pub fn fresh_access_token(raw: &str, now_ms: u64, min_left_ms: u64) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(raw).ok()?;
    let token = json.get("accessToken")?.as_str().filter(|t| !t.is_empty())?;
    let expires = json.get("expiresAt")?.as_f64()?;
    let left = expires - now_ms as f64;
    (left >= min_left_ms as f64).then(|| token.to_string())
}

/// Current time as epoch milliseconds.
///
/// Call: `now_ms()`.
/// Expects: a system clock after 1970.
/// Output: milliseconds since the Unix epoch (0 if the clock is odd).
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Heartwood `token_command`: prints the access token to stdout.
///
/// Call: `std::process::exit(print_token())` from `main`.
/// Expects: nothing; no session or a near-expired token is normal.
/// Output: exit code 0 after printing `<token>\n` to stdout; exit
/// code 1 with nothing printed otherwise. The token goes nowhere else.
pub fn print_token() -> i32 {
    let token = entry()
        .ok()
        .and_then(|e| e.get_password().ok())
        .and_then(|raw| fresh_access_token(&raw, now_ms(), TOKEN_MIN_LEFT_MS));
    match token {
        Some(t) => {
            println!("{t}");
            0
        }
        None => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::fresh_access_token;

    const NOW: u64 = 1_000_000;

    fn session(expires_at: u64) -> String {
        format!(r#"{{"accessToken":"tok","refreshToken":"r","expiresAt":{expires_at},"email":"a@b"}}"#)
    }

    #[test]
    fn returns_token_with_enough_validity() {
        assert_eq!(fresh_access_token(&session(NOW + 60_000), NOW, 10_000), Some("tok".into()));
    }

    #[test]
    fn rejects_token_close_to_expiry() {
        assert_eq!(fresh_access_token(&session(NOW + 5_000), NOW, 10_000), None);
    }

    #[test]
    fn rejects_expired_token() {
        assert_eq!(fresh_access_token(&session(NOW - 1), NOW, 10_000), None);
    }

    #[test]
    fn rejects_missing_token_or_bad_json() {
        assert_eq!(fresh_access_token(r#"{"expiresAt":99999999}"#, NOW, 10_000), None);
        assert_eq!(fresh_access_token("not json", NOW, 10_000), None);
    }
}
