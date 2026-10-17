//! Whole Zotero syncs against a small stand-in for the Web API
//! (`MockZotero`, a thread answering plain HTTP): full download, resume,
//! updates, trash, deletions, and what a failure or cancel leaves.

use super::tests::{annotation, article, item, pdf, tmp};
use super::*;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Mutex as StdMutex;

/// A library as the Zotero Web API serves it: versioned items (in
/// `dateAdded` order), the trash flag, `/deleted`, collections, and a
/// way to make one request fail.
#[derive(Default)]
struct Library {
    version: u64,
    /// Each with the version it last changed at.
    items: Vec<Value>,
    deleted: Vec<(String, u64)>,
    collections: Vec<Value>,
    /// Answer 400 to the request whose query contains this, once.
    fail_once: Option<String>,
    log: Vec<String>,
}

impl Library {
    fn put(&mut self, mut it: Value) {
        self.version += 1;
        it["version"] = json!(self.version);
        let key = it["key"].as_str().unwrap().to_string();
        match self.items.iter_mut().find(|i| i["key"] == key) {
            Some(slot) => *slot = it,
            None => self.items.push(it),
        }
    }

    fn delete(&mut self, key: &str) {
        self.version += 1;
        self.items.retain(|i| i["key"] != key);
        self.deleted.push((key.to_string(), self.version));
    }

    fn trash(&mut self, key: &str) {
        let mut it = self.items.iter().find(|i| i["key"] == key).unwrap().clone();
        it["data"]["deleted"] = json!(1);
        self.put(it);
    }

    fn answer(
        &mut self,
        path: &str,
        query: &HashMap<String, String>,
        raw_query: &str,
    ) -> (u16, String, usize) {
        self.log.push(format!("{path}?{raw_query}"));
        if let Some(f) = &self.fail_once {
            if raw_query.contains(f.as_str()) {
                self.fail_once = None;
                return (400, "bad".into(), 0);
            }
        }
        let since: u64 = query.get("since").and_then(|s| s.parse().ok()).unwrap_or(0);
        if path.ends_with("/deleted") {
            let keys: Vec<&str> = self
                .deleted
                .iter()
                .filter(|(_, v)| *v > since)
                .map(|(k, _)| k.as_str())
                .collect();
            return (
                200,
                json!({ "items": keys, "collections": [] }).to_string(),
                0,
            );
        }
        if path.ends_with("/collections") {
            return (
                200,
                Value::Array(self.collections.clone()).to_string(),
                self.collections.len(),
            );
        }
        let filter = query.get("itemType").cloned().unwrap_or_default();
        let trashed_too = query.get("includeTrashed").map(String::as_str) == Some("1");
        let matching: Vec<Value> = self
            .items
            .iter()
            .filter(|i| i["version"].as_u64().unwrap() > since)
            .filter(|i| trashed_too || !is_trashed(i))
            .filter(|i| match filter.strip_prefix('-') {
                Some(not) => i["data"]["itemType"] != not,
                None => filter.is_empty() || i["data"]["itemType"] == filter.as_str(),
            })
            .map(|i| {
                let mut full = i.clone();
                full["links"] = json!({ "self": {} });
                full["meta"] = json!({ "numChildren": 0 });
                full["library"] = json!({ "type": "user" });
                full
            })
            .collect();
        let start: usize = query.get("start").and_then(|s| s.parse().ok()).unwrap_or(0);
        let limit: usize = query
            .get("limit")
            .and_then(|s| s.parse().ok())
            .unwrap_or(25);
        let page: Vec<Value> = matching.iter().skip(start).take(limit).cloned().collect();
        (200, Value::Array(page).to_string(), matching.len())
    }
}

struct MockZotero {
    root: String,
    lib: Arc<StdMutex<Library>>,
}

impl MockZotero {
    fn start(lib: Library) -> MockZotero {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let lib = Arc::new(StdMutex::new(lib));
        let shared = lib.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                let target = request_line
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("/")
                    .to_string();
                let (path, raw_query) = target.split_once('?').unwrap_or((&target, ""));
                let query: HashMap<String, String> = raw_query
                    .split('&')
                    .filter_map(|kv| kv.split_once('='))
                    .map(|(k, v)| (k.to_string(), v.replace("%2D", "-")))
                    .collect();
                let (status, body, total) = {
                    let mut lib = shared.lock().unwrap();
                    let answer = lib.answer(path, &query, raw_query);
                    (answer.0, answer.1, (answer.2, lib.version))
                };
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nTotal-Results: {}\r\nLast-Modified-Version: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len(),
                    total.0,
                    total.1,
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        MockZotero { root, lib }
    }

    fn lib(&self) -> std::sync::MutexGuard<'_, Library> {
        self.lib.lock().unwrap()
    }
}

