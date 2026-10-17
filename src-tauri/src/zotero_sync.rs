//! Settings → Zotero's two downloads, References and Highlights, as a
//! sync engine ported from zotero-helper (`src-tauri/src/zotero/sync.rs`
//! there).
//!
//! Each download keeps a **raw cache** of its own: every item Zotero
//! sent, as `{ key, version, data }`, and the library version the cache
//! reflects — in the same file, so the items and the version they answer
//! to are always written, and read back, together. The files the rest of
//! Hush reads (`zotero_references.json`, `zotero_collections.json`,
//! `zotero_highlights.json`) are rebuilt from the cache at the end of
//! every sync, in the shapes they have always had.
//!
//! - **Full download**: every page in `dateAdded asc` order (append-only
//!   stable: an item added mid-download lands at the tail instead of
//!   shifting pages already fetched), each page journaled to disk so an
//!   interrupted download resumes where it stopped. Then an update pass
//!   for whatever changed while it ran.
//! - **Update**: `items?since=<version>` and `deleted?since=<version>`,
//!   replace by key and remove by key. `includeTrashed=1`, so an item
//!   moved to the trash arrives with `deleted` set and drops out of the
//!   files (without it, Zotero leaves it out of `since` answers and it
//!   would never leave). The version recorded is the first page's —
//!   anything changed after it is fetched again next time — and a pass
//!   during which the library moved is run again, since a deletion can
//!   shift an item across a page boundary.
//!
//! References and Highlights are separate queries (`itemType=-annotation`
//! / `itemType=annotation`) with separate caches and versions, so each
//! section downloads and updates on its own, as before.
//!
//! Nothing here knows about Tauri: progress and cancel come in as a
//! callback and a flag (`commands/zotero.rs#zotero_sync` wires them up).

use crate::atomic::write_atomic_str;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const API: &str = "https://api.zotero.org";
const PAGE: usize = 100;
const MAX_ATTEMPTS: u32 = 4;
const CHECKPOINT_MAX_AGE_MS: u64 = 24 * 3600 * 1000;
/// How many times an update pass is run while the library keeps
/// changing under it; the last one is kept whatever happened.
const MAX_PASSES: usize = 3;

/// The error a cancelled sync returns (the frontend turns it into an
/// `AbortError`).
pub const CANCELLED: &str = "cancelled";

/// `(message, fraction done)`.
pub type Progress<'a> = &'a (dyn Fn(&str, f64) + Send + Sync);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    References,
    Highlights,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> {
        match s {
            "references" => Some(Kind::References),
            "highlights" => Some(Kind::Highlights),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Kind::References => "references",
            Kind::Highlights => "highlights",
        }
    }

    fn item_type_filter(self) -> &'static str {
        match self {
            Kind::References => "-annotation",
            Kind::Highlights => "annotation",
        }
    }

    fn noun(self) -> &'static str {
        match self {
            Kind::References => "items",
            Kind::Highlights => "highlights",
        }
    }

    fn cache_path(self, dir: &Path) -> PathBuf {
        dir.join(format!("zotero_library_{}.json", self.name()))
    }

    fn checkpoint_path(self, dir: &Path) -> PathBuf {
        dir.join(format!("zotero_sync_checkpoint_{}.jsonl", self.name()))
    }

    /// Whether an item belongs in this cache. Notes come with the
    /// references' query — `itemType` takes one negation, and annotations
    /// are the one worth excluding — and are dropped: nothing reads them.
    fn keeps(self, item: &Value) -> bool {
        let t = item_type(item);
        match self {
            Kind::References => t != "note" && t != "annotation",
            Kind::Highlights => t == "annotation",
        }
    }
}

// ---------------------------------------------------------------- running

