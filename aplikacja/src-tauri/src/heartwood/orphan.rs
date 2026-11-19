//! Our daemon left running by an app that ended without stopping it.
//!
//! When the app spawns the daemon it records the PID and a digest of
//! the config text in `heartwood.pid` next to the generated config.
//! On the next start an answering socket is checked against that
//! record: our orphan with a stale config is replaced, one with the
//! same config is adopted, anything else is left alone.

use std::path::{Path, PathBuf};

/// Name of the record file next to the generated config.
const RECORD_FILE: &str = "heartwood.pid";
/// Executable name a recorded PID must still have to be ours.
const BIN_NAME: &str = "heartwood";

/// What our app recorded when it spawned the daemon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub pid: u32,
    pub digest: String,
}

/// What to do when the socket already answers before we spawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answering {
    /// Not provably ours: adopt as an external daemon.
    Adopt,
    /// Our orphan with the same config: adopt it silently.
    AdoptOwn,
    /// Our orphan with a stale config: terminate it, spawn ours.
    ReplaceOrphan,
}

/// Stable 64-bit FNV-1a hash.
///
/// Call: `fnv1a64(b"text")`.
/// Expects: any bytes.
/// Output: the hash; identical across builds and platforms.
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    bytes.iter().fold(OFFSET, |hash, &b| {
        (hash ^ u64::from(b)).wrapping_mul(PRIME)
    })
}

/// Digest of a config text, as stored in the record.
///
/// Call: `digest(&text)`.
/// Expects: the config text the daemon is started with.
/// Output: 16 lowercase hex digits of `fnv1a64`.
pub fn digest(text: &str) -> String {
    format!("{:016x}", fnv1a64(text.as_bytes()))
}

/// Renders a record as file text.
///
/// Call: `render(&record)` before writing the record file.
/// Expects: any record.
/// Output: `pid=<pid>\ndigest=<digest>\n`.
pub fn render(record: &Record) -> String {
    format!("pid={}\ndigest={}\n", record.pid, record.digest)
}

/// Parses the record file text.
///
/// Call: `parse(&text)`.
/// Expects: text written by `render`; key order does not matter.
/// Output: the record, or `None` when a key is missing, the PID is
/// not a number above 1 or the digest is empty.
pub fn parse(text: &str) -> Option<Record> {
    let (mut pid, mut digest) = (None, None);
    for line in text.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        match k.trim() {
            "pid" => pid = v.trim().parse::<u32>().ok(),
            "digest" => digest = Some(v.trim().to_string()),
            _ => {}
        }
    }
    let pid = pid.filter(|p| *p > 1)?;
    let digest = digest.filter(|d| !d.is_empty())?;
    Some(Record { pid, digest })
}

/// Decides what to do with a socket that already answers.
///
/// Call: `decide(record.as_ref(), alive, digest.as_deref())`.
/// Expects: the record (if any), whether its PID is a live
/// `heartwood` process, and the new config's digest (`None` when the
/// config is the user's own file).
/// Output: `ReplaceOrphan` only for our live orphan with another
/// digest, `AdoptOwn` for the same digest, otherwise `Adopt`.
pub fn decide(
    record: Option<&Record>,
    alive: bool,
    digest: Option<&str>,
) -> Answering {
    match (record, digest) {
        (Some(r), Some(d)) if alive && r.digest == d => Answering::AdoptOwn,
        (Some(_), Some(_)) if alive => Answering::ReplaceOrphan,
        _ => Answering::Adopt,
    }
}

/// Whether a `ps -o comm=` value names the daemon binary.
///
/// Call: `is_daemon_name("/Users/a/.cargo/bin/heartwood")`.
/// Expects: a process name or executable path.
/// Output: `true` when its last path part is exactly `heartwood`.
pub fn is_daemon_name(comm: &str) -> bool {
    Path::new(comm.trim())
        .file_name()
        .is_some_and(|name| name == BIN_NAME)
}

/// Path of the record file for a config.
///
/// Call: `record_path(&resolved.path)`.
/// Expects: the config file path.
/// Output: `heartwood.pid` in the same folder.
pub fn record_path(config: &Path) -> PathBuf {
    config.with_file_name(RECORD_FILE)
}

/// Remembers the daemon we just spawned.
///
/// Call: `save(&config_path, pid, &digest)` right after spawning.
/// Expects: the config path, the child PID and the config digest.
/// Output: none; `heartwood.pid` written with mode 0600. Best
/// effort: a failure is logged (the orphan check then adopts).
pub fn save(config: &Path, pid: u32, digest: &str) {
    let text = render(&Record { pid, digest: digest.to_string() });
    let path = record_path(config);
    if let Err(e) = super::config::write_private(&path, &text) {
        log::warn!("heartwood: cannot write {}: {e}", path.display());
    }
}

/// Reads the record of the daemon we spawned last.
///
/// Call: `load(&config_path)`.
/// Expects: the config path.
/// Output: the record, or `None` when the file is missing or broken.
pub fn load(config: &Path) -> Option<Record> {
    let text = std::fs::read_to_string(record_path(config)).ok()?;
    parse(&text)
}

/// Forgets the daemon record after our child has ended.
///
/// Call: `clear(&config_path)` once our child is stopped or exited.
/// Expects: the config path.
/// Output: none; the file is removed (a missing file is fine).
pub fn clear(config: &Path) {
    let _ = std::fs::remove_file(record_path(config));
}

