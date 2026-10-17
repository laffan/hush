//! The items half of the Zotero sync (`zotero_sync.rs`): reading the
//! fields of an item as the Web API sends it, folding changes into the
//! raw cache, and the files the app reads, built from that cache.

use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};

// ---------------------------------------------------------------- items

pub(super) fn data_str<'a>(item: &'a Value, field: &str) -> &'a str {
    item.get("data")
        .and_then(|d| d.get(field))
        .and_then(Value::as_str)
        .unwrap_or("")
}

pub(super) fn item_type(item: &Value) -> &str {
    data_str(item, "itemType")
}

pub(super) fn key_of(item: &Value) -> Option<&str> {
    item.get("key")
        .and_then(Value::as_str)
        .filter(|k| !k.is_empty())
}

/// A child item's parent key — `parentItem` is absent (or `false`) on a
/// top-level item.
pub(super) fn parent_of(item: &Value) -> Option<&str> {
    Some(data_str(item, "parentItem")).filter(|k| !k.is_empty())
}

/// In Zotero's trash (`data.deleted`, sent as `1` or `true`).
pub(super) fn is_trashed(item: &Value) -> bool {
    match item.get("data").and_then(|d| d.get("deleted")) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        _ => false,
    }
}

/// What the cache keeps of an item: no `links`, `meta` or `library`.
pub(super) fn slim(item: Value) -> Value {
    match item {
        Value::Object(mut m) => {
            let mut out = Map::new();
            for field in ["key", "version", "data"] {
                if let Some(v) = m.remove(field) {
                    out.insert(field.to_string(), v);
                }
            }
            Value::Object(out)
        }
        other => other,
    }
}

/// Items by key, in a Vec with an index beside it.
#[derive(Default)]
pub(super) struct Keyed {
    pub(super) items: Vec<Value>,
    pub(super) index: HashMap<String, usize>,
}

impl Keyed {
    pub(super) fn from_vec(items: Vec<Value>) -> Keyed {
        let mut k = Keyed::default();
        for item in items {
            k.upsert(item);
        }
        k
    }

    /// Insert or replace; returns the item it replaced. Keyless items
    /// (Zotero sends none) are dropped.
    pub(super) fn upsert(&mut self, item: Value) -> Option<Value> {
        let key = key_of(&item)?.to_string();
        match self.index.get(&key) {
            Some(&i) => Some(std::mem::replace(&mut self.items[i], item)),
            None => {
                self.index.insert(key, self.items.len());
                self.items.push(item);
                None
            }
        }
    }

    pub(super) fn remove(&mut self, key: &str) -> Option<Value> {
        let i = self.index.remove(key)?;
        let out = self.items.swap_remove(i);
        if let Some(moved) = self.items.get(i).and_then(key_of) {
            self.index.insert(moved.to_string(), i);
        }
        Some(out)
    }

    pub(super) fn into_vec(self) -> Vec<Value> {
        self.items
    }
}

#[derive(Default, Debug, PartialEq)]
pub(super) struct Changes {
    pub(super) added: usize,
    pub(super) updated: usize,
    pub(super) removed: usize,
}

/// Fold `changed` and `deleted` into `items`, counting as the user would.
/// Hush has no trash of its own, so an item that arrives in Zotero's
/// trash is taken out of the cache like a deleted one (as zotero-helper
/// does), and one taken out of the trash arrives again as new. The cache
/// never holds a trashed item, so a full download's matches an update's.
pub(super) fn apply_changes(
    items: Vec<Value>,
    changed: Vec<Value>,
    deleted: &[String],
) -> (Vec<Value>, Changes) {
    let mut keyed = Keyed::from_vec(items);
    let mut ch = Changes::default();
    for item in changed {
        let Some(key) = key_of(&item).map(str::to_string) else {
            continue;
        };
        let had = keyed.index.get(&key).map(|&i| !is_trashed(&keyed.items[i]));
        if is_trashed(&item) {
            keyed.remove(&key);
            if had == Some(true) {
                ch.removed += 1;
            }
            continue;
        }
        if had == Some(true) {
            ch.updated += 1;
        } else {
            ch.added += 1;
        }
        keyed.upsert(item);
    }
    for key in deleted {
        if let Some(prev) = keyed.remove(key) {
            if !is_trashed(&prev) {
                ch.removed += 1;
            }
        }
    }
    let mut items = keyed.into_vec();
    // A cache written before trashed items were dropped may still hold some.
    items.retain(|i| !is_trashed(i));
    (items, ch)
}

// ---------------------------------------------------------------- the files the app reads

/// `zotero_references.json`: one entry per top-level item that isn't a
/// standalone attachment or note, newest edit first, its attachments
/// filed under it. The shape `zotero/api.js#fetchReferences` produces in
/// the browser build.
pub fn derive_references(items: &[Value]) -> Vec<Value> {
    let mut att_by_parent: HashMap<&str, Vec<&Value>> = HashMap::new();
    let mut tops: Vec<&Value> = Vec::new();
    for item in items {
        if is_trashed(item) {
            continue;
        }
        let t = item_type(item);
        match parent_of(item) {
            Some(parent) if t == "attachment" => {
                att_by_parent.entry(parent).or_default().push(item)
            }
            Some(_) => {}
            None if t != "attachment" && t != "note" && t != "annotation" && !t.is_empty() => {
                tops.push(item)
            }
            None => {}
        }
    }
    tops.sort_by(|a, b| {
        data_str(b, "dateModified")
            .cmp(data_str(a, "dateModified"))
            .then_with(|| key_of(a).cmp(&key_of(b)))
    });
    tops.into_iter()
        .map(|item| {
            let mut atts = key_of(item)
                .and_then(|k| att_by_parent.remove(k))
                .unwrap_or_default();
            atts.sort_by(|a, b| {
                data_str(a, "dateAdded")
                    .cmp(data_str(b, "dateAdded"))
                    .then_with(|| key_of(a).cmp(&key_of(b)))
            });
            to_reference(item, atts.into_iter().map(to_attachment).collect())
        })
        .collect()
}

