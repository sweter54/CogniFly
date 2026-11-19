//! Heartwood client configuration: where it lives, what it says and
//! which `heartwood` binary runs it (plan decisions D9 and D10).
//!
//! The TOML is written by hand (no `toml` dependency): only flat
//! string keys and one string array, escaped as TOML basic strings.

use std::ffi::OsString;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

/// Env var naming a ready config file used as-is (D10).
const CONFIG_ENV: &str = "COGNIFLY_HEARTWOOD_CONFIG";
/// Env var naming the `heartwood` binary (D9, first choice).
const BIN_ENV: &str = "COGNIFLY_HEARTWOOD_BIN";
/// File name of the daemon binary.
const BIN_NAME: &str = "heartwood";
/// App data folder (the bundle identifier).
const APP_DIR: &str = "pl.cognifly.aplikacja";
/// Name of the generated config file.
const CONFIG_FILE: &str = "heartwood.toml";

/// Values of a generated Heartwood client config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HwConfig {
    pub server_url: String,
    pub ws_url: String,
    pub token_command: Vec<String>,
    pub root: PathBuf,
    pub org: String,
    /// Identity API for the access check (empty = check off).
    pub identity_url: String,
}

/// A config ready for the daemon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    /// File passed to `heartwood --config`.
    pub path: PathBuf,
    /// Text to write there; `None` when the file is the user's own.
    pub text: Option<String>,
    /// Sync root (the socket lives below it).
    pub root: PathBuf,
}

/// Escapes a value as a TOML basic string (with quotes).
///
/// Call: `quote("a\"b")` → `"a\"b"` with the quotes.
/// Expects: any text.
/// Output: `\` and `"` escaped, control characters as `\n`, `\t`,
/// `\r` or `\uXXXX`, so the line always parses.
fn quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if c.is_control() => {
                let _ = write!(out, "\\u{:04X}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Renders the config as TOML text.
///
/// Call: `render(&cfg)` before writing the config file.
/// Expects: any values; paths are stored lossily as UTF-8.
/// Output: one `key = value` line each for `server_url`, `ws_url`,
/// `token_command`, `root`, `org` and `identity_url` (the last two
/// omitted when empty), ending
/// with a newline.
pub fn render(c: &HwConfig) -> String {
    let command: Vec<String> =
        c.token_command.iter().map(|s| quote(s)).collect();
    let mut out = format!(
        "server_url = {}\nws_url = {}\ntoken_command = [{}]\nroot = {}\n",
        quote(&c.server_url),
        quote(&c.ws_url),
        command.join(", "),
        quote(&c.root.to_string_lossy()),
    );
    if !c.org.is_empty() {
        let _ = writeln!(out, "org = {}", quote(&c.org));
    }
    if !c.identity_url.is_empty() {
        let _ = writeln!(out, "identity_url = {}", quote(&c.identity_url));
    }
    out
}

/// Path of the daemon's local API socket.
///
/// Call: `socket_path(&root)`.
/// Expects: the sync root of the config.
/// Output: `<root>/.heartwood/heartwood.sock` (contract section 9).
pub fn socket_path(root: &Path) -> PathBuf {
    root.join(".heartwood").join("heartwood.sock")
}

/// Decodes the escapes of a TOML basic string body.
///
/// Call: `unescape_basic(body)` with the text between the quotes.
/// Expects: escapes `\\ \" \n \t \r \uXXXX`; others are kept.
/// Output: the decoded string.
fn unescape_basic(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('u') => {
                let hex: String = chars.by_ref().take(4).collect();
                let code = u32::from_str_radix(&hex, 16).ok();
                out.extend(code.and_then(char::from_u32));
            }
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// Reads a top-level string value from TOML text.
///
/// Call: `string_value(text, "root")` for a user's config file.
/// Expects: a `key = "basic"` or `key = 'literal'` line; tables,
/// multi-line strings and keys after a `[table]` are not supported.
/// Output: the decoded value, or `None` when the key is absent.
pub fn string_value(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            return None;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        if k.trim() != key {
            continue;
        }
        let v = v.trim();
        if let Some(rest) = v.strip_prefix('\'') {
            return rest.split_once('\'').map(|(s, _)| s.to_string());
        }
        let rest = v.strip_prefix('"')?;
        let mut end = None;
        let mut escaped = false;
        for (i, ch) in rest.char_indices() {
            match ch {
                _ if escaped => escaped = false,
                '\\' => escaped = true,
                '"' => {
                    end = Some(i);
                    break;
                }
                _ => {}
            }
        }
        return end.map(|i| unescape_basic(&rest[..i]));
    }
    None
}

/// Fallback sync root for `COGNIFLY_HEARTWOOD_CONFIG` without `root`.
///
/// Call: `default_root()`.
/// Expects: nothing.
/// Output: the path; `./Heartwood` when the home dir is unknown.
pub fn default_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Heartwood")
}

/// Where the app writes the generated config (D10).
///
/// Call: `generated_path()`.
/// Expects: nothing.
/// Output: `~/Library/Application Support/pl.cognifly.aplikacja/
/// heartwood.toml` on macOS (the platform data dir elsewhere).
fn generated_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_DIR)
        .join(CONFIG_FILE)
}

