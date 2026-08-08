use std::fs;
use std::path::PathBuf;
use tauri::State;

use crate::images::ImageSaved;
use crate::AppState;

/// The desk new image saves land in: the active desk (from settings).
fn active_desk_id(state: &State<AppState>) -> Option<String> {
    state.settings.lock().unwrap().active_desk_id.clone()
}

#[tauri::command]
pub fn save_image(state: State<AppState>, filename: String, data_url: String) -> Result<ImageSaved, String> {
    let desk = active_desk_id(&state);
    let saved = state.image_manager.lock().unwrap()
        .save_from_data_url(&filename, &data_url, desk.as_deref())
        .map_err(|e| e.to_string())?;
    if let Some(id) = desk.as_deref() {
        crate::desk_recovery::note_desk_edit(id);
    }
    Ok(saved)
}

/// Save raw image bytes — used to land externally-sourced image
/// binaries without round-tripping through a base64 data URL. Returns the
/// final filename (auto-suffixed on collision).
#[tauri::command]
pub fn save_image_bytes(state: State<AppState>, filename: String, bytes: Vec<u8>) -> Result<ImageSaved, String> {
    let desk = active_desk_id(&state);
    let saved = state.image_manager.lock().unwrap()
        .save_from_bytes(&filename, &bytes, desk.as_deref())
        .map_err(|e| e.to_string())?;
    if let Some(id) = desk.as_deref() {
        crate::desk_recovery::note_desk_edit(id);
    }
    Ok(saved)
}

/// Read an image's raw bytes — used to hand an image
/// binary without round-tripping through a base64 data URL.
#[tauri::command]
pub fn load_image_bytes(state: State<AppState>, filename: String) -> Result<Vec<u8>, String> {
    state.image_manager.lock().unwrap()
        .load_bytes(&filename)
        .map(|(bytes, _mime)| bytes)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_image(state: State<AppState>, filename: String) -> Result<String, String> {
    state.image_manager.lock().unwrap()
        .load_as_data_url(&filename)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_image(state: State<AppState>, filename: String) -> Result<(), String> {
    state.image_manager.lock().unwrap()
        .delete(&filename)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_image(state: State<AppState>, old_filename: String, new_filename: String) -> Result<String, String> {
    state.image_manager.lock().unwrap()
        .rename(&old_filename, &new_filename)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_images(state: State<AppState>) -> Result<Vec<String>, String> {
    Ok(state.image_manager.lock().unwrap().list())
}

/// Export a document as a folder containing `text.md` plus an `images/`
/// subdir. `images` is the list of filenames referenced by the doc; each
/// one is copied to `images/{filename}` (already disambiguated on import,
/// so no extra renaming happens here).
#[tauri::command]
pub fn export_with_images(
    state: State<AppState>,
    folder: String,
    markdown: String,
    images: Vec<String>,
) -> Result<(), String> {
    let root = PathBuf::from(&folder);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    fs::write(root.join("text.md"), markdown.as_bytes()).map_err(|e| e.to_string())?;
    if !images.is_empty() {
        let images_dir = root.join("images");
        fs::create_dir_all(&images_dir).map_err(|e| e.to_string())?;
        let im = state.image_manager.lock().unwrap();
        for filename in &images {
            let (bytes, _mime) = im.load_bytes(filename).map_err(|e| e.to_string())?;
            fs::write(images_dir.join(filename), &bytes).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Write a raw byte blob to a user-picked path.
///
/// The JS fs plugin's `writeFile` with a `Uint8Array` was silently producing
/// 0-byte files on iOS. Routing binary writes through Rust avoids that.
/// iOS's document-picker returns a percent-encoded `file://` URL, not a
/// plain path, so we normalize before writing.
///
/// **Containment.** The Tauri dialog plugin already constrains the user to
/// paths they can reach via the system file picker, but this command is
/// invokable directly so we add defence-in-depth: the resolved path must
/// live under the user's home dir, the app's data dir, or a system temp
/// area. Anything that escapes (e.g. `/etc/...`) is rejected before
/// `fs::write` runs.
#[tauri::command]
pub fn write_binary_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let resolved = normalize_dialog_path(&path);
    let abs = std::path::PathBuf::from(&resolved);
    ensure_path_in_safe_root(&abs)?;
    fs::write(&abs, &bytes).map_err(|e| format!("{} (path: {})", e, resolved))
}

/// Allow writes only under one of: home dir, app data dir, or system
/// temp dir. Any other absolute destination is rejected.
fn ensure_path_in_safe_root(path: &std::path::Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("write_binary_file: path must be absolute: {}", path.display()));
    }
    // Reject any unresolved `..` — even if a downstream canonicalize
    // would normalise it, a literal `..` in the path is a smell.
    for component in path.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err(format!("write_binary_file: '..' in path: {}", path.display()));
        }
    }
    let mut allowed: Vec<std::path::PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() { allowed.push(home); }
    if let Some(data) = dirs::data_dir() { allowed.push(data); }
    if let Some(cache) = dirs::cache_dir() { allowed.push(cache); }
    allowed.push(std::env::temp_dir());
    // macOS: /tmp is a symlink to /private/tmp; iOS sandbox tmp lives
    // under /private/var/folders/... — both already covered by
    // env::temp_dir() and dirs::data_dir() respectively, but list them
    // explicitly so unusual layouts (e.g. sandbox shifts) still resolve.
    #[cfg(target_os = "macos")]
    {
        allowed.push(std::path::PathBuf::from("/tmp"));
        allowed.push(std::path::PathBuf::from("/private/tmp"));
        allowed.push(std::path::PathBuf::from("/private/var/folders"));
    }
    for root in &allowed {
        if path.starts_with(root) { return Ok(()); }
    }
    Err(format!(
        "write_binary_file: refusing to write outside home/data/temp roots: {}",
        path.display()
    ))
}

/// Strip a `file://` prefix (iOS document-picker URLs) and percent-decode
/// the remainder. A bare filesystem path passes through untouched. Kept
/// simple — no UTF-8 validation beyond what path APIs require — because
/// the input is always a user-picked destination, not untrusted.
fn normalize_dialog_path(raw: &str) -> String {
    let trimmed = raw.strip_prefix("file://").unwrap_or(raw);
    // On iOS the URL looks like `file:///private/var/...` — stripping
    // `file://` leaves `/private/...`, which is already a valid path.
    percent_decode(trimmed)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_digit(bytes[i + 1]), hex_digit(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