/// Whether a PID is a live `heartwood` process.
///
/// Call: `is_live_daemon(pid).await`.
/// Expects: a PID from the record.
/// Output: `true` when `ps -p <pid> -o comm=` succeeds and names
/// `heartwood`; a reused PID of another program gives `false`.
#[cfg(unix)]
pub async fn is_live_daemon(pid: u32) -> bool {
    let out = tokio::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => {
            is_daemon_name(&String::from_utf8_lossy(&o.stdout))
        }
        _ => false,
    }
}

/// Non-Unix stand-in: a recorded daemon is never treated as ours.
///
/// Call: `is_live_daemon(pid).await`.
/// Expects: any PID.
/// Output: `false`, so the socket is adopted as today.
#[cfg(not(unix))]
pub async fn is_live_daemon(_pid: u32) -> bool {
    false
}

/// Sends a signal with the `kill` tool.
///
/// Call: `signal(pid, "-TERM").await`.
/// Expects: a PID already checked by `is_live_daemon`.
/// Output: none; errors (process already gone) are ignored.
#[cfg(unix)]
async fn signal(pid: u32, sig: &str) {
    let _ = tokio::process::Command::new("kill")
        .args([sig, &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .await;
}

/// Waits until a PID is no longer a live `heartwood` process.
///
/// Call: `wait_gone(pid, Duration::from_secs(3)).await`.
/// Expects: a PID and the longest wait.
/// Output: `true` once it is gone, `false` after the wait.
#[cfg(unix)]
async fn wait_gone(pid: u32, wait: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + wait;
    while std::time::Instant::now() < deadline {
        if !is_live_daemon(pid).await {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    !is_live_daemon(pid).await
}

/// Terminates our orphan daemon that runs a stale config.
///
/// Call: `terminate(pid, wait).await` for `ReplaceOrphan`.
/// Expects: a PID that `is_live_daemon` accepted.
/// Output: `true` when it ended; SIGTERM first, SIGKILL when it
/// still runs after `wait` (its socket is released once it ends).
#[cfg(unix)]
pub async fn terminate(pid: u32, wait: std::time::Duration) -> bool {
    signal(pid, "-TERM").await;
    if wait_gone(pid, wait).await {
        return true;
    }
    signal(pid, "-KILL").await;
    wait_gone(pid, wait).await
}

/// Non-Unix stand-in; never reached since nothing is ours there.
///
/// Call: `terminate(pid, wait).await`.
/// Expects: anything.
/// Output: `false`.
#[cfg(not(unix))]
pub async fn terminate(_pid: u32, _wait: std::time::Duration) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A record with PID 4242 and the given digest.
    fn rec(digest: &str) -> Record {
        Record { pid: 4242, digest: digest.into() }
    }

    #[test]
    fn fnv1a64_matches_reference_vectors() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(fnv1a64(b"foobar"), 0x8594_4171_f739_67e8);
    }

    #[test]
    fn digest_is_16_hex_and_sensitive_to_text() {
        let a = digest("root = \"/a\"\n");
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(a, digest("root = \"/a\"\n"));
        assert_ne!(a, digest("root = \"/a\"\nidentity_url = \"x\"\n"));
    }

    #[test]
    fn record_round_trips() {
        let r = rec("00ff00ff00ff00ff");
        assert_eq!(render(&r), "pid=4242\ndigest=00ff00ff00ff00ff\n");
        assert_eq!(parse(&render(&r)), Some(r));
        let swapped = "digest=ab\n  pid = 7 \n";
        assert_eq!(parse(swapped), Some(Record { pid: 7, digest: "ab".into() }));
    }

    #[test]
    fn parse_rejects_broken_records() {
        assert_eq!(parse(""), None);
        assert_eq!(parse("pid=12\n"), None);
        assert_eq!(parse("digest=ab\n"), None);
        assert_eq!(parse("pid=x\ndigest=ab\n"), None);
        assert_eq!(parse("pid=1\ndigest=ab\n"), None);
        assert_eq!(parse("pid=0\ndigest=ab\n"), None);
        assert_eq!(parse("pid=12\ndigest=\n"), None);
    }

    #[test]
    fn decide_replaces_only_our_live_orphan_with_other_config() {
        let r = rec("aaaa");
        let replace = decide(Some(&r), true, Some("bbbb"));
        assert_eq!(replace, Answering::ReplaceOrphan);
        assert_eq!(decide(Some(&r), true, Some("aaaa")), Answering::AdoptOwn);
    }

    #[test]
    fn decide_never_touches_what_is_not_provably_ours() {
        let r = rec("aaaa");
        assert_eq!(decide(None, true, Some("bbbb")), Answering::Adopt);
        assert_eq!(decide(Some(&r), false, Some("bbbb")), Answering::Adopt);
        assert_eq!(decide(Some(&r), false, Some("aaaa")), Answering::Adopt);
        assert_eq!(decide(Some(&r), true, None), Answering::Adopt);
    }

    #[test]
    fn daemon_name_is_matched_exactly() {
        assert!(is_daemon_name("heartwood"));
        assert!(is_daemon_name("/Users/a/.cargo/bin/heartwood\n"));
        assert!(!is_daemon_name("/usr/bin/heartwood-token"));
        assert!(!is_daemon_name("/bin/sleep"));
        assert!(!is_daemon_name(""));
    }

    #[test]
    fn record_lives_next_to_the_config() {
        let p = record_path(Path::new("/d/pl.cognifly.aplikacja/heartwood.toml"));
        assert_eq!(p, PathBuf::from("/d/pl.cognifly.aplikacja/heartwood.pid"));
    }
}