/// Returns a non-empty env var as a path.
///
/// Call: `env_path(CONFIG_ENV)`.
/// Expects: a variable name.
/// Output: `Some(path)` when set and non-empty, else `None`.
fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v: &OsString| !v.is_empty())
        .map(PathBuf::from)
}

/// Longest socket path a Unix socket accepts on macOS (SUN_LEN 104).
const MAX_SOCKET_PATH: usize = 103;

/// Checks the sync root chosen by CogniFly.
///
/// Call: `check_root(Path::new("/Users/a/Praca/Pliki"))`.
/// Expects: the root sent by the app (work folder + `Pliki`).
/// Output: `Ok(())` for an absolute path whose socket path fits;
/// `Err("BAD_ROOT")` for a relative or empty path,
/// `Err("ROOT_TOO_LONG")` when the socket path is too long.
pub fn check_root(root: &Path) -> Result<(), String> {
    if root.as_os_str().is_empty() || !root.is_absolute() {
        return Err("BAD_ROOT".to_string());
    }
    if socket_path(root).as_os_str().len() > MAX_SOCKET_PATH {
        return Err("ROOT_TOO_LONG".to_string());
    }
    Ok(())
}

/// Keeps the sync root out of the work folder's git repository.
///
/// Call: `exclude_from_git(&root)` before starting the daemon.
/// Expects: the sync root; its parent may be a git work tree.
/// Output: none; when `<parent>/.git` is a directory, the line
/// `/<root name>/` is appended to `.git/info/exclude` once.
/// Best effort: errors are ignored (the files still sync).
pub fn exclude_from_git(root: &Path) {
    let (Some(parent), Some(name)) = (root.parent(), root.file_name()) else {
        return;
    };
    let git = parent.join(".git");
    if !git.is_dir() {
        return;
    }
    let line = format!("/{}/", name.to_string_lossy());
    let file = git.join("info").join("exclude");
    let text = std::fs::read_to_string(&file).unwrap_or_default();
    if text.lines().any(|l| l.trim() == line) {
        return;
    }
    let sep = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
    let _ = std::fs::create_dir_all(git.join("info"));
    let _ = std::fs::write(&file, format!("{text}{sep}{line}\n"));
}

