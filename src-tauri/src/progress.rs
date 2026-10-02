//! Writing progress — words added per day, per file and section, read
//! back out of version history.
//!
//! There is no progress log. Every document already keeps snapshots of
//! itself (`snapshots.rs`), thinned to one a day after a week, which is
//! exactly the resolution a calendar needs: how a document stood at each
//! local midnight is its newest snapshot before it, and a day's writing
//! is what `progress_diff` finds added between one midnight and the next.
//!
//! **A document has more than one history.** Edited on its own it
//! snapshots under its fileId; edited inside its project's joined buffer
//! the *project* snapshots, under `project:<id>`, with every document in
//! one text. Tallying each series alone would count a day's project
//! writing a second time the next time the document is opened alone (its
//! own series' baseline would be weeks old), so the two are merged into
//! one timeline per document first: a project snapshot is split at its
//! separators and each part is given to the document it belongs to. The
//! split snapshot doesn't say which part is which, so a part is matched
//! to a document by its first line, which is what a document is named
//! after (`state-naming.js`); parts that match nothing fall back to the
//! project's current order when the counts agree, and are otherwise left
//! out rather than credited to the wrong file.
//!
//! The document's current file is one more point on its timeline (at its
//! modification time), so the writing since the last snapshot counts.
//!
//! A document first seen part-way through a day it wasn't created on —
//! its history began after it did — is measured from that first sight,
//! not from nothing, or every old document would arrive as one day's
//! worth of new words.

use crate::desk_store::DeskStore;
use crate::progress_diff::added_by_section;
use crate::snapshots::SnapshotManager;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// The separator `project-view.js` joins a project's documents with.
const SEPARATOR: &str = "\n---hush-separator---\n";

