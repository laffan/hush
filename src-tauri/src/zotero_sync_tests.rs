//! Unit tests for the Zotero sync engine: the files it derives and how
//! it folds changes in. Whole syncs are in `zotero_sync_mock_tests.rs`.

use super::*;
use std::collections::HashSet;
use std::io::Write;

pub(super) fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

fn keys(items: &[Value]) -> HashSet<String> {
    items
        .iter()
        .filter_map(key_of)
        .map(str::to_string)
        .collect()
}

pub(super) fn item(key: &str, version: u64, data: Value) -> Value {
    json!({ "key": key, "version": version, "data": data })
}

pub(super) fn article(key: &str, title: &str) -> Value {
    item(
        key,
        1,
        json!({
            "itemType": "journalArticle",
            "title": title,
            "creators": [{ "creatorType": "author", "firstName": "Andrew", "lastName": "Hoskins" }],
            "date": "March 2011",
            "dateAdded": "2020-01-01T00:00:00Z",
            "dateModified": "2020-01-01T00:00:00Z",
            "collections": ["COLL1"],
        }),
    )
}

pub(super) fn pdf(key: &str, parent: &str) -> Value {
    item(
        key,
        1,
        json!({
            "itemType": "attachment",
            "parentItem": parent,
            "title": "Full Text PDF",
            "filename": "paper.pdf",
            "contentType": "application/pdf",
            "dateAdded": "2020-01-02T00:00:00Z",
        }),
    )
}

pub(super) fn annotation(key: &str, parent: &str) -> Value {
    item(
        key,
        1,
        json!({
            "itemType": "annotation",
            "parentItem": parent,
            "annotationType": "highlight",
            "annotationText": "text",
        }),
    )
}

// ---------------------------------------------------------------- derived files

#[test]
fn reference_matches_the_browser_build() {
    let refs = derive_references(&[article("A", "Media Memory"), pdf("P", "A")]);
    assert_eq!(refs.len(), 1);
    let r = &refs[0];
    assert_eq!(r["key"], "A");
    assert_eq!(r["title"], "Media Memory");
    assert_eq!(r["authors"], "Hoskins, A");
    assert_eq!(r["firstAuthor"], "Hoskins");
    assert_eq!(r["year"], "2011");
    assert_eq!(r["citekey"], "hoskins2011");
    assert_eq!(r["itemType"], "journalArticle");
    assert_eq!(r["collections"], json!(["COLL1"]));
    assert_eq!(r["shortTitle"], "");
    assert_eq!(
        r["attachments"],
        json!([{
            "key": "P", "title": "Full Text PDF", "filename": "paper.pdf",
            "contentType": "application/pdf", "isPdf": true,
        }])
    );
}

#[test]
fn author_without_first_name_keeps_the_comma_like_js() {
    let it = item(
        "A",
        1,
        json!({
            "itemType": "book",
            "creators": [{ "lastName": "Plato" }, { "name": "WHO" }, { "lastName": "" }],
        }),
    );
    let r = &derive_references(&[it])[0];
    assert_eq!(r["authors"], "Plato,; WHO");
    assert_eq!(r["title"], "Untitled");
    assert_eq!(r["year"], "");
    assert_eq!(r["citekey"], "plato");
}

#[test]
fn citekey_from_citation_key_then_extra_then_slug() {
    let with_field = item(
        "A",
        1,
        json!({ "itemType": "book", "citationKey": "smith2020x", "extra": "Citation Key: other" }),
    );
    let with_extra = item(
        "B",
        1,
        json!({ "itemType": "book", "extra": "tex.foo: 1\n  citation key :  doe1999a  \nmore" }),
    );
    let none = item(
        "C",
        1,
        json!({ "itemType": "book", "creators": [{ "name": "Ünïcode Org" }], "date": "1999" }),
    );
    let refs = derive_references(&[with_field, with_extra, none]);
    let by_key: HashMap<&str, &Value> = refs
        .iter()
        .map(|r| (r["key"].as_str().unwrap(), r))
        .collect();
    assert_eq!(by_key["A"]["citekey"], "smith2020x");
    assert_eq!(by_key["B"]["citekey"], "doe1999a");
    assert_eq!(by_key["C"]["citekey"], "ncodeorg1999");
}

