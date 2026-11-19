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

/// Digest of a whole launch: binary path and config text.
///
/// Call: `launch_digest(&launch.bin, &text)`.
/// Expects: the daemon binary and the config text it runs with.
/// Output: `digest` of `<bin>\n<text>`, so a new binary also counts
/// as a changed launch.
pub fn launch_digest(bin: &Path, text: &str) -> String {
    digest(&format!("{}\n{text}", bin.to_string_lossy()))
}

/// Whether `ps` output shows the daemon we spawn for a config.
///
/// Call: `is_our_daemon(&comm, &args, &config_path)`.
/// Expects: `ps -o comm=` and `ps -o args=` of one PID and the
/// config path that `spawn_daemon` passes.
/// Output: `true` only for a `heartwood` executable whose command
/// line ends with `--config <config> daemon`.
pub fn is_our_daemon(comm: &str, args: &str, config: &Path) -> bool {
    let tail = format!("--config {} daemon", config.to_string_lossy());
    is_daemon_name(comm) && args.trim_end().ends_with(&tail)
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
/// Call: `decide(record.as_ref(), ours, digest.as_deref())`.
/// Expects: the record (if any), whether `ownership` of its PID is
/// `Ours` (`Unknown` counts as not ours), and the new launch digest
/// (`None` when the config is the user's own file).
/// Output: `ReplaceOrphan` only for our live orphan with another
/// digest, `AdoptOwn` for the same digest, otherwise `Adopt`.
pub fn decide(
    record: Option<&Record>,
    ours: bool,
    digest: Option<&str>,
) -> Answering {
    match (record, digest) {
        (Some(r), Some(d)) if ours && r.digest == d => Answering::AdoptOwn,
        (Some(_), Some(_)) if ours => Answering::ReplaceOrphan,
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
    let tmp = path.with_extension("pid.tmp");
    let written = super::config::write_private(&tmp, &text)
        .and_then(|()| std::fs::rename(&tmp, &path));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
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

/// Forgets the daemon record unconditionally.
///
/// Call: `clear(&config_path)` (prefer `clear_if`).
/// Expects: the config path.
/// Output: none; the file is removed (a missing file is fine).
fn clear(config: &Path) {
    let _ = std::fs::remove_file(record_path(config));
}

/// Forgets the record only when it still names a given PID.
///
/// Call: `clear_if(&config_path, pid)` once that daemon has ended
/// or must no longer be touched.
/// Expects: the config path and the PID being forgotten.
/// Output: none; a record of another (newer) PID is kept.
pub fn clear_if(config: &Path, pid: u32) {
    if load(config).is_some_and(|r| r.pid == pid) {
        clear(config);
    }
}

/// What `ps` says about a recorded PID.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ownership {
    /// Our daemon for this config: `heartwood --config <it> daemon`.
    Ours,
    /// Gone, or another program / config: never touched.
    NotOurs,
    /// `ps` could not tell: treated as not ours, never killed.
    Unknown,
}

/// Process name and command line of a PID on Linux.
///
/// Call: `process_info(pid).await`.
/// Expects: any PID.
/// Output: `Ok(Some((comm, args)))` from `/proc/<pid>/comm` and
/// `/proc/<pid>/cmdline` (NUL-separated, joined with spaces);
/// `Ok(None)` when the process is gone; `Err(())` on other read
/// errors.
#[cfg(target_os = "linux")]
async fn process_info(pid: u32) -> Result<Option<(String, String)>, ()> {
    let dir = PathBuf::from(format!("/proc/{pid}"));
    let read = |name: &str| -> Result<Option<Vec<u8>>, ()> {
        match std::fs::read(dir.join(name)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(()),
        }
    };
    let (Some(comm), Some(cmdline)) = (read("comm")?, read("cmdline")?) else {
        return Ok(None);
    };
    let args: Vec<String> = cmdline
        .split(|b| *b == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect();
    Ok(Some((String::from_utf8_lossy(&comm).into_owned(), args.join(" "))))
}

/// Process name and command line of a PID via `/bin/ps`.
///
/// Call: `process_info(pid).await`.
/// Expects: any PID.
/// Output: `Ok(Some((comm, args)))` while it runs, `Ok(None)` once
/// gone, `Err(())` when `/bin/ps` failed otherwise.
#[cfg(all(unix, not(target_os = "linux")))]
async fn process_info(pid: u32) -> Result<Option<(String, String)>, ()> {
    let comm = ps_column(pid, "comm=").await?;
    let args = ps_column(pid, "args=").await?;
    Ok(comm.zip(args))
}

/// One `ps` column of a PID.
///
/// Call: `ps_column(pid, "args=").await`.
/// Expects: a PID and a `-o` column spec.
/// Output: `Ok(Some(text))` while it runs, `Ok(None)` once gone
/// (exit 1, no output), `Err(())` when `/bin/ps` failed otherwise.
#[cfg(all(unix, not(target_os = "linux")))]
async fn ps_column(pid: u32, column: &str) -> Result<Option<String>, ()> {
    let out = tokio::process::Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", column])
        .stderr(std::process::Stdio::null())
        .output()
        .await
        .map_err(|_| ())?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    match out.status.code() {
        Some(0) => Ok(Some(text)),
        Some(1) if text.trim().is_empty() => Ok(None),
        _ => Err(()),
    }
}

/// Whether a PID is our daemon for a config.
///
/// Call: `ownership(pid, &config_path).await`.
/// Expects: a PID from the record and the launch's config path.
/// Output: `Ours` only when `is_our_daemon` accepts its name and
/// command line (`/proc` on Linux, `/bin/ps` elsewhere); `NotOurs`
/// when gone or different; `Unknown` when they cannot be read.
#[cfg(unix)]
pub async fn ownership(pid: u32, config: &Path) -> Ownership {
    match process_info(pid).await {
        Ok(Some((c, a))) if is_our_daemon(&c, &a, config) => Ownership::Ours,
        Ok(_) => Ownership::NotOurs,
        Err(()) => Ownership::Unknown,
    }
}

/// Non-Unix stand-in: a recorded daemon is never treated as ours.
///
/// Call: `ownership(pid, &config_path).await`.
/// Expects: anything.
/// Output: `Unknown`, so the socket is adopted as today.
#[cfg(not(unix))]
pub async fn ownership(_pid: u32, _config: &Path) -> Ownership {
    Ownership::Unknown
}

/// Sends a signal with `/bin/kill`.
///
/// Call: `signal(pid, "-TERM").await`.
/// Expects: a PID just confirmed as `Ours`.
/// Output: none; errors (process already gone) are ignored.
#[cfg(unix)]
async fn signal(pid: u32, sig: &str) {
    let _ = tokio::process::Command::new("/bin/kill")
        .args([sig, &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .await;
}

/// Waits until a PID is no longer our daemon.
///
/// Call: `wait_gone(pid, &config_path, wait).await`.
/// Expects: a PID, its config path and the longest wait.
/// Output: `true` once `ownership` is `NotOurs`, `false` after the
/// wait (`Unknown` keeps waiting).
#[cfg(unix)]
async fn wait_gone(pid: u32, config: &Path, wait: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + wait;
    loop {
        if ownership(pid, config).await == Ownership::NotOurs {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

/// Terminates our daemon (stale orphan or adopted own one).
///
/// Call: `terminate(pid, &config_path, wait).await`.
/// Expects: a PID that `ownership` just called `Ours`.
/// Output: `true` when it ended; SIGTERM first, SIGKILL when it is
/// still ours after `wait` (rechecked right before the kill).
#[cfg(unix)]
pub async fn terminate(
    pid: u32,
    config: &Path,
    wait: std::time::Duration,
) -> bool {
    signal(pid, "-TERM").await;
    if wait_gone(pid, config, wait).await {
        return true;
    }
    if ownership(pid, config).await != Ownership::Ours {
        return false;
    }
    signal(pid, "-KILL").await;
    wait_gone(pid, config, wait).await
}

/// Non-Unix stand-in; never reached since nothing is ours there.
///
/// Call: `terminate(pid, &config_path, wait).await`.
/// Expects: anything.
/// Output: `false`.
#[cfg(not(unix))]
pub async fn terminate(
    _pid: u32,
    _config: &Path,
    _wait: std::time::Duration,
) -> bool {
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
    fn launch_digest_covers_binary_and_text() {
        let a = launch_digest(Path::new("/a/heartwood"), "t");
        assert_eq!(a, launch_digest(Path::new("/a/heartwood"), "t"));
        assert_ne!(a, launch_digest(Path::new("/b/heartwood"), "t"));
        assert_ne!(a, launch_digest(Path::new("/a/heartwood"), "u"));
    }

    #[test]
    fn our_daemon_needs_name_config_and_daemon_command() {
        let cfg = Path::new("/d/App Data/heartwood.toml");
        let bin = "/Users/a/.cargo/bin/heartwood";
        let ours = format!("{bin} --config /d/App Data/heartwood.toml daemon\n");
        assert!(is_our_daemon(bin, &ours, cfg));
        let other = format!("{bin} --config /e/heartwood.toml daemon");
        assert!(!is_our_daemon(bin, &other, cfg));
        let status = format!("{bin} --config /d/App Data/heartwood.toml status");
        assert!(!is_our_daemon(bin, &status, cfg));
        assert!(!is_our_daemon("/bin/sleep", &ours, cfg));
        assert!(!is_our_daemon(bin, "", cfg));
    }

    #[test]
    fn record_lives_next_to_the_config() {
        let p = record_path(Path::new("/d/pl.cognifly.aplikacja/heartwood.toml"));
        assert_eq!(p, PathBuf::from("/d/pl.cognifly.aplikacja/heartwood.pid"));
    }
}

#[cfg(all(test, unix))]
mod file_tests {
    use super::*;
    use crate::heartwood::testutil::temp_dir;

    #[test]
    fn clear_if_keeps_a_newer_record() {
        let cfg = temp_dir().join("hw.toml");
        save(&cfg, 100, "aa");
        clear_if(&cfg, 99);
        assert_eq!(load(&cfg).map(|r| r.pid), Some(100));
        clear_if(&cfg, 100);
        assert!(load(&cfg).is_none());
    }

    #[test]
    fn saved_record_is_owner_only_and_leaves_no_temp() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        let cfg = dir.join("hw.toml");
        save(&cfg, 100, "aa");
        save(&cfg, 101, "bb");
        let meta = std::fs::metadata(record_path(&cfg)).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        assert_eq!(load(&cfg).map(|r| r.pid), Some(101));
        let names: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
        assert_eq!(names.len(), 1, "temp file left behind");
    }
}