fn running() -> &'static Mutex<HashMap<&'static str, Arc<AtomicBool>>> {
    static RUNNING: OnceLock<Mutex<HashMap<&'static str, Arc<AtomicBool>>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

/// One sync of a kind at a time; holds its cancel flag until dropped.
pub struct Running {
    kind: Kind,
    flag: Arc<AtomicBool>,
}

impl Running {
    pub fn start(kind: Kind) -> Result<Running, String> {
        let mut map = running().lock().unwrap();
        if map.contains_key(kind.name()) {
            return Err(format!(
                "A Zotero {} download is already running",
                kind.name()
            ));
        }
        let flag = Arc::new(AtomicBool::new(false));
        map.insert(kind.name(), flag.clone());
        Ok(Running { kind, flag })
    }

    pub fn flag(&self) -> &AtomicBool {
        &self.flag
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        running().lock().unwrap().remove(self.kind.name());
    }
}

/// Ask the running sync of `kind` to stop. It stops before its next
/// request (the one in flight finishes). False when none is running.
pub fn cancel(kind: Kind) -> bool {
    match running().lock().unwrap().get(kind.name()) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        Err(CANCELLED.to_string())
    } else {
        Ok(())
    }
}

/// Wait without blocking the async runtime, giving up early on cancel.
async fn sleep_cancellable(secs: u64, cancel: &AtomicBool) -> Result<(), String> {
    let mut left = secs * 1000;
    while left > 0 {
        check_cancel(cancel)?;
        let step = left.min(250);
        let _ = tauri::async_runtime::spawn_blocking(move || {
            std::thread::sleep(Duration::from_millis(step))
        })
        .await;
        left -= step;
    }
    check_cancel(cancel)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- cache

#[derive(Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RawCache {
    /// The library version these items reflect; 0 = never downloaded.
    pub version: u64,
    /// Whose library — a different user ID means a full download.
    pub user_id: String,
    pub last_sync_ms: u64,
    pub items: Vec<Value>,
}

