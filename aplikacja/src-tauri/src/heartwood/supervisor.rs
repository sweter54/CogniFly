//! Supervision of the `heartwood daemon` child process.
//!
//! One supervisor task per launch restarts the daemon with
//! exponential backoff. Its state is shared with the commands for
//! `heartwood_info`; stopping kills the child and waits for the task.

use super::config::{socket_path, Resolved};
use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::async_runtime::{spawn, JoinHandle};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStderr, Command};
use tokio::sync::oneshot;

/// First restart delay; it doubles with every crash.
const BASE_DELAY: Duration = Duration::from_secs(1);
/// Longest restart delay.
const MAX_DELAY: Duration = Duration::from_secs(60);
/// Run time after which the restart counter starts again from 0.
const STABLE_RUN: Duration = Duration::from_secs(5 * 60);
/// How long stopping waits for the supervisor task to finish.
const STOP_WAIT: Duration = Duration::from_secs(5);

/// Lifecycle phase reported to the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Disabled,
    NotInstalled,
    Starting,
    Running,
    Restarting,
}

impl Phase {
    /// Phase that a start error code leaves behind.
    ///
    /// Call: `Phase::for_error(&code)` when `heartwood_start` fails.
    /// Expects: an error code string.
    /// Output: `Disabled` / `NotInstalled` for `DISABLED` /
    /// `NOT_INSTALLED`; `None` for errors that keep the daemon.
    pub fn for_error(code: &str) -> Option<Phase> {
        match code {
            "DISABLED" => Some(Phase::Disabled),
            "NOT_INSTALLED" => Some(Phase::NotInstalled),
            _ => None,
        }
    }
}

/// State returned by `heartwood_info` (camelCase for the UI).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartwoodInfo {
    pub state: Phase,
    pub root: String,
    pub restarts: u32,
    pub last_error: Option<String>,
}

/// What the daemon runs with; equal launches are not restarted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub bin: PathBuf,
    pub config: Resolved,
}

/// State shared between the commands and the supervisor task.
type Shared = Arc<Mutex<HeartwoodInfo>>;

/// A running supervisor task and the way to stop it.
struct Running {
    launch: Launch,
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

/// How one daemon run ended.
enum Outcome {
    /// Stop was requested; the child is killed.
    Stopped,
    /// The child failed to start or exited on its own.
    Crashed { error: String, uptime: Duration },
}

/// Tauri-managed supervisor of the Heartwood daemon.
pub struct Supervisor {
    status: Shared,
    current: tokio::sync::Mutex<Option<Running>>,
}

impl Default for Supervisor {
    /// Call: `Supervisor::default()` in `manage`.
    /// Expects: nothing.
    /// Output: no daemon, state `disabled`, empty root.
    fn default() -> Self {
        let info = HeartwoodInfo {
            state: Phase::Disabled,
            root: String::new(),
            restarts: 0,
            last_error: None,
        };
        Supervisor {
            status: Arc::new(Mutex::new(info)),
            current: tokio::sync::Mutex::new(None),
        }
    }
}

/// Changes the shared state.
///
/// Call: `update(&status, |s| s.state = Phase::Running)`.
/// Expects: the shared state; a poisoned lock is recovered.
/// Output: none; the closure ran under the lock.
fn update(status: &Shared, change: impl FnOnce(&mut HeartwoodInfo)) {
    let mut guard = status.lock().unwrap_or_else(|e| e.into_inner());
    change(&mut guard);
}

impl Supervisor {
    /// Current state for `heartwood_info`.
    ///
    /// Call: `sup.info()`.
    /// Expects: nothing.
    /// Output: a snapshot of the shared state.
    pub fn info(&self) -> HeartwoodInfo {
        let guard = self.status.lock().unwrap_or_else(|e| e.into_inner());
        guard.clone()
    }

