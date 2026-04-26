//! Atomic file writes — `write tmp → fsync → rename`.
//!
//! `fs::write()` is two operations under the hood (truncate + write),
//! so a crash or power loss between them leaves the destination in a
//! partially-written state. Every long-lived store in the app
//! (settings.json, files/{uuid}.json, file_tree.json, images) routes
//! through this helper so the worst-case state on disk is *the previous
//! version*, never a mangled half-write.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Write `bytes` to `path` atomically. Returns the underlying I/O error
/// if any step fails. Writes happen in the same directory as `path` so
/// the rename is guaranteed to be atomic on the same filesystem.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = tmp_path_for(path);
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        // Flush to disk before rename so a power loss between rename
        // and writeback can't lose data.
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

/// Convenience for string payloads.
pub fn write_atomic_str(path: &Path, content: &str) -> std::io::Result<()> {
    write_atomic(path, content.as_bytes())
}

/// `<path>.tmp` — same directory so the rename is intra-fs (atomic).
fn tmp_path_for(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".tmp");
    let mut tmp = path.to_path_buf();
    tmp.set_file_name(name);
    tmp
}