/// Resolves the config the daemon will run with (D10).
///
/// Call: `resolve(server_url, ws_url, org, identity_url, root)` on
/// `heartwood_start`.
/// Expects: the URLs built into the app (empty = disabled; empty
/// `identity_url` = no access check) and the sync root chosen by
/// CogniFly (work folder + `Pliki`).
/// Output: the env file as-is (root read from it, else the default)
/// when `COGNIFLY_HEARTWOOD_CONFIG` is set; otherwise a generated
/// config with `root` and `token_command` = this app in token mode.
/// `Err("DISABLED")` for empty URLs without the variable;
/// `BAD_ROOT` / `ROOT_TOO_LONG` from `check_root`.
pub fn resolve(
    server_url: &str,
    ws_url: &str,
    org: &str,
    identity_url: &str,
    root: &Path,
) -> Result<Resolved, String> {
    if let Some(path) = env_path(CONFIG_ENV) {
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let root = string_value(&text, "root")
            .map(PathBuf::from)
            .unwrap_or_else(default_root);
        return Ok(Resolved { path, text: None, root });
    }
    if server_url.is_empty() || ws_url.is_empty() {
        return Err("DISABLED".to_string());
    }
    check_root(root)?;
    let exe = std::env::current_exe().map_err(|_| "NO_EXE".to_string())?;
    let cfg = HwConfig {
        server_url: server_url.to_string(),
        ws_url: ws_url.to_string(),
        token_command: vec![
            exe.to_string_lossy().into_owned(),
            crate::TOKEN_ARG.to_string(),
        ],
        root: root.to_path_buf(),
        org: org.to_string(),
        identity_url: identity_url.to_string(),
    };
    Ok(Resolved {
        path: generated_path(),
        text: Some(render(&cfg)),
        root: cfg.root,
    })
}

/// Writes the generated config with owner-only permissions.
///
/// Call: `write(&resolved)` before (re)starting the daemon.
/// Expects: a resolved config; `text: None` writes nothing.
/// Output: the file (and its folder) created or replaced with mode
/// 0600 on Unix; `Err("CONFIG_WRITE")` on an I/O failure.
pub fn write(resolved: &Resolved) -> Result<(), String> {
    let Some(text) = &resolved.text else { return Ok(()) };
    let fail = |_| "CONFIG_WRITE".to_string();
    if let Some(dir) = resolved.path.parent() {
        std::fs::create_dir_all(dir).map_err(fail)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&resolved.path).map_err(fail)?;
    // An older file keeps its mode on open: tighten it too.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::Permissions::from_mode(0o600);
        file.set_permissions(mode).map_err(fail)?;
    }
    use std::io::Write as _;
    file.write_all(text.as_bytes()).map_err(fail)
}