    /// Socket of the current root, if any root is known.
    ///
    /// Call: `sup.socket()` before a local API call.
    /// Expects: nothing.
    /// Output: `<root>/.heartwood/heartwood.sock`, `None` before the
    /// first start.
    pub fn socket(&self) -> Option<PathBuf> {
        let root = self.info().root;
        (!root.is_empty()).then(|| socket_path(&PathBuf::from(root)))
    }

    /// Starts (or restarts) the daemon for a launch.
    ///
    /// Call: `sup.start(launch).await` from `heartwood_start`.
    /// Expects: a resolved launch whose config file is written.
    /// Output: the new state. The same launch as the running one is
    /// a no-op; a different one stops the old daemon first.
    pub async fn start(&self, launch: Launch) -> HeartwoodInfo {
        let mut current = self.current.lock().await;
        if current.as_ref().is_some_and(|r| r.launch == launch) {
            return self.info();
        }
        if let Some(old) = current.take() {
            halt(old).await;
        }
        update(&self.status, |s| {
            s.state = Phase::Starting;
            s.root = launch.config.root.to_string_lossy().into_owned();
            s.restarts = 0;
            s.last_error = None;
        });
        let (stop, stopped) = oneshot::channel();
        let status = self.status.clone();
        let task = spawn(supervise(launch.clone(), status, stopped));
        *current = Some(Running { launch, stop, task });
        self.info()
    }

    /// Stops the daemon, if any, and sets the reported phase.
    ///
    /// Call: `sup.stop(Phase::Disabled).await` on logout or when a
    /// start finds the integration disabled or not installed.
    /// Expects: the phase to report afterwards.
    /// Output: none; the child is killed and the task has ended
    /// (or `STOP_WAIT` passed). The root stays known.
    pub async fn stop(&self, phase: Phase) {
        if let Some(old) = self.current.lock().await.take() {
            halt(old).await;
        }
        update(&self.status, |s| {
            s.state = phase;
            s.restarts = 0;
            s.last_error = None;
        });
    }