#[test]
fn citation_key_parser() {
    assert_eq!(
        citation_key_from_extra("Citation Key: abc"),
        Some("abc".into())
    );
    assert_eq!(
        citation_key_from_extra("x\nCITATION KEY:abc def"),
        Some("abc".into())
    );
    assert_eq!(citation_key_from_extra("Citation Keys: abc"), None);
    assert_eq!(citation_key_from_extra("Note Citation Key: abc"), None);
    assert_eq!(citation_key_from_extra("é"), None);
    assert_eq!(first_year("c. 1987–1990"), "1987");
    assert_eq!(first_year("12-3"), "");
}

#[test]
fn notes_standalone_attachments_children_and_trash_stay_out_of_references() {
    let mut trashed = article("T", "Trashed");
    trashed["data"]["deleted"] = json!(1);
    let mut trashed_pdf = pdf("TP", "A");
    trashed_pdf["data"]["deleted"] = json!(true);
    let items = vec![
        article("A", "Kept"),
        trashed,
        pdf("P", "T"), // child of a trashed item: goes with it
        trashed_pdf,
        item("N", 1, json!({ "itemType": "note", "note": "<p>x</p>" })),
        item(
            "S",
            1,
            json!({ "itemType": "attachment", "title": "Standalone.pdf" }),
        ),
        annotation("H", "P"),
    ];
    let refs = derive_references(&items);
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0]["key"], "A");
    assert_eq!(refs[0]["attachments"], json!([]));
}