/// Candidate paths of the `heartwood` binary, in D9 order.
///
/// Call: `binary_candidates(env, current_exe, home)`.
/// Expects: `COGNIFLY_HEARTWOOD_BIN`, this app's executable and the
/// home dir, each optional.
/// Output: env path, the file next to the executable
/// (`Contents/MacOS/heartwood`), `~/.cargo/bin/heartwood`.
pub fn binary_candidates(
    env: Option<PathBuf>,
    exe: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Vec<PathBuf> {
    let beside = exe.and_then(|e| e.parent().map(|d| d.join(BIN_NAME)));
    let cargo = home.map(|h| h.join(".cargo").join("bin").join(BIN_NAME));
    env.into_iter().chain(beside).chain(cargo).collect()
}

/// Finds the `heartwood` binary (D9).
///
/// Call: `find_binary()` on `heartwood_start`.
/// Expects: nothing.
/// Output: the first existing candidate file, or
/// `Err("NOT_INSTALLED")`.
pub fn find_binary() -> Result<PathBuf, String> {
    binary_candidates(
        env_path(BIN_ENV),
        std::env::current_exe().ok(),
        dirs::home_dir(),
    )
    .into_iter()
    .find(|p| p.is_file())
    .ok_or_else(|| "NOT_INSTALLED".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a config whose paths contain a quote and a backslash.
    fn sample() -> HwConfig {
        HwConfig {
            server_url: "https://hw.example.com".into(),
            ws_url: "wss://ws.example.com".into(),
            token_command: vec![
                "/Apps/Cogni \"Fly\".app/x\\y".into(),
                "heartwood-token".into(),
            ],
            root: PathBuf::from("/Users/a/Heart\"wood"),
            org: "acme".into(),
            identity_url: String::new(),
        }
    }

    #[test]
    fn render_writes_identity_url_only_when_set() {
        let mut c = sample();
        assert!(!render(&c).contains("identity_url"));
        c.identity_url = "https://id.example.com".into();
        let text = render(&c);
        assert!(text
            .lines()
            .any(|l| l == r#"identity_url = "https://id.example.com""#));
        assert!(text.ends_with('\n'));
    }

    #[test]
    fn resolve_passes_identity_url_through() {
        let root = Path::new("/Users/a/Praca/Pliki");
        let r = resolve("https://s", "wss://w", "", "https://id.example.com", root);
        let text = r.unwrap().text.unwrap();
        assert!(text.contains(r#"identity_url = "https://id.example.com""#));
    }

    #[test]
    fn render_writes_all_keys_escaped() {
        let text = render(&sample());
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines,
            vec![
                r#"server_url = "https://hw.example.com""#,
                r#"ws_url = "wss://ws.example.com""#,
                r#"token_command = ["/Apps/Cogni \"Fly\".app/x\\y", "heartwood-token"]"#,
                r#"root = "/Users/a/Heart\"wood""#,
                r#"org = "acme""#,
            ]
        );
        assert!(text.ends_with('\n'));
    }

    #[test]
    fn render_omits_empty_org_and_escapes_controls() {
        let mut c = sample();
        c.org = String::new();
        c.server_url = "a\nb\u{1}".into();
        let text = render(&c);
        assert!(!text.contains("org ="));
        assert!(text.contains(r#"server_url = "a\nb\u0001""#));
    }

    #[test]
    fn string_value_reads_rendered_root() {
        let text = render(&sample());
        assert_eq!(
            string_value(&text, "root").as_deref(),
            Some("/Users/a/Heart\"wood")
        );
        let lit = "# c\nroot = '/x/y' # note\n";
        assert_eq!(string_value(lit, "root").as_deref(), Some("/x/y"));
        assert_eq!(string_value("rootx = \"a\"", "root"), None);
    }

    #[test]
    fn socket_path_is_inside_dot_heartwood() {
        assert_eq!(
            socket_path(Path::new("/Users/a/Heartwood")),
            PathBuf::from("/Users/a/Heartwood/.heartwood/heartwood.sock")
        );
    }

    #[test]
    fn binary_candidates_follow_d9_order() {
        let got = binary_candidates(
            Some(PathBuf::from("/env/heartwood")),
            Some(PathBuf::from("/App.app/Contents/MacOS/CogniFly")),
            Some(PathBuf::from("/Users/a")),
        );
        assert_eq!(
            got,
            vec![
                PathBuf::from("/env/heartwood"),
                PathBuf::from("/App.app/Contents/MacOS/heartwood"),
                PathBuf::from("/Users/a/.cargo/bin/heartwood"),
            ]
        );
        assert!(binary_candidates(None, None, None).is_empty());
    }

    #[test]
    fn write_creates_owner_only_file() {
        let dir = std::env::temp_dir()
            .join(format!("cf-hw-cfg-{}", std::process::id()));
        let path = dir.join("sub").join("heartwood.toml");
        let resolved = Resolved {
            path: path.clone(),
            text: Some("a = \"b\"\n".into()),
            root: dir.clone(),
        };
        write(&resolved).unwrap();
        write(&resolved).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "a = \"b\"\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn root_must_be_absolute_and_short() {
        assert_eq!(check_root(Path::new("")), Err("BAD_ROOT".into()));
        assert_eq!(check_root(Path::new("rel/Pliki")), Err("BAD_ROOT".into()));
        assert!(check_root(Path::new("/Users/a/Praca/Pliki")).is_ok());
        let long = format!("/{}/Pliki", "x".repeat(90));
        assert_eq!(check_root(Path::new(&long)), Err("ROOT_TOO_LONG".into()));
    }

    #[test]
    fn root_is_excluded_from_git_once() {
        let dir = std::env::temp_dir().join(format!("hw-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".git").join("info")).unwrap();
        std::fs::write(dir.join(".git/info/exclude"), "*.log").unwrap();
        exclude_from_git(&dir.join("Pliki"));
        exclude_from_git(&dir.join("Pliki"));
        let text = std::fs::read_to_string(dir.join(".git/info/exclude")).unwrap();
        assert_eq!(text, "*.log\n/Pliki/\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_git_means_no_exclude_file() {
        let dir = std::env::temp_dir().join(format!("hw-nogit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        exclude_from_git(&dir.join("Pliki"));
        assert!(!dir.join(".git").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

}
