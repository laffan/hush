/* commands/backup.rs
 *
 * Bundles the user's Hush data directory into a single .zip and writes
 * it to a caller-supplied path. The frontend collects the destination
 * via tauri-plugin-dialog and calls this command from the
 * "Backup App Data" command palette entry.
 *
 * Versions are excluded — the backup is meant to capture authored
 * content + settings + Zotero / sync metadata so a user can restore on
 * another machine without dragging along the snapshots.db rolling
 * history.
 *
 * Progress is reported via a `backup-progress` event whose payload is
 * `{ processed: u64, total: u64, currentFile: String }` so the modal
 * can render a progress bar without polling.
 */

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter};
use zip::write::FileOptions;
use zip::CompressionMethod;

#[derive(serde::Serialize)]
pub struct BackupResult {
    pub path: String,
    pub bytes: u64,
    pub file_count: u64,
}

#[derive(serde::Serialize, Clone)]
struct BackupProgress {
    processed: u64,
    total: u64,
    #[serde(rename = "currentFile")]
    current_file: String,
}

/// Recursively collect a list of (absolute_path, archive_relative_path)
/// pairs under `root`, skipping the snapshots database and any temp /
/// lock files that aren't useful in a portable backup.
fn collect_files(root: &Path) -> std::io::Result<Vec<(PathBuf, String)>> {
    let mut out = Vec::new();
    let root = root.to_path_buf();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            // Skip versions / snapshot history per spec.
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                if name == "snapshots.db" || name == "snapshots.db-journal" {
                    continue;
                }
                if name.ends_with(".tmp") || name.ends_with(".bak") {
                    continue;
                }
            }
            if p.is_dir() {
                stack.push(p);
            } else if p.is_file() {
                let rel = p.strip_prefix(&root).unwrap_or(&p);
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                out.push((p, rel_str));
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn backup_app_data(app: AppHandle, destination: String) -> Result<BackupResult, String> {
    let data_dir = crate::get_data_dir();
    if !data_dir.exists() {
        return Err("Hush data directory does not exist".to_string());
    }

    let dest_path = PathBuf::from(&destination);
    if let Some(parent) = dest_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create destination dir: {e}"))?;
        }
    }

    let files = collect_files(&data_dir).map_err(|e| format!("scan data dir: {e}"))?;
    let total = files.len() as u64;

    let f = File::create(&dest_path).map_err(|e| format!("create zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(f);
    let opts = FileOptions::default().compression_method(CompressionMethod::Deflated);

    let mut bytes_written: u64 = 0;
    for (idx, (abs, rel)) in files.iter().enumerate() {
        // Best-effort progress event after every file. The modal listens
        // for these and updates its bar; if no listener is registered
        // (headless test, etc.) the emit is a no-op.
        let _ = app.emit(
            "backup-progress",
            BackupProgress {
                processed: idx as u64,
                total,
                current_file: rel.clone(),
            },
        );

        zip.start_file(rel, opts).map_err(|e| format!("zip start: {e}"))?;
        let mut input = match File::open(abs) {
            Ok(x) => x,
            Err(_) => continue,
        };
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = match input.read(&mut buf) {
                Ok(n) => n,
                Err(e) => return Err(format!("read {}: {e}", rel)),
            };
            if n == 0 {
                break;
            }
            zip.write_all(&buf[..n]).map_err(|e| format!("zip write: {e}"))?;
            bytes_written += n as u64;
        }
    }

    zip.finish().map_err(|e| format!("zip finalize: {e}"))?;

    let _ = app.emit(
        "backup-progress",
        BackupProgress {
            processed: total,
            total,
            current_file: String::new(),
        },
    );

    Ok(BackupResult {
        path: dest_path.to_string_lossy().to_string(),
        bytes: bytes_written,
        file_count: total,
    })
}
