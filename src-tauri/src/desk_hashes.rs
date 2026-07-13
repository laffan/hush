//! Content-hash cache for external-rename pairing.
//!
//! A rename done outside Hush (Finder, another install on the far side
//! of a synced folder) reaches the reconciler as a *remove + add* — the
//! path is the only identity the filesystem offers. To keep the fileId
//! (and with it version history, open panes, recents) across such a
//! rename, each desk carries `.hush/hashes.json`: fileId → the FNV-1a
//! hash of the file's on-disk bytes, plus the mtime the hash was taken
//! at. The reconciler pairs a vanished index entry with an added file of
//! identical hash and kind, and treats the pair as a rename.
//!
//! The cache is best-effort derived state: it is refreshed on every
//! content save and on every reconcile pass, so losing it (or losing a
//! write race in a synced folder) costs at worst one pairing — the
//! fallback is the plain remove + add the reconciler always did.
//! Images are excluded throughout: their fileId *is* their filename, so
//! an external rename is genuinely a different file.

use crate::desk_store::DeskStore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

type BoxError = Box<dyn std::error::Error>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct HashEntry {
    pub hash: String,
    /// mtime (ms since epoch) of the file when `hash` was computed —
    /// the staleness check for the cache.
    pub mtime: u64,
}

/// 64-bit FNV-1a as lowercase hex. Not cryptographic — it only needs to
/// distinguish sibling files, and it's dependency-free and fast.
pub fn fnv1a_hex(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:016x}", h)
}

pub fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize, Deserialize, Default)]
struct HashFile {
    #[serde(default)]
    hashes: HashMap<String, HashEntry>,
}

impl DeskStore {
    fn hashes_path(&self, desk_id: &str) -> PathBuf {
        self.desk_dir(desk_id).join(".hush").join("hashes.json")
    }

    pub fn load_hashes(&self, desk_id: &str) -> HashMap<String, HashEntry> {
        fs::read_to_string(self.hashes_path(desk_id))
            .ok()
            .and_then(|s| serde_json::from_str::<HashFile>(&s).ok())
            .map(|f| f.hashes)
            .unwrap_or_default()
    }

    pub fn save_hashes(
        &self,
        desk_id: &str,
        hashes: &HashMap<String, HashEntry>,
    ) -> Result<(), BoxError> {
        let file = HashFile { hashes: hashes.clone() };
        crate::atomic::write_atomic_str(
            &self.hashes_path(desk_id),
            &serde_json::to_string_pretty(&file)?,
        )?;
        Ok(())
    }

    /// Record one file's hash after a content write. Best-effort — a
    /// failure here only costs a future pairing.
    pub fn record_hash(&self, desk_id: &str, file_id: &str, hash: &str, mtime: u64) {
        let mut hashes = self.load_hashes(desk_id);
        let entry = HashEntry { hash: hash.to_string(), mtime };
        if hashes.get(file_id) == Some(&entry) {
            return;
        }
        hashes.insert(file_id.to_string(), entry);
        let _ = self.save_hashes(desk_id, &hashes);
    }
}
