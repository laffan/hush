//! Courier — the quick-send overlay's native half.
//!
//! The only thing Courier needs from Rust is the list of the user's
//! Apple Shortcuts, so the overlay can offer them as destinations.
//! Running one goes through the `shortcuts://run-shortcut` URL scheme
//! from the webview (the opener plugin), which works on macOS and iPadOS
//! alike; *listing* has no URL form, and only macOS ships the
//! `shortcuts` CLI that can answer it. Everywhere else the list is
//! empty and the overlay falls back to names the user has typed before.

/// Names of the user's Shortcuts, one per line of `shortcuts list`.
/// Never fails: a missing CLI, a refused automation prompt or a
/// non-zero exit all read as "no shortcuts", because the overlay has a
/// manual-entry row for exactly that case.
#[tauri::command]
pub async fn list_apple_shortcuts() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(list_blocking)
        .await
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn list_blocking() -> Vec<String> {
    let out = match std::process::Command::new("/usr/bin/shortcuts").arg("list").output() {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    parse_list(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(target_os = "macos"))]
fn list_blocking() -> Vec<String> {
    Vec::new()
}

#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn parse_list(stdout: &str) -> Vec<String> {
    let mut names: Vec<String> = stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    names
}

#[cfg(test)]
mod tests {
    use super::parse_list;

    #[test]
    fn parses_trims_and_sorts() {
        let got = parse_list("Zeta\n  Add Todo \n\nalpha\nZeta\n");
        assert_eq!(got, vec!["Add Todo", "alpha", "Zeta"]);
    }
}