fn load_cache(dir: &Path, kind: Kind) -> RawCache {
    std::fs::read_to_string(kind.cache_path(dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_cache(dir: &Path, kind: Kind, cache: &RawCache) -> Result<u64, String> {
    let text = serde_json::to_string(cache).map_err(|e| e.to_string())?;
    write_atomic_str(&kind.cache_path(dir), &text).map_err(|e| e.to_string())?;
    Ok(text.len() as u64)
}

// ---------------------------------------------------------------- checkpoint

/// Journal of a full download: line 0 is `{"version","startedMs",
/// "userId"}`, each further line one page as `{"n": items Zotero sent,
/// "items": the ones kept}`. A truncated last line (a crash mid-write)
/// is ignored.
struct Checkpoint {
    version: u64,
    started_ms: u64,
    user_id: String,
    fetched: usize,
    items: Vec<Value>,
}

fn load_checkpoint(path: &Path) -> Option<Checkpoint> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut lines = text.lines();
    let header: Value = serde_json::from_str(lines.next()?).ok()?;
    let version = header["version"].as_u64().filter(|v| *v > 0)?;
    let started_ms = header["startedMs"].as_u64()?;
    let user_id = header["userId"].as_str()?.to_string();
    let mut fetched = 0usize;
    let mut items = Keyed::default();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(page) = serde_json::from_str::<Value>(line) else {
            break;
        };
        let (Some(n), Some(kept)) = (page["n"].as_u64(), page["items"].as_array()) else {
            break;
        };
        fetched += n as usize;
        for item in kept {
            items.upsert(item.clone());
        }
    }
    Some(Checkpoint {
        version,
        started_ms,
        user_id,
        fetched,
        items: items.into_vec(),
    })
}

fn start_checkpoint(path: &Path, version: u64, user_id: &str) -> Result<(), String> {
    let header = json!({ "version": version, "startedMs": now_ms(), "userId": user_id });
    std::fs::write(path, format!("{header}\n")).map_err(|e| e.to_string())
}

fn append_checkpoint_page(path: &Path, n: usize, kept: &[Value]) -> std::io::Result<()> {
    use std::io::Write;
    let line = json!({ "n": n, "items": kept }).to_string();
    let mut f = std::fs::OpenOptions::new().append(true).open(path)?;
    f.write_all(line.as_bytes())?;
    f.write_all(b"\n")
}

// ---------------------------------------------------------------- syncs

fn pct(done: usize, total: usize) -> f64 {
    if total == 0 {
        1.0
    } else {
        (done as f64 / total as f64).min(1.0)
    }
}

/// Every item of `kind`, journaling each page so an interrupted download
/// resumes. Returns the items and the library version captured when the
/// download *started* — the baseline the catch-up pass asks from.
async fn fetch_all_resumable(
    api: &Api,
    kind: Kind,
    dir: &Path,
    user_id: &str,
    cancel: &AtomicBool,
    progress: Progress<'_>,
) -> Result<(Vec<Value>, u64), String> {
    let ckpt = kind.checkpoint_path(dir);
    let mut items = Keyed::default();
    let mut fetched = 0usize;
    let mut baseline = 0u64;
    if let Some(c) = load_checkpoint(&ckpt) {
        if c.user_id == user_id && now_ms().saturating_sub(c.started_ms) < CHECKPOINT_MAX_AGE_MS {
            eprintln!(
                "[zotero sync] resuming the {} download at item {}",
                kind.name(),
                c.fetched
            );
            baseline = c.version;
            fetched = c.fetched;
            items = Keyed::from_vec(c.items);
        } else {
            let _ = std::fs::remove_file(&ckpt);
        }
    }
    loop {
        let page = api.items_page(kind, None, fetched, cancel).await?;
        if baseline == 0 {
            baseline = page.version.max(1);
            start_checkpoint(&ckpt, baseline, user_id)?;
        }
        let n = page.items.len();
        let kept: Vec<Value> = page
            .items
            .into_iter()
            .filter(|i| kind.keeps(i))
            .map(slim)
            .collect();
        if let Err(e) = append_checkpoint_page(&ckpt, n, &kept) {
            eprintln!("[zotero sync] could not journal download progress: {e}");
        }
        for item in kept {
            items.upsert(item);
        }
        fetched += n;
        let total = page.total.max(fetched);
        progress(
            &format!("Downloading {} ({fetched} of {total})...", kind.noun()),
            0.02 + 0.88 * pct(fetched, total),
        );
        if n < PAGE || fetched >= page.total {
            break;
        }
    }
    Ok((items.into_vec(), baseline))
}

/// Everything of `kind` changed since `since`, the keys deleted since,
/// and the version to record next.
async fn fetch_changes(
    api: &Api,
    kind: Kind,
    since: u64,
    cancel: &AtomicBool,
    progress: Progress<'_>,
) -> Result<(Vec<Value>, Vec<String>, u64), String> {
    for pass in 1..=MAX_PASSES {
        progress("Checking for changes...", 0.02);
        let mut changed = Keyed::default();
        let mut first = 0u64;
        let mut last;
        let mut start = 0usize;
        loop {
            let page = api.items_page(kind, Some(since), start, cancel).await?;
            if start == 0 {
                first = page.version;
            }
            last = page.version;
            let n = page.items.len();
            for item in page.items {
                if kind.keeps(&item) {
                    changed.upsert(slim(item));
                }
            }
            start += n;
            let total = page.total.max(start);
            progress(
                &format!("Fetching changed {} ({start} of {total})...", kind.noun()),
                0.05 + 0.75 * pct(start, total),
            );
            if n < PAGE || start >= page.total {
                break;
            }
        }
        progress("Checking for deletions...", 0.85);
        let (deleted, _) = api.deleted_since(since, cancel).await?;
        if first == last || pass == MAX_PASSES {
            // Changes after the first page carry a later version, so the
            // next update asks for them again.
            let version = if first == 0 { since } else { first.max(since) };
            return Ok((changed.into_vec(), deleted, version));
        }
        eprintln!("[zotero sync] the library changed during the update (v{first} → v{last}); running it again");
    }
    unreachable!()
}

async fn update_pass(
    api: &Api,
    kind: Kind,
    cache: &mut RawCache,
    cancel: &AtomicBool,
    progress: Progress<'_>,
) -> Result<Changes, String> {
    let (changed, deleted, version) =
        fetch_changes(api, kind, cache.version, cancel, progress).await?;
    let (items, changes) = apply_changes(std::mem::take(&mut cache.items), changed, &deleted);
    cache.items = items;
    cache.version = version;
    cache.last_sync_ms = now_ms();
    Ok(changes)
}

/// What a sync did, for Settings → Zotero's description of the file.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// A full download (asked for, or because there was no cache).
    pub full: bool,
    /// References, or highlights, in the file the app reads.
    pub count: usize,
    /// That file's size.
    pub file_bytes: u64,
    /// The raw cache's size.
    pub cache_bytes: u64,
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub version: u64,
}