fn str_of<'a>(v: &'a Value, field: &str) -> &'a str {
    v.get(field).and_then(Value::as_str).unwrap_or("")
}

/// `s || fallback`, as the JS this mirrors writes it.
fn or<'a>(s: &'a str, fallback: &'a str) -> &'a str {
    if s.is_empty() {
        fallback
    } else {
        s
    }
}

pub(super) fn to_attachment(att: &Value) -> Value {
    let d = &att["data"];
    let content_type = str_of(d, "contentType");
    let filename = str_of(d, "filename");
    let title = str_of(d, "title");
    let name = or(filename, title).to_lowercase();
    json!({
        "key": key_of(att).unwrap_or(""),
        "title": or(title, "Attachment"),
        "filename": filename,
        "contentType": content_type,
        "isPdf": content_type.to_lowercase().contains("pdf") || name.ends_with(".pdf"),
    })
}

fn to_reference(item: &Value, attachments: Vec<Value>) -> Value {
    let d = &item["data"];
    let creators: &[Value] = d
        .get("creators")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let authors = creators
        .iter()
        .map(|c| {
            let last = str_of(c, "lastName");
            if last.is_empty() {
                str_of(c, "name").to_string()
            } else {
                let initial: String = str_of(c, "firstName").chars().take(1).collect();
                format!("{last}, {initial}").trim().to_string()
            }
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("; ");
    let year = first_year(str_of(d, "date"));
    // First author's last name powers the `title (author)` format and the
    // citekey fallback when Better BibTeX hasn't supplied one.
    let first_author = creators
        .iter()
        .find(|c| !str_of(c, "lastName").is_empty() || !str_of(c, "name").is_empty())
        .map(|c| or(str_of(c, "lastName"), str_of(c, "name")))
        .unwrap_or("");
    // Better BibTeX surfaces the citation key either as a `citationKey`
    // field on newer Zotero APIs or in `extra` as `Citation Key: foo2020`.
    // Fall back to a slug otherwise.
    let mut citekey = str_of(d, "citationKey").to_string();
    if citekey.is_empty() {
        citekey = citation_key_from_extra(str_of(d, "extra")).unwrap_or_default();
    }
    if citekey.is_empty() {
        let slug: String = or(first_author, "ref")
            .to_lowercase()
            .chars()
            .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            .collect();
        citekey = format!("{slug}{year}");
    }
    let collections = match d.get("collections") {
        Some(Value::Array(a)) => Value::Array(a.clone()),
        _ => json!([]),
    };
    json!({
        "key": key_of(item).unwrap_or(""),
        "title": or(str_of(d, "title"), "Untitled"),
        "shortTitle": str_of(d, "shortTitle"),
        "authors": authors,
        "firstAuthor": first_author,
        "citekey": citekey,
        "year": year,
        "itemType": item_type(item),
        // Collection keys this item belongs to — what the library browser
        // filters on. An item can sit in several folders at once.
        "collections": collections,
        "attachments": attachments,
    })
}

/// The first run of four ASCII digits (`/\d{4}/`).
pub(super) fn first_year(date: &str) -> String {
    let b = date.as_bytes();
    b.windows(4)
        .find(|w| w.iter().all(u8::is_ascii_digit))
        .map(|w| String::from_utf8_lossy(w).into_owned())
        .unwrap_or_default()
}

/// `/(?:^|\n)\s*Citation Key\s*:\s*(\S+)/i` over `extra`.
pub(super) fn citation_key_from_extra(extra: &str) -> Option<String> {
    let starts = std::iter::once(0).chain(extra.match_indices('\n').map(|(i, _)| i + 1));
    for s in starts {
        let rest = extra[s..].trim_start();
        let Some(label) = rest.get(..12) else {
            continue;
        };
        if !label.eq_ignore_ascii_case("citation key") {
            continue;
        }
        let Some(value) = rest[12..].trim_start().strip_prefix(':') else {
            continue;
        };
        let token: String = value
            .trim_start()
            .chars()
            .take_while(|c| !c.is_whitespace())
            .collect();
        if !token.is_empty() {
            return Some(token);
        }
    }
    None
}

/// `zotero_collections.json`: `[{ key, name, parentKey }]`, a top-level
/// collection's `parentKey` null.
pub fn derive_collections(raw: &[Value]) -> Vec<Value> {
    raw.iter()
        .filter(|c| key_of(c).is_some() && !is_trashed(c))
        .map(|c| {
            let parent = data_str(c, "parentCollection");
            json!({
                "key": key_of(c).unwrap_or(""),
                "name": or(data_str(c, "name"), "Untitled"),
                "parentKey": if parent.is_empty() { Value::Null } else { Value::String(parent.to_string()) },
            })
        })
        .collect()
}

/// `zotero_highlights.json`: `{ attachmentKey: [raw annotation items] }`,
/// and how many there are.
pub fn derive_highlights(items: &[Value]) -> (Value, usize) {
    let mut by_att: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut count = 0usize;
    for item in items {
        if is_trashed(item) || item_type(item) != "annotation" {
            continue;
        }
        let Some(parent) = parent_of(item) else {
            continue;
        };
        by_att
            .entry(parent.to_string())
            .or_default()
            .push(item.clone());
        count += 1;
    }
    let map: Map<String, Value> = by_att
        .into_iter()
        .map(|(k, v)| (k, Value::Array(v)))
        .collect();
    (Value::Object(map), count)
}
