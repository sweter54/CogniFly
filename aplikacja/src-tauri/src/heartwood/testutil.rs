//! Test helpers shared by the Heartwood module tests.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;

/// Creates a fresh, short temp directory.
///
/// Call: `temp_dir()` in a test.
/// Expects: nothing.
/// Output: an existing empty directory unique to this call, short
/// enough for Unix socket paths below it.
pub fn temp_dir() -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir()
        .join(format!("cf-hw-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Fake daemon: answers every request line with `{"ok":true}`.
///
/// Call: `answer_forever(listener)`.
/// Expects: a bound listener; must run inside a Tokio runtime.
/// Output: none; a background task serves until the runtime ends.
pub fn answer_forever(listener: UnixListener) {
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (r, mut w) = stream.into_split();
                let mut lines = BufReader::new(r).lines();
                while let Ok(Some(_)) = lines.next_line().await {
                    let _ = w.write_all(b"{\"ok\":true}\n").await;
                }
            });
        }
    });
}

/// Polls a condition until it holds or a deadline passes.
///
/// Call: `wait_until(Duration::from_secs(3), || done()).await`.
/// Expects: a cheap condition.
/// Output: `true` once it held, `false` after the deadline.
pub async fn wait_until(limit: Duration, cond: impl Fn() -> bool) -> bool {
    let deadline = std::time::Instant::now() + limit;
    while std::time::Instant::now() < deadline {
        if cond() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    cond()
}