#[test]
fn references_newest_edit_first_and_attachments_oldest_first() {
    let mut a = article("A", "Old");
    a["data"]["dateModified"] = json!("2019-01-01T00:00:00Z");
    let mut b = article("B", "New");
    b["data"]["dateModified"] = json!("2024-01-01T00:00:00Z");
    let mut p2 = pdf("P2", "A");
    p2["data"]["dateAdded"] = json!("2021-01-01T00:00:00Z");
    let mut p1 = pdf("P1", "A");
    p1["data"]["dateAdded"] = json!("2020-01-01T00:00:00Z");
    let mut txt = pdf("NOTES", "A");
    txt["data"]["contentType"] = json!("text/markdown");
    txt["data"]["filename"] = json!("NOTES.md");
    txt["data"]["dateAdded"] = json!("2022-01-01T00:00:00Z");
    let refs = derive_references(&[a, b, p2, txt, p1]);
    assert_eq!(refs[0]["key"], "B");
    let atts: Vec<&str> = refs[1]["attachments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["key"].as_str().unwrap())
        .collect();
    assert_eq!(atts, ["P1", "P2", "NOTES"]);
    assert_eq!(refs[1]["attachments"][2]["isPdf"], false);
}

#[test]
fn pdf_detected_from_filename_or_title() {
    let by_name = item(
        "X",
        1,
        json!({ "itemType": "attachment", "parentItem": "A", "filename": "X.PDF" }),
    );
    let by_title = item(
        "Y",
        1,
        json!({ "itemType": "attachment", "parentItem": "A", "title": "y.pdf" }),
    );
    assert_eq!(to_attachment(&by_name)["isPdf"], true);
    assert_eq!(to_attachment(&by_title)["isPdf"], true);
    assert_eq!(to_attachment(&by_name)["title"], "Attachment");
}

#[test]
fn collections_shape() {
    let raw = vec![
        json!({ "key": "C1", "version": 1, "data": { "name": "Top", "parentCollection": false } }),
        json!({ "key": "C2", "version": 1, "data": { "name": "", "parentCollection": "C1" } }),
        json!({ "key": "C3", "version": 1, "data": { "name": "Gone", "deleted": true } }),
    ];
    assert_eq!(
        Value::Array(derive_collections(&raw)),
        json!([
            { "key": "C1", "name": "Top", "parentKey": null },
            { "key": "C2", "name": "Untitled", "parentKey": "C1" },
        ])
    );
}

#[test]
fn highlights_grouped_by_attachment() {
    let mut trashed = annotation("H3", "P1");
    trashed["data"]["deleted"] = json!(1);
    let (by_att, count) = derive_highlights(&[
        annotation("H1", "P1"),
        annotation("H2", "P2"),
        trashed,
        article("A", "x"),
    ]);
    assert_eq!(count, 2);
    assert_eq!(by_att["P1"].as_array().unwrap().len(), 1);
    assert_eq!(by_att["P1"][0]["key"], "H1");
    assert_eq!(by_att["P1"][0]["data"]["annotationText"], "text");
    assert_eq!(by_att["P2"][0]["key"], "H2");
}

// ---------------------------------------------------------------- folding changes in

#[test]
fn slim_keeps_key_version_data() {
    let raw = json!({ "key": "A", "version": 3, "library": {}, "links": {}, "meta": {}, "data": { "x": 1 } });
    assert_eq!(
        slim(raw),
        json!({ "key": "A", "version": 3, "data": { "x": 1 } })
    );
}

#[test]
fn keyed_remove_keeps_index_consistent() {
    let mut k = Keyed::from_vec(vec![
        article("A", "a"),
        article("B", "b"),
        article("C", "c"),
    ]);
    assert!(k.remove("A").is_some());
    assert!(k.remove("A").is_none());
    let mut c = article("C", "c2");
    c["version"] = json!(9);
    assert!(k.upsert(c).is_some());
    assert_eq!(k.items.len(), 2);
    assert_eq!(k.items[k.index["C"]]["data"]["title"], "c2");
    assert_eq!(k.items[k.index["B"]]["key"], "B");
}

#[test]
fn apply_changes_counts_like_the_user_sees_it() {
    let mut in_trash = article("T", "t");
    in_trash["data"]["deleted"] = json!(1);
    let existing = vec![
        article("A", "a"),
        article("B", "b"),
        article("D", "d"),
        in_trash.clone(),
    ];
    let mut b_trashed = article("B", "b");
    b_trashed["data"]["deleted"] = json!(1);
    let changed = vec![
        article("A", "a edited"), // updated
        b_trashed,                // moved to the trash: removed
        article("T", "restored"), // out of the trash: added
        article("N", "new"),      // added
    ];
    let (items, ch) = apply_changes(existing, changed, &["D".into(), "ZZ".into()]);
    assert_eq!(
        ch,
        Changes {
            added: 2,
            updated: 1,
            removed: 2
        }
    );
    assert_eq!(
        keys(&items),
        ["A", "T", "N"].iter().map(|s| s.to_string()).collect(),
        "the trashed item leaves the cache, as a deleted one does"
    );
    let refs = derive_references(&items);
    let titles: HashSet<&str> = refs.iter().map(|r| r["title"].as_str().unwrap()).collect();
    assert_eq!(
        titles,
        ["a edited", "restored", "new"].into_iter().collect()
    );
}

#[test]
fn a_cache_from_before_trash_was_dropped_is_cleaned_on_the_next_update() {
    let mut old = article("T", "t");
    old["data"]["deleted"] = json!(1);
    let (items, ch) = apply_changes(vec![article("A", "a"), old], vec![], &[]);
    assert_eq!(keys(&items), HashSet::from(["A".to_string()]));
    assert_eq!(
        ch,
        Changes::default(),
        "it was never shown, so nothing to count"
    );
}

#[test]
fn checkpoint_ignores_a_truncated_last_line() {
    let dir = tmp();
    let path = dir.path().join("ckpt.jsonl");
    start_checkpoint(&path, 42, "u1").unwrap();
    append_checkpoint_page(&path, 100, &[article("A", "a"), article("B", "b")]).unwrap();
    append_checkpoint_page(&path, 100, &[article("B", "b2")]).unwrap();
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    f.write_all(b"{\"n\": 100, \"items\": [{\"key\":").unwrap();
    let c = load_checkpoint(&path).unwrap();
    assert_eq!((c.version, c.user_id.as_str(), c.fetched), (42, "u1", 200));
    assert_eq!(c.items.len(), 2);
    assert_eq!(
        c.items.iter().find(|i| i["key"] == "B").unwrap()["data"]["title"],
        "b2"
    );
}

#[test]
fn only_one_sync_of_a_kind_at_a_time() {
    let first = Running::start(Kind::Highlights).unwrap();
    assert!(Running::start(Kind::Highlights).is_err());
    assert!(cancel(Kind::Highlights));
    assert!(first.flag().load(Ordering::SeqCst));
    drop(first);
    assert!(!cancel(Kind::Highlights));
    assert!(Running::start(Kind::Highlights).is_ok());
}