/// How far back to look for a snapshot that holds a document before
/// settling on what is already known (each try may read a file).
const MAX_TRIES: usize = 40;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressFile {
    pub id: String,
    pub name: String,
    /// When the document was created (ms), when known.
    #[serde(default)]
    pub created_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressProject {
    /// The project node's id (its buffer snapshots as `project:<id>`).
    pub id: String,
    /// Its documents, in their current order.
    pub doc_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressRequest {
    pub files: Vec<ProgressFile>,
    #[serde(default)]
    pub projects: Vec<ProgressProject>,
    /// Local midnights, ascending: day `k` runs from `day_starts[k]` to
    /// `day_starts[k + 1]`, so N days take N + 1 entries.
    pub day_starts: Vec<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SectionProgress {
    pub title: String,
    pub added: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileProgress {
    pub id: String,
    pub added: u64,
    pub sections: Vec<SectionProgress>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayProgress {
    pub day_start: i64,
    pub total: u64,
    /// Files with words added that day, most first.
    pub files: Vec<FileProgress>,
}

/// Where a point on a document's timeline gets its text.
#[derive(Clone)]
enum Source {
    /// One of the document's own snapshots.
    Snap(PathBuf),
    /// A snapshot of a project buffer: the part that is this document.
    Project(PathBuf, usize),
    /// The document's file as it is now.
    Current,
}

struct Reader<'a> {
    /// Where each requested file lives — looked up once for the whole
    /// request, since `locate` re-reads a desk's index per call.
    paths: HashMap<String, PathBuf>,
    req: &'a ProgressRequest,
    names: HashMap<&'a str, &'a str>,
    snaps: HashMap<PathBuf, Option<String>>,
    parts: HashMap<PathBuf, HashMap<String, String>>,
    current: HashMap<String, Option<String>>,
}

impl<'a> Reader<'a> {
    fn text(&mut self, file_id: &str, src: &Source) -> Option<String> {
        match src {
            Source::Snap(p) => self
                .snaps
                .entry(p.clone())
                .or_insert_with(|| fs::read_to_string(p).ok())
                .clone(),
            Source::Current => {
                if !self.current.contains_key(file_id) {
                    let text = self.paths.get(file_id).and_then(|p| fs::read_to_string(p).ok());
                    self.current.insert(file_id.to_string(), text);
                }
                self.current[file_id].clone()
            }
            Source::Project(p, pi) => {
                if !self.parts.contains_key(p) {
                    let map = fs::read_to_string(p)
                        .map(|t| split_project(&t, &self.req.projects[*pi], &self.names))
                        .unwrap_or_default();
                    self.parts.insert(p.clone(), map);
                }
                self.parts[p].get(file_id).cloned()
            }
        }
    }

    /// The newest text among `points` (ascending by time) from before
    /// `before`, skipping points that turn out not to hold the document.
    fn state_before(&mut self, file_id: &str, points: &[(i64, Source)], before: i64) -> Option<String> {
        let end = points.partition_point(|(ms, _)| *ms < before);
        for (_, src) in points[..end].iter().rev().take(MAX_TRIES) {
            if let Some(t) = self.text(file_id, src) {
                return Some(t);
            }
        }
        None
    }

    /// The oldest text among `points` within `[from, to)`.
    fn first_within(&mut self, file_id: &str, points: &[(i64, Source)], from: i64, to: i64) -> Option<String> {
        let start = points.partition_point(|(ms, _)| *ms < from);
        for (ms, src) in points[start..].iter().take(MAX_TRIES) {
            if *ms >= to {
                break;
            }
            if let Some(t) = self.text(file_id, src) {
                return Some(t);
            }
        }
        None
    }
}

pub fn writing_progress(store: &DeskStore, snaps: &SnapshotManager, req: &ProgressRequest) -> Vec<DayProgress> {
    let days = req.day_starts.len().saturating_sub(1);
    let mut out: Vec<DayProgress> = (0..days)
        .map(|k| DayProgress { day_start: req.day_starts[k], total: 0, files: Vec::new() })
        .collect();
    if days == 0 {
        return out;
    }
    let window_start = req.day_starts[0];

    let wanted: std::collections::HashSet<&str> = req.files.iter().map(|f| f.id.as_str()).collect();
    let (indexed, _staged) = store.list_ids();
    let paths: HashMap<String, PathBuf> = indexed
        .into_iter()
        .filter(|(id, _, _)| wanted.contains(id.as_str()))
        .map(|(id, desk, rel)| {
            let p = store.abs_path(&desk, &rel);
            (id, p)
        })
        .collect();

    // Every document's timeline: its own snapshots, the project buffer
    // snapshots it may be part of, and its file now.
    let mut timelines: HashMap<&str, Vec<(i64, Source)>> = HashMap::new();
    for f in &req.files {
        let mut points: Vec<(i64, Source)> = snaps
            .snapshot_files(&f.id)
            .into_iter()
            .map(|(p, ms)| (ms, Source::Snap(p)))
            .collect();
        let modified = paths
            .get(&f.id)
            .and_then(|p| fs::metadata(p).and_then(|m| m.modified()).ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok());
        if let Some(d) = modified {
            points.push((d.as_millis() as i64, Source::Current));
        }
        timelines.insert(f.id.as_str(), points);
    }
    for (pi, project) in req.projects.iter().enumerate() {
        let files = snaps.snapshot_files(&format!("project:{}", project.id));
        for doc in &project.doc_ids {
            if let Some(points) = timelines.get_mut(doc.as_str()) {
                points.extend(files.iter().map(|(p, ms)| (*ms, Source::Project(p.clone(), pi))));
            }
        }
    }

    let mut reader = Reader {
        paths,
        req,
        names: req.files.iter().map(|f| (f.id.as_str(), f.name.as_str())).collect(),
        snaps: HashMap::new(),
        parts: HashMap::new(),
        current: HashMap::new(),
    };

    for f in &req.files {
        let Some(points) = timelines.get_mut(f.id.as_str()) else { continue };
        points.sort_by_key(|(ms, _)| *ms);
        // Nothing happened to it inside the window: nothing to tally.
        if points.last().map_or(true, |(ms, _)| *ms < window_start) {
            continue;
        }
        let points = points.clone();
        let mut prev = reader.state_before(&f.id, &points, req.day_starts[0]);
        for k in 0..days {
            let (from, to) = (req.day_starts[k], req.day_starts[k + 1]);
            let end = reader.state_before(&f.id, &points, to);
            let Some(end_text) = end.clone() else { continue };
            let base = match prev.take() {
                Some(t) => t,
                // First seen today: created today means from nothing;
                // otherwise from the first sight of it today.
                None if f.created_ms.map_or(false, |c| c >= from) => String::new(),
                None => reader.first_within(&f.id, &points, from, to).unwrap_or_else(|| end_text.clone()),
            };
            if base != end_text {
                let sections: Vec<SectionProgress> = added_by_section(&base, &end_text)
                    .into_iter()
                    .map(|(title, added)| SectionProgress { title, added })
                    .collect();
                let added: u64 = sections.iter().map(|s| s.added).sum();
                if added > 0 {
                    out[k].total += added;
                    out[k].files.push(FileProgress { id: f.id.clone(), added, sections });
                }
            }
            prev = end;
        }
    }
    for day in &mut out {
        day.files.sort_by(|a, b| b.added.cmp(&a.added));
    }
    out
}

/// A project buffer snapshot's parts, by the document each belongs to.
fn split_project(text: &str, project: &ProgressProject, names: &HashMap<&str, &str>) -> HashMap<String, String> {
    let text = text.replace("\r\n", "\n");
    let parts: Vec<&str> = text.split(SEPARATOR).collect();
    let mut owner: Vec<Option<&str>> = vec![None; parts.len()];
    let mut taken: Vec<&str> = Vec::new();

    let keys: Vec<(&str, String)> = project
        .doc_ids
        .iter()
        .filter_map(|id| names.get(id.as_str()).map(|n| (id.as_str(), name_key(n))))
        .filter(|(_, k)| !k.is_empty())
        .collect();
    // Exact first-line matches, then a first line the name is the start
    // of (names are cut short), each document taken once.
    for exact in [true, false] {
        for (i, part) in parts.iter().enumerate() {
            if owner[i].is_some() {
                continue;
            }
            let title = name_key(first_line(part));
            if title.is_empty() {
                continue;
            }
            let hits: Vec<&str> = keys
                .iter()
                .filter(|(id, k)| !taken.contains(id) && if exact { *k == title } else { title.starts_with(k.as_str()) })
                .map(|(id, _)| *id)
                .collect();
            if hits.len() == 1 {
                owner[i] = Some(hits[0]);
                taken.push(hits[0]);
            }
        }
    }
    // The rest by position, when the buffer and the project agree on how
    // many documents there are.
    if parts.len() == project.doc_ids.len() {
        for (i, id) in project.doc_ids.iter().enumerate() {
            if owner[i].is_none() && !taken.contains(&id.as_str()) {
                owner[i] = Some(id.as_str());
            }
        }
    }
    parts
        .iter()
        .zip(owner)
        .filter_map(|(part, id)| id.map(|id| (id.to_string(), part.to_string())))
        .collect()
}

/// A document's first line after any frontmatter — what it is named for.
fn first_line(text: &str) -> &str {
    let mut lines = text.lines().peekable();
    if lines.peek().map(|l| l.trim_end() == "---").unwrap_or(false) {
        lines.next();
        for l in lines.by_ref() {
            let t = l.trim_end();
            if t == "---" || t == "..." {
                break;
            }
        }
    }
    lines.find(|l| !l.trim().is_empty()).unwrap_or("")
}

/// Lowercased letters and digits only — names are sanitised for the
/// file system and first lines carry markdown, so compare what survives.
fn name_key(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(|c| c.to_lowercase()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(ids: &[&str]) -> ProgressProject {
        ProgressProject { id: "p".into(), doc_ids: ids.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn parts_go_to_the_documents_named_by_their_first_lines() {
        let names: HashMap<&str, &str> = [("a", "Chapter One"), ("b", "Chapter Two")].into_iter().collect();
        let text = format!("# Chapter Two\n\nsecond{}# Chapter One\n\nfirst", SEPARATOR);
        let map = split_project(&text, &project(&["a", "b"]), &names);
        assert!(map["a"].contains("first"));
        assert!(map["b"].contains("second"));
    }

    #[test]
    fn unmatched_parts_fall_back_to_position_only_when_counts_agree() {
        let names: HashMap<&str, &str> = [("a", "Alpha"), ("b", "Beta")].into_iter().collect();
        let two = format!("Renamed\n\nx{}Beta\n\ny", SEPARATOR);
        let map = split_project(&two, &project(&["a", "b"]), &names);
        assert!(map["a"].starts_with("Renamed"));
        let three = format!("Renamed\n{}Beta\n{}Other\n", SEPARATOR, SEPARATOR);
        let map = split_project(&three, &project(&["a", "b"]), &names);
        assert!(!map.contains_key("a"));
        assert!(map.contains_key("b"));
    }

    /// A document's own snapshots and its project's buffer snapshots make
    /// one timeline: a day written in the project and the next day
    /// written alone each count once.
    #[test]
    fn own_and_project_snapshots_merge_into_one_timeline() {
        let dir = std::env::temp_dir().join(format!("hush-progress-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let unplaced = dir.join("desks").join(".versions-unplaced");
        let day = 86_400_000i64;
        let t0 = 1_700_000_000_000i64;
        let snap = |id: &str, ms: i64, text: &str| {
            let d = unplaced.join(id);
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join(format!("{}-dev.snap", ms)), text).unwrap();
        };
        snap("f1", t0 - 3_600_000, "Alpha");
        snap("f1", t0 + 3_600_000, "Alpha beta");
        snap("f1", t0 + day + 3_600_000, "Alpha beta gamma delta");
        snap("project_p", t0 + 2 * day + 3_600_000, "Alpha beta gamma delta epsilon");
        snap("f1", t0 + 3 * day + 3_600_000, "Alpha beta gamma delta epsilon zeta");

        let store = DeskStore::new(&dir);
        let snaps = SnapshotManager::new(&dir);
        let req = ProgressRequest {
            files: vec![ProgressFile { id: "f1".into(), name: "Alpha".into(), created_ms: None }],
            projects: vec![ProgressProject { id: "p".into(), doc_ids: vec!["f1".into()] }],
            day_starts: (0..5).map(|k| t0 + k * day).collect(),
        };
        let days = writing_progress(&store, &snaps, &req);
        let totals: Vec<u64> = days.iter().map(|d| d.total).collect();
        assert_eq!(totals, vec![1, 2, 1, 1]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn first_line_skips_frontmatter() {
        assert_eq!(first_line("---\noutline: true\n---\n\n# Title\nbody"), "# Title");
    }
}