/// Run one download: `full`, or an update since the cached version (a
/// full download anyway when there is no cache, or it is someone
/// else's). A cancel or failure before the end leaves every file as it
/// was; a full download's journal stays for the next one to resume.
pub async fn sync(
    dir: &Path,
    kind: Kind,
    full: bool,
    user_id: &str,
    api_key: &str,
    cancel: &AtomicBool,
    progress: Progress<'_>,
) -> Result<Summary, String> {
    sync_from(API, dir, kind, full, user_id, api_key, cancel, progress).await
}

/// `sync` against any API root (a test server's).
#[allow(clippy::too_many_arguments)]
async fn sync_from(
    root: &str,
    dir: &Path,
    kind: Kind,
    full: bool,
    user_id: &str,
    api_key: &str,
    cancel: &AtomicBool,
    progress: Progress<'_>,
) -> Result<Summary, String> {
    if user_id.is_empty() || api_key.is_empty() {
        return Err("Zotero credentials are missing — set them in Settings → Zotero".into());
    }
    let api = Api::new(root, user_id, api_key)?;
    let mut cache = load_cache(dir, kind);
    let full = full || cache.version == 0 || cache.user_id != user_id;
    let mut changes = Changes::default();

    if full {
        let (items, baseline) =
            fetch_all_resumable(&api, kind, dir, user_id, cancel, progress).await?;
        cache = RawCache {
            version: baseline,
            user_id: user_id.to_string(),
            last_sync_ms: now_ms(),
            items,
        };
        save_cache(dir, kind, &cache)?;
        let _ = std::fs::remove_file(kind.checkpoint_path(dir));
        // Catch what changed while the download ran. The download is
        // already saved, and `update_pass` changes the cache only once
        // its requests have all answered, so a failure (or a cancel) here
        // costs nothing the next update won't fetch.
        let tail = |msg: &str, pct: f64| progress(msg, 0.9 + 0.02 * pct);
        match update_pass(&api, kind, &mut cache, cancel, &tail).await {
            Ok(_) => {
                save_cache(dir, kind, &cache)?;
            }
            Err(e) => {
                eprintln!("[zotero sync] catch-up after the download failed (the next update heals it): {e}");
            }
        }
    } else {
        changes = update_pass(&api, kind, &mut cache, cancel, progress).await?;
        save_cache(dir, kind, &cache)?;
    }

    // From here the cache is saved: the files are rebuilt from it whatever
    // happens, so a cancel now is too late to matter.
    let (count, file_bytes) = match kind {
        Kind::References => {
            progress("Fetching collections...", 0.92);
            let never = AtomicBool::new(false);
            match api.collections(&never).await {
                Ok(raw) => {
                    write_json(
                        dir,
                        "zotero_collections.json",
                        &Value::Array(derive_collections(&raw)),
                    )?;
                }
                Err(e) => {
                    eprintln!("[zotero sync] collections unavailable, keeping the last ones: {e}")
                }
            }
            progress("Saving...", 0.97);
            let refs = derive_references(&cache.items);
            let n = refs.len();
            (
                n,
                write_json(dir, "zotero_references.json", &Value::Array(refs))?,
            )
        }
        Kind::Highlights => {
            progress("Saving...", 0.97);
            let (by_att, n) = derive_highlights(&cache.items);
            (n, write_json(dir, "zotero_highlights.json", &by_att)?)
        }
    };
    let cache_bytes = std::fs::metadata(kind.cache_path(dir))
        .map(|m| m.len())
        .unwrap_or(0);
    progress("Done!", 1.0);
    Ok(Summary {
        full,
        count,
        file_bytes,
        cache_bytes,
        added: changes.added,
        updated: changes.updated,
        removed: changes.removed,
        version: cache.version,
    })
}

fn write_json(dir: &Path, name: &str, value: &Value) -> Result<u64, String> {
    let text = serde_json::to_string(value).map_err(|e| e.to_string())?;
    write_atomic_str(&dir.join(name), &text).map_err(|e| e.to_string())?;
    Ok(text.len() as u64)
}

#[path = "zotero_sync_api.rs"]
mod api;
#[path = "zotero_sync_items.rs"]
mod items;
use api::Api;
use items::*;

#[cfg(test)]
#[path = "zotero_sync_mock_tests.rs"]
mod mock_tests;
#[cfg(test)]
#[path = "zotero_sync_tests.rs"]
mod tests;