fn run(z: &MockZotero, dir: &Path, kind: Kind, full: bool) -> Result<Summary, String> {
    let never = AtomicBool::new(false);
    let progress = |_: &str, _: f64| {};
    tauri::async_runtime::block_on(sync_from(
        &z.root, dir, kind, full, "1", "key", &never, &progress,
    ))
}

fn read_json(dir: &Path, name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(dir.join(name)).unwrap()).unwrap()
}

fn ref_keys(dir: &Path) -> Vec<String> {
    let mut k: Vec<String> = read_json(dir, "zotero_references.json")
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["key"].as_str().unwrap().to_string())
        .collect();
    k.sort();
    k
}

fn library(n: usize) -> Library {
    let mut lib = Library {
        collections: vec![
            json!({ "key": "C1", "version": 1, "data": { "name": "Folder", "parentCollection": false } }),
        ],
        ..Default::default()
    };
    for i in 0..n {
        lib.put(article(&format!("A{i:03}"), &format!("Paper {i}")));
        lib.put(pdf(&format!("P{i:03}"), &format!("A{i:03}")));
        lib.put(annotation(&format!("H{i:03}"), &format!("P{i:03}")));
        lib.put(item(
            &format!("N{i:03}"),
            1,
            json!({ "itemType": "note", "parentItem": format!("A{i:03}") }),
        ));
    }
    lib
}

#[test]
fn full_download_then_updates_fold_in_only_the_changes() {
    let dir = tmp();
    let z = MockZotero::start(library(60)); // 180 non-annotation items: two pages
    let s = run(&z, dir.path(), Kind::References, false).unwrap();
    assert!(s.full, "no cache yet, so a full download");
    assert_eq!(s.count, 60);
    assert_eq!(s.version, z.lib().version);
    assert_eq!(
        read_json(dir.path(), "zotero_collections.json")[0]["name"],
        "Folder"
    );
    let cache = load_cache(dir.path(), Kind::References);
    assert_eq!(cache.items.len(), 120, "notes are not kept");
    assert!(cache.items.iter().all(|i| i.get("links").is_none()));
    assert!(!Kind::References.checkpoint_path(dir.path()).exists());

    // Nothing changed: one request for items, one for deletions.
    z.lib().log.clear();
    let s = run(&z, dir.path(), Kind::References, false).unwrap();
    assert!(!s.full);
    assert_eq!((s.added, s.updated, s.removed), (0, 0, 0));
    let log = z.lib().log.clone();
    assert!(
        log.iter()
            .any(|l| l.contains("since=") && l.starts_with("/users/1/items")),
        "{log:?}"
    );
    assert_eq!(
        log.iter()
            .filter(|l| l.starts_with("/users/1/items"))
            .count(),
        1,
        "{log:?}"
    );

    // Edit, add, trash, delete, and a highlight change (not ours).
    {
        let mut lib = z.lib();
        lib.put(article("A001", "Edited"));
        lib.put(article("NEW", "Brand new"));
        lib.put(pdf("NEWP", "NEW"));
        lib.trash("A002");
        lib.delete("A003");
        lib.delete("P003");
        lib.put(annotation("H010", "P010"));
    }
    let s = run(&z, dir.path(), Kind::References, false).unwrap();
    assert!(!s.full);
    assert_eq!((s.added, s.updated, s.removed), (2, 1, 3));
    assert_eq!(s.count, 59);
    assert_eq!(s.version, z.lib().version);
    let keys = ref_keys(dir.path());
    assert!(keys.contains(&"NEW".to_string()));
    assert!(!keys.contains(&"A002".to_string()) && !keys.contains(&"A003".to_string()));
    assert!(
        !load_cache(dir.path(), Kind::References)
            .items
            .iter()
            .any(|i| i["key"] == "A002"),
        "a trashed item leaves the cache too"
    );
    let refs = read_json(dir.path(), "zotero_references.json");
    let edited = refs
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["key"] == "A001")
        .unwrap();
    assert_eq!(edited["title"], "Edited");
    assert_eq!(
        edited["attachments"][0]["key"], "P001",
        "an edited reference keeps its attachments"
    );
    let new = refs
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["key"] == "NEW")
        .unwrap();
    assert_eq!(new["attachments"][0]["key"], "NEWP");

    // Out of the trash again.
    let restored = {
        let mut lib = z.lib();
        let mut it = lib
            .items
            .iter()
            .find(|i| i["key"] == "A002")
            .unwrap()
            .clone();
        it["data"].as_object_mut().unwrap().remove("deleted");
        lib.put(it.clone());
        it
    };
    let s = run(&z, dir.path(), Kind::References, false).unwrap();
    assert_eq!((s.added, s.updated, s.removed), (1, 0, 0));
    assert!(ref_keys(dir.path()).contains(&restored["key"].as_str().unwrap().to_string()));
}