    /// Blocking stop for app exit.
    ///
    /// Call: `sup.shutdown()` from `RunEvent::Exit`.
    /// Expects: called outside the async runtime (main thread).
    /// Output: none; the daemon is killed before the app quits.
    pub fn shutdown(&self) {
        tauri::async_runtime::block_on(self.stop(Phase::Disabled));
    }
}

/// Signals a supervisor task to stop and waits for it.
///
/// Call: `halt(running).await`.
/// Expects: a running supervisor.
/// Output: none; waits at most `STOP_WAIT`.
async fn halt(running: Running) {
    let _ = running.stop.send(());
    let _ = tokio::time::timeout(STOP_WAIT, running.task).await;
}

/// Restart delay after a number of earlier restarts.
///
/// Call: `next_delay(restarts)`.
/// Expects: the restart count before this restart.
/// Output: `min(1 s · 2^restarts, 60 s)`.
pub fn next_delay(restarts: u32) -> Duration {
    2u32.checked_pow(restarts)
        .and_then(|factor| BASE_DELAY.checked_mul(factor))
        .map_or(MAX_DELAY, |d| d.min(MAX_DELAY))
}

/// Restart count and delay after a crash.
///
/// Call: `after_crash(restarts, uptime)`.
/// Expects: the current count and how long the child ran.
/// Output: the new count and the delay; a run of `STABLE_RUN` or
/// longer counts as recovered, so the count restarts from 0.
fn after_crash(restarts: u32, uptime: Duration) -> (u32, Duration) {
    let before = if uptime >= STABLE_RUN { 0 } else { restarts };
    (before.saturating_add(1), next_delay(before))
}

/// Starts the daemon child process.
///
/// Call: `spawn_daemon(&launch)`.
/// Expects: an existing binary and config file.
/// Output: `heartwood --config <path> daemon` with stderr piped and
/// killed when dropped, or the spawn error text.
fn spawn_daemon(launch: &Launch) -> Result<Child, String> {
    Command::new(&launch.bin)
        .arg("--config")
        .arg(&launch.config.path)
        .arg("daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())
}

/// Forwards the daemon's stderr to the app log.
///
/// Call: `forward_stderr(stderr)` right after spawning.
/// Expects: the child's stderr pipe.
/// Output: none; each line (decoded lossily, so the pipe is never
/// closed early) becomes a `log::warn!` until EOF. The daemon never
/// prints tokens.
fn forward_stderr(stderr: ChildStderr) {
    spawn(async move {
        let mut lines = BufReader::new(stderr).split(b'\n');
        while let Ok(Some(line)) = lines.next_segment().await {
            log::warn!("heartwood: {}", String::from_utf8_lossy(&line));
        }
    });
}

/// Runs the daemon once, until it exits or stop is requested.
///
/// Call: `run_once(&launch, &status, &mut stopped).await`.
/// Expects: the stop receiver of this supervisor.
/// Output: `Stopped` (child killed) or `Crashed` with the reason and
/// how long the child ran. Sets `running` while it runs.
async fn run_once(
    launch: &Launch,
    status: &Shared,
    stopped: &mut oneshot::Receiver<()>,
) -> Outcome {
    let started = Instant::now();
    let mut child = match spawn_daemon(launch) {
        Ok(child) => child,
        Err(error) => return Outcome::Crashed { error, uptime: Duration::ZERO },
    };
    if let Some(stderr) = child.stderr.take() {
        forward_stderr(stderr);
    }
    update(status, |s| s.state = Phase::Running);
    tokio::select! {
        exit = child.wait() => {
            let error = match exit {
                Ok(code) => format!("daemon exited: {code}"),
                Err(e) => e.to_string(),
            };
            Outcome::Crashed { error, uptime: started.elapsed() }
        }
        _ = stopped => {
            let _ = child.kill().await;
            Outcome::Stopped
        }
    }
}

/// Supervisor loop: runs the daemon and restarts it with backoff.
///
/// Call: spawned by `Supervisor::start`.
/// Expects: the launch, the shared state and the stop receiver.
/// Output: none; ends when stop is requested (or its sender is
/// dropped), with the child killed.
async fn supervise(
    launch: Launch,
    status: Shared,
    mut stopped: oneshot::Receiver<()>,
) {
    loop {
        let Outcome::Crashed { error, uptime } =
            run_once(&launch, &status, &mut stopped).await
        else {
            return;
        };
        log::warn!("heartwood: {error}");
        let mut delay = Duration::ZERO;
        update(&status, |s| {
            let (restarts, wait) = after_crash(s.restarts, uptime);
            s.restarts = restarts;
            s.state = Phase::Restarting;
            s.last_error = Some(error);
            delay = wait;
        });
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = &mut stopped => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(next_delay(0), Duration::from_secs(1));
        assert_eq!(next_delay(3), Duration::from_secs(8));
        assert_eq!(next_delay(10), Duration::from_secs(60));
        assert_eq!(next_delay(u32::MAX), Duration::from_secs(60));
    }

    #[test]
    fn stable_run_resets_restart_count() {
        let short = Duration::from_secs(1);
        assert_eq!(after_crash(0, short), (1, Duration::from_secs(1)));
        assert_eq!(after_crash(3, short), (4, Duration::from_secs(8)));
        assert_eq!(after_crash(3, STABLE_RUN), (1, Duration::from_secs(1)));
    }

    #[test]
    fn info_serializes_camel_case_and_snake_phase() {
        let info = HeartwoodInfo {
            state: Phase::NotInstalled,
            root: "/r".into(),
            restarts: 2,
            last_error: Some("x".into()),
        };
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            serde_json::json!({
                "state": "not_installed",
                "root": "/r",
                "restarts": 2,
                "lastError": "x"
            })
        );
    }
}
