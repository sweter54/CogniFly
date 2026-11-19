//! Client of the daemon's local API (contract section 9): one JSON
//! line out, one JSON line back, over the Unix socket.
//!
//! Only the commands the app needs are allowed; transport failures
//! become short codes the UI can map to Polish texts.

use serde_json::Value;
use std::path::Path;
use std::time::Duration;

/// Commands the webview may send to the daemon.
pub const ALLOWED: [&str; 11] = [
    "status",
    "lock",
    "release",
    "request-release",
    "history",
    "download",
    "restore",
    "select",
    "unselect",
    "files",
    "work-files",
];
/// Commands that may download a lot and get the long timeout.
const SLOW: [&str; 3] = ["download", "select", "unselect"];
/// Commands that may ask the server and get the medium timeout.
const MEDIUM: [&str; 2] = ["files", "work-files"];
/// Answer timeout of ordinary commands.
const SHORT_WAIT: Duration = Duration::from_secs(10);
/// Answer timeout of `MEDIUM` commands.
const MEDIUM_WAIT: Duration = Duration::from_secs(30);
/// Answer timeout of `SLOW` commands.
const LONG_WAIT: Duration = Duration::from_secs(120);
/// Answer timeout of a liveness probe.
const PROBE_WAIT: Duration = Duration::from_secs(1);
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
/// Output: 120 s for `download`/`select`/`unselect`, 30 s for
/// `files`/`work-files`, else 10 s.
pub fn timeout_for(cmd: &str) -> Duration {
    if SLOW.contains(&cmd) {
        LONG_WAIT
    } else if MEDIUM.contains(&cmd) {
        MEDIUM_WAIT
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

/// Tells whether a daemon answers on the socket.
///
/// Call: `probe(&socket).await` before spawning our own daemon.
/// Expects: a socket path (it may not exist).
/// Output: `true` when a `status` request gets any JSON answer
/// within `PROBE_WAIT`, else `false`.
pub async fn probe(path: &Path) -> bool {
    let req = serde_json::json!({ "cmd": "status" });
    call(path, &req, PROBE_WAIT).await.is_ok()
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
    use crate::heartwood::testutil::{answer_forever, temp_dir};
    use serde_json::json;
    use std::path::PathBuf;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    /// Returns a fresh, short socket path in the temp directory.
    fn temp_socket() -> PathBuf {
        temp_dir().join("hw.sock")
    }

    #[tokio::test]
    async fn probe_sees_answering_daemon() {
        let path = temp_socket();
        answer_forever(UnixListener::bind(&path).unwrap());
        assert!(probe(&path).await);
    }

    #[tokio::test]
    async fn probe_rejects_missing_or_silent_socket() {
        let path = temp_socket();
        assert!(!probe(&path).await);
        let listener = UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        assert!(!probe(&path).await);
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
        for cmd in ["files", "work-files"] {
            assert_eq!(timeout_for(cmd), Duration::from_secs(30));
        }
    }

    #[test]
    fn browse_commands_are_allowed() {
        assert_eq!(ALLOWED.len(), 11);
        for cmd in ["files", "work-files"] {
            assert_eq!(command(&json!({"cmd": cmd})), Ok(cmd));
        }
        assert!(command(&json!({"cmd": "wait"})).is_err());
    }

    /// Tells whether a daemon of the given config file is running.
    ///
    /// Call: `daemon_alive(&config_path)` in the live test.
    /// Expects: `pgrep` on the PATH.
    /// Output: `true` when a process runs `--config <path> daemon`.
    fn daemon_alive(config: &Path) -> bool {
        let pattern = format!("--config {} daemon", config.display());
        std::process::Command::new("pgrep")
            .args(["-f", "--", &pattern])
            .output()
            .map(|o| !o.stdout.is_empty())
            .unwrap_or(false)
    }

    /// Live smoke test against a Heartwood dev server.
    ///
    /// Call: `aplikacja/scripts/heartwood-smoke.sh` (sets the env).
    /// Expects: `COGNIFLY_HEARTWOOD_CONFIG` (a ready config.toml) and
    /// `COGNIFLY_HEARTWOOD_BIN` (the `heartwood` binary).
    /// Output: the real start path (`prepare`) runs our own daemon,
    /// `status` answers `ok` + `running`, and stop leaves no child.
    /// Without `COGNIFLY_HEARTWOOD_CONFIG` it returns early (skip).
    #[tokio::test]
    #[ignore = "needs a live Heartwood dev server (docs/heartwood.md)"]
    async fn live_status_roundtrip() {
        use crate::heartwood::supervisor::{Phase, Supervisor};
        if std::env::var_os("COGNIFLY_HEARTWOOD_CONFIG").is_none() {
            eprintln!("skipped: COGNIFLY_HEARTWOOD_CONFIG is not set");
            return;
        }
        let config = crate::heartwood::config::resolve("", "", "").unwrap();
        let sup = Supervisor::default();
        let launch = crate::heartwood::prepare("", "", "").unwrap();
        sup.start(launch).await;
        let up = crate::heartwood::testutil::wait_until(
            Duration::from_secs(20),
            || sup.info().state == Phase::Running,
        )
        .await;
        assert!(up, "{:?}", sup.info());
        assert_eq!(sup.info().last_error, None, "daemon must be our own");
        assert!(daemon_alive(&config.path));
        let socket = sup.socket().unwrap();
        let req = json!({"cmd": "status"});
        let got = call(&socket, &req, Duration::from_secs(10)).await.unwrap();
        assert_eq!(got["ok"], json!(true), "{got}");
        assert_eq!(got["running"], json!(true), "{got}");
        sup.stop(Phase::Disabled).await;
        assert!(!daemon_alive(&config.path), "daemon left after stop");
    }
}
