//! Client of the daemon's local API (contract section 9): one JSON
//! line out, one JSON line back, over the Unix socket.
//!
//! Only the commands the app needs are allowed; transport failures
//! become short codes the UI can map to Polish texts.

use serde_json::Value;
use std::path::Path;
use std::time::Duration;

/// Commands the webview may send to the daemon.
pub const ALLOWED: [&str; 9] = [
    "status",
    "lock",
    "release",
    "request-release",
    "history",
    "download",
    "restore",
    "select",
    "unselect",
];
/// Commands that may download a lot and get the long timeout.
const SLOW: [&str; 3] = ["download", "select", "unselect"];
/// Answer timeout of ordinary commands.
const SHORT_WAIT: Duration = Duration::from_secs(10);
/// Answer timeout of `SLOW` commands.
const LONG_WAIT: Duration = Duration::from_secs(120);
/// Longest accepted answer line (without the newline).
const MAX_LINE: u64 = 1024 * 1024;

/// Validates the request's command.
///
/// Call: `command(&req)` before sending or choosing a timeout.
/// Expects: a JSON object with a string `cmd`.
/// Output: the command name when it is in `ALLOWED`, else
/// `Err("BAD_REQUEST")`.
pub fn command(req: &Value) -> Result<&str, String> {
    req.get("cmd")
        .and_then(Value::as_str)
        .filter(|c| ALLOWED.contains(c))
        .ok_or_else(|| "BAD_REQUEST".to_string())
}

/// Answer timeout of a command.
///
/// Call: `timeout_for(cmd)`.
/// Expects: a command name.
/// Output: 120 s for `download`/`select`/`unselect`, else 10 s.
pub fn timeout_for(cmd: &str) -> Duration {
    if SLOW.contains(&cmd) {
        LONG_WAIT
    } else {
        SHORT_WAIT
    }
}

/// Sends one request and reads one answer line.
///
/// Call: `call(&socket, &req, timeout).await`.
/// Expects: a request with an allowed `cmd`; it is checked before
/// any connection is made.
/// Output: the daemon's answer as JSON (also `ok: false`), or
/// `BAD_REQUEST`, `NOT_RUNNING` (no socket / refused), `TIMEOUT`
/// or `BAD_RESPONSE` (not one JSON line within 1 MiB).
pub async fn call(
    path: &Path,
    req: &Value,
    timeout: Duration,
) -> Result<Value, String> {
    command(req)?;
    let mut line = req.to_string();
    line.push('\n');
    tokio::time::timeout(timeout, exchange(path, line.as_bytes()))
        .await
        .map_err(|_| "TIMEOUT".to_string())?
}

/// Connects, writes the request and parses the answer line.
///
/// Call: from `call`, under its timeout.
/// Expects: a request line ending with a newline.
/// Output: the parsed answer, `NOT_RUNNING` when the socket cannot
/// be reached or written, `BAD_RESPONSE` otherwise.
#[cfg(unix)]
async fn exchange(path: &Path, line: &[u8]) -> Result<Value, String> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
    let not_running = |_| "NOT_RUNNING".to_string();
    let bad = || "BAD_RESPONSE".to_string();
    let mut stream = tokio::net::UnixStream::connect(path)
        .await
        .map_err(not_running)?;
    stream.write_all(line).await.map_err(not_running)?;
    let mut answer = Vec::new();
    tokio::io::BufReader::new(&mut stream)
        .take(MAX_LINE + 1)
        .read_until(b'\n', &mut answer)
        .await
        .map_err(|_| bad())?;
    if answer.pop() != Some(b'\n') {
        return Err(bad());
    }
    serde_json::from_slice(&answer).map_err(|_| bad())
}

/// Fallback for platforms without Unix sockets.
///
/// Call: from `call`.
/// Expects: anything.
/// Output: always `Err("NOT_RUNNING")`.
#[cfg(not(unix))]
async fn exchange(_path: &Path, _line: &[u8]) -> Result<Value, String> {
    Err("NOT_RUNNING".to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    /// Returns a fresh, short socket path in the temp directory.
    fn temp_socket() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join(format!("cf-hw-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("hw.sock")
    }

    #[tokio::test]
    async fn call_returns_daemon_line_unchanged() {
        let path = temp_socket();
        let listener = UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (r, mut w) = stream.into_split();
            let mut line = String::new();
            BufReader::new(r).read_line(&mut line).await.unwrap();
            assert_eq!(line, "{\"cmd\":\"status\"}\n");
            w.write_all(b"{\"ok\":true,\"running\":true}\n")
                .await
                .unwrap();
        });
        let got = call(&path, &json!({"cmd": "status"}), Duration::from_secs(5))
            .await;
        assert_eq!(got, Ok(json!({"ok": true, "running": true})));
    }

    #[tokio::test]
    async fn call_times_out() {
        let path = temp_socket();
        let listener = UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let got =
            call(&path, &json!({"cmd": "status"}), Duration::from_millis(200))
                .await;
        assert_eq!(got, Err("TIMEOUT".to_string()));
    }

    #[tokio::test]
    async fn call_without_socket_is_not_running() {
        let path = temp_socket();
        let got = call(&path, &json!({"cmd": "status"}), Duration::from_secs(1))
            .await;
        assert_eq!(got, Err("NOT_RUNNING".to_string()));
    }

    #[tokio::test]
    async fn call_rejects_unknown_cmd_before_connecting() {
        let path = temp_socket();
        let listener = UnixListener::bind(&path).unwrap();
        for req in [json!({"cmd": "wait"}), json!({"x": 1}), json!("status")] {
            let got = call(&path, &req, Duration::from_secs(1)).await;
            assert_eq!(got, Err("BAD_REQUEST".to_string()));
        }
        let accepted = tokio::time::timeout(
            Duration::from_millis(100),
            listener.accept(),
        )
        .await;
        assert!(accepted.is_err(), "no connection may be made");
    }

    #[tokio::test]
    async fn call_rejects_non_json_answer() {
        let path = temp_socket();
        let listener = UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            stream.write_all(b"nope\n").await.unwrap();
            stream.shutdown().await.unwrap();
        });
        let got = call(&path, &json!({"cmd": "status"}), Duration::from_secs(5))
            .await;
        assert_eq!(got, Err("BAD_RESPONSE".to_string()));
    }

    #[test]
    fn long_commands_get_long_timeout() {
        assert_eq!(timeout_for("status"), Duration::from_secs(10));
        for cmd in ["download", "select", "unselect"] {
            assert_eq!(timeout_for(cmd), Duration::from_secs(120));
        }
    }
}
