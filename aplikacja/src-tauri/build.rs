/// Build script: generates Tauri context and per-command permissions.
///
/// Call: run by Cargo before compiling the crate.
/// Expects: `tauri.conf.json` and `capabilities/` next to this file.
/// Output: `allow-vault-*` permissions, so only windows whose capability
/// lists them may call the keychain commands.
fn main() {
    let commands = &["vault_read", "vault_write", "vault_delete"];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("tauri build step failed");
}