#[test]
fn a_full_download_keeps_nothing_from_the_trash() {
    let dir = tmp();
    let mut lib = library(3);
    lib.trash("A001");
    lib.trash("H002");
    let z = MockZotero::start(lib);
    // With the catch-up pass failing, the download alone must leave the
    // trash out (an update would clean it up anyway).
    z.lib().fail_once = Some("since=".into());
    let refs = run(&z, dir.path(), Kind::References, true).unwrap();
    z.lib().fail_once = Some("since=".into());
    let highlights = run(&z, dir.path(), Kind::Highlights, true).unwrap();
    assert_eq!((refs.count, highlights.count), (2, 2));
    for kind in [Kind::References, Kind::Highlights] {
        let cache = load_cache(dir.path(), kind);
        assert!(!cache.items.iter().any(is_trashed), "{kind:?}");
    }
}

#[test]
fn highlights_sync_on_their_own() {
    let dir = tmp();
    let z = MockZotero::start(library(5));
    let s = run(&z, dir.path(), Kind::Highlights, false).unwrap();
    assert!(s.full);
    assert_eq!(s.count, 5);
    assert!(!dir.path().join("zotero_references.json").exists());
    {
        let mut lib = z.lib();
        lib.put(annotation("H100", "P001"));
        lib.delete("H002");
        lib.put(article("A001", "Not a highlight"));
    }
    let s = run(&z, dir.path(), Kind::Highlights, false).unwrap();
    assert_eq!((s.added, s.updated, s.removed), (1, 0, 1));
    let by_att = read_json(dir.path(), "zotero_highlights.json");
    assert_eq!(by_att["P001"].as_array().unwrap().len(), 2);
    assert!(by_att.get("P002").is_none());
    assert_eq!(s.count, 5);
}

#[test]
fn an_interrupted_download_resumes_where_it_stopped() {
    let dir = tmp();
    let z = MockZotero::start(library(60));
    z.lib().fail_once = Some("start=100".into());
    let err = run(&z, dir.path(), Kind::References, false).unwrap_err();
    assert!(err.contains("400"), "{err}");
    assert!(Kind::References.checkpoint_path(dir.path()).exists());
    assert!(
        !dir.path().join("zotero_references.json").exists(),
        "nothing written but the journal"
    );

    z.lib().put(article("LATE", "Added while interrupted"));
    z.lib().log.clear();
    let s = run(&z, dir.path(), Kind::References, false).unwrap();
    assert!(s.full);
    let log = z.lib().log.clone();
    let full_pages: Vec<&String> = log
        .iter()
        .filter(|l| l.starts_with("/users/1/items") && !l.contains("since="))
        .collect();
    assert_eq!(full_pages.len(), 1, "only the missing page: {log:?}");
    assert!(full_pages[0].contains("start=100"));
    assert_eq!(
        s.count, 61,
        "the catch-up pass brings in what arrived meanwhile"
    );
    assert!(!Kind::References.checkpoint_path(dir.path()).exists());
}

#[test]
fn a_failed_update_leaves_every_file_as_it_was() {
    let dir = tmp();
    let z = MockZotero::start(library(3));
    run(&z, dir.path(), Kind::References, false).unwrap();
    let before = std::fs::read_to_string(dir.path().join("zotero_references.json")).unwrap();
    let version = load_cache(dir.path(), Kind::References).version;
    {
        let mut lib = z.lib();
        lib.put(article("NEW", "x"));
        lib.fail_once = Some("since=".into());
    }
    assert!(run(&z, dir.path(), Kind::References, false).is_err());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("zotero_references.json")).unwrap(),
        before
    );
    assert_eq!(load_cache(dir.path(), Kind::References).version, version);
    // And the next one picks the change up.
    let s = run(&z, dir.path(), Kind::References, false).unwrap();
    assert_eq!(s.added, 1);
}

#[test]
fn another_users_cache_means_a_full_download() {
    let dir = tmp();
    let z = MockZotero::start(library(2));
    run(&z, dir.path(), Kind::References, false).unwrap();
    let mut cache = load_cache(dir.path(), Kind::References);
    cache.user_id = "someone else".into();
    save_cache(dir.path(), Kind::References, &cache).unwrap();
    assert!(run(&z, dir.path(), Kind::References, false).unwrap().full);
}

#[test]
fn a_cancelled_sync_writes_nothing() {
    let dir = tmp();
    let z = MockZotero::start(library(2));
    let cancelled = AtomicBool::new(true);
    let progress = |_: &str, _: f64| {};
    let err = tauri::async_runtime::block_on(sync_from(
        &z.root,
        dir.path(),
        Kind::References,
        true,
        "1",
        "key",
        &cancelled,
        &progress,
    ))
    .unwrap_err();
    assert_eq!(err, CANCELLED);
    assert!(!Kind::References.cache_path(dir.path()).exists());
    assert!(!dir.path().join("zotero_references.json").exists());
}
