//! Renaming and moving a **local desk's folder** — the two operations a
//! desk that lives on the user's disk was missing.
//!
//! A local desk is named by its folder (`desk_roots`), which left the
//! name with no way back once the folder was created: a typo in the
//! folder name, or a folder saved to the wrong place, could only be
//! fixed by deleting the desk from Hush, fixing the folder by hand, and
//! re-adopting it. Both operations here fix that from inside the app.
//!
//! **Nothing is reported as done until the files are accounted for.**
//! These folders belong to sync providers, which is why that matters: a
//! cross-volume move is a copy-then-delete, a provider can be mid-upload
//! when the move starts, and an evicted iCloud file is a
//! `.<name>.icloud` placeholder rather than the bytes. So every
//! relocation takes a census of the source first, runs, takes a second
//! census of the destination, and **rolls back** when anything in the
//! first census has no counterpart in the second. A placeholder counts
//! as the file it stands for — asking a provider to materialise a whole
//! desk before it can be moved would be worse than useless — so a
//! placeholder pairs with a placeholder *or* with real bytes, and only a
//! name that vanished, or a real file whose length changed, is a
//! shortfall.
//!
//! **Rename is desktop-only**, and the frontend gates it there. Renaming
//! a folder writes to its *parent* directory, which iOS's
//! security-scoped access to the folder itself does not grant; Move is
//! the iOS answer, because the picker hands back a scope for the folder
//! it returns.

use crate::desk_roots::{load_entries, save_entries, RootEntry};
use crate::desk_store::DeskStore;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

type BoxError = Box<dyn std::error::Error>;

/// A folder's contents by path relative to its root. `None` is an iCloud
/// placeholder: the folder holds that file, but the length on disk is
/// the placeholder's and says nothing about the real one.
type Census = BTreeMap<String, Option<u64>>;

/// `.Name.ext.icloud` → `Name.ext`, or `None` for an ordinary name.
fn placeholder_name(name: &str) -> Option<String> {
    let stripped = name.strip_suffix(".icloud")?;
    let inner = stripped.strip_prefix('.')?;
    if inner.is_empty() {
        return None;
    }
    Some(inner.to_string())
}

/// Every file under `dir`, keyed by its relative path. `.DS_Store` is
/// ignored (the same junk `dir_is_effectively_empty` ignores). A folder
/// we cannot read is an error, never an empty census — treating an
/// unreadable source as "no files" would let a move that lost everything
/// verify clean.
fn census(dir: &Path) -> Result<Census, BoxError> {
    let mut out = Census::new();
    walk(dir, "", &mut out)?;
    Ok(out)
}

fn walk(dir: &Path, prefix: &str, out: &mut Census) -> Result<(), BoxError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let raw = entry.file_name().to_string_lossy().into_owned();
        if raw == ".DS_Store" {
            continue;
        }
        let meta = entry.metadata()?;
        if meta.is_dir() {
            let next = if prefix.is_empty() { raw } else { format!("{}/{}", prefix, raw) };
            walk(&entry.path(), &next, out)?;
            continue;
        }
        let (name, len) = match placeholder_name(&raw) {
            Some(real) => (real, None),
            None => (raw, Some(meta.len())),
        };
        let key = if prefix.is_empty() { name } else { format!("{}/{}", prefix, name) };
        // A folder holding both `X` and `.X.icloud` is mid-delivery;
        // the real bytes are the better answer of the two.
        let already_real = matches!(out.get(&key), Some(Some(_)));
        if !already_real {
            out.insert(key, len);
        }
    }
    Ok(())
}

/// What `before` has that `after` doesn't: a missing path, or a file
/// whose length changed while both sides held real bytes. Empty means
/// every file is accounted for.
fn shortfall(before: &Census, after: &Census) -> Vec<String> {
    let mut missing = Vec::new();
    for (path, len) in before {
        match after.get(path) {
            None => missing.push(path.clone()),
            Some(after_len) => {
                if let (Some(a), Some(b)) = (len, after_len) {
                    if a != b {
                        missing.push(format!("{} (length changed)", path));
                    }
                }
            }
        }
    }
    missing
}

/// Render a shortfall for a user-facing error, capped so a catastrophic
/// move doesn't produce a dialog the length of the desk.
fn shortfall_message(missing: &[String]) -> String {
    let shown: Vec<&str> = missing.iter().take(5).map(String::as_str).collect();
    let more = missing.len().saturating_sub(shown.len());
    let tail = if more > 0 { format!(", and {} more", more) } else { String::new() };
    format!(
        "{} file(s) didn't arrive: {}{}",
        missing.len(),
        shown.join(", "),
        tail
    )
}

/// A folder name that can be written to disk as one path segment.
fn clean_folder_name(raw: &str) -> Result<String, BoxError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("a folder needs a name".into());
    }
    if name == "." || name == ".." {
        return Err("that isn't a folder name".into());
    }
    if name.starts_with('.') {
        return Err("a name starting with a dot would hide the folder".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("a folder name can't contain a path separator".into());
    }
    Ok(name.to_string())
}

/// Same place? Darwin exposes one directory as both `/private/var/…` and
/// `/var/…`, and a trailing slash is noise.
fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| -> String {
        let raw = p.to_string_lossy();
        let trimmed = raw.trim_end_matches('/');
        match trimmed.strip_prefix("/private/") {
            Some(rest) => format!("/{}", rest),
            None => trimmed.to_string(),
        }
    };
    norm(a) == norm(b)
}

impl DeskStore {
    /// Rename a local desk's folder in place — same parent directory,
    /// new last path segment. Returns the new path.
    ///
    /// Same-parent means same volume, so this is one `fs::rename` and
    /// the census can only disagree if something else moved the folder
    /// underneath us. It is still taken: the whole point of the check is
    /// the case nobody predicted.
    pub fn rename_desk_root(&self, desk_id: &str, new_name: &str) -> Result<PathBuf, BoxError> {
        let mut roots = load_entries(&self.desks_dir);
        let Some(entry) = roots.get(desk_id).cloned() else {
            return Err("this desk doesn't live in a folder on disk".into());
        };
        let old = PathBuf::from(entry.path());
        if !old.is_dir() {
            return Err(format!("the desk's folder isn't there: {}", old.display()).into());
        }
        let name = clean_folder_name(new_name)?;
        let parent = old
            .parent()
            .ok_or("the desk's folder has no parent directory to rename it in")?;
        let target = parent.join(&name);
        if same_path(&old, &target) {
            return Ok(old);
        }
        if target.exists() {
            return Err(format!("there is already something called \"{}\" there", name).into());
        }

        let before = census(&old)?;
        fs::rename(&old, &target).map_err(|e| -> BoxError {
            format!("couldn't rename the folder: {}", e).into()
        })?;
        let missing = shortfall(&before, &census(&target)?);
        if !missing.is_empty() {
            // Put it back before anyone is told this worked.
            let _ = fs::rename(&target, &old);
            return Err(shortfall_message(&missing).into());
        }

        // The bookmark (iOS only, and iOS can't reach here) tracks the
        // folder itself rather than its path, so it carries over.
        roots.insert(
            desk_id.to_string(),
            RootEntry::new(
                target.to_string_lossy().into_owned(),
                entry.bookmark().map(str::to_string),
            ),
        );
        save_entries(&self.desks_dir, &roots)?;
        Ok(target)
    }

    /// Move a local desk's folder contents into `target` and repoint the
    /// root there. `target` must be absolute, outside app data, empty
    /// (or missing), and not inside the desk's current folder. Returns
    /// the new path.
    pub fn move_desk_root(
        &self,
        desk_id: &str,
        target: &Path,
        bookmark: Option<String>,
    ) -> Result<PathBuf, BoxError> {
        let mut roots = load_entries(&self.desks_dir);
        let Some(entry) = roots.get(desk_id).cloned() else {
            return Err("this desk doesn't live in a folder on disk".into());
        };
        let old = PathBuf::from(entry.path());
        if !old.is_dir() {
            return Err(format!("the desk's folder isn't there: {}", old.display()).into());
        }
        if !target.is_absolute() {
            return Err("the destination must be an absolute path".into());
        }
        let data_dir = self.desks_dir.parent().unwrap_or(&self.desks_dir);
        if target.starts_with(data_dir) {
            return Err("the destination must live outside Hush's app data".into());
        }
        if same_path(&old, target) {
            return Ok(old);
        }
        // Moving a folder into itself would walk the contents into their
        // own subdirectory, one entry at a time, and never finish being
        // the same desk.
        if target.starts_with(&old) {
            return Err("the destination is inside the folder being moved".into());
        }
        if target.exists() {
            if !target.is_dir() {
                return Err("the destination exists and isn't a folder".into());
            }
            if !dir_is_empty_enough(target)? {
                return Err("the destination folder isn't empty".into());
            }
        } else {
            fs::create_dir_all(target)?;
        }

        let before = census(&old)?;
        if let Err(e) = crate::desk_roots::move_dir_contents(&old, target) {
            // Whatever made it across goes home before we report.
            let _ = crate::desk_roots::move_dir_contents(target, &old);
            return Err(format!("couldn't move the desk's files: {}", e).into());
        }
        let missing = shortfall(&before, &census(target)?);
        if !missing.is_empty() {
            let _ = crate::desk_roots::move_dir_contents(target, &old);
            return Err(shortfall_message(&missing).into());
        }

        // The old folder's own entry is the user's to keep — remove it
        // only when the move emptied it, and never when they had their
        // own files sitting beside the desk.
        if dir_is_empty_enough(&old).unwrap_or(false) {
            let _ = fs::remove_dir_all(&old);
        }
        roots.insert(
            desk_id.to_string(),
            RootEntry::new(target.to_string_lossy().into_owned(), bookmark),
        );
        save_entries(&self.desks_dir, &roots)?;
        Ok(target.to_path_buf())
    }
}

/// Empty, or nothing but `.DS_Store` junk. (A private twin of
/// `desk_roots::dir_is_effectively_empty`, which isn't public.)
fn dir_is_empty_enough(dir: &Path) -> Result<bool, BoxError> {
    for entry in fs::read_dir(dir)?.flatten() {
        if entry.file_name().to_string_lossy() != ".DS_Store" {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, rel: &str, body: &str) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("hush-relocate-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn census_pairs_a_placeholder_with_the_file_it_stands_for() {
        let root = tmp("census");
        write(&root, "Inbox/Notes.md", "hello");
        write(&root, ".hush/index.json", "{}");
        write(&root, "Inbox/.Big.hushnote.icloud", "");
        write(&root, ".DS_Store", "junk");
        let c = census(&root).unwrap();
        assert_eq!(c.get("Inbox/Notes.md"), Some(&Some(5)));
        assert_eq!(c.get(".hush/index.json"), Some(&Some(2)));
        // The placeholder is reported as the file it stands for, sizeless.
        assert_eq!(c.get("Inbox/Big.hushnote"), Some(&None));
        assert!(!c.contains_key(".DS_Store"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_placeholder_that_lands_as_real_bytes_is_not_a_shortfall() {
        let mut before = Census::new();
        before.insert("a.md".into(), None);
        before.insert("b.md".into(), Some(3));
        let mut after = Census::new();
        after.insert("a.md".into(), Some(120));
        after.insert("b.md".into(), Some(3));
        assert!(shortfall(&before, &after).is_empty());
    }

    #[test]
    fn a_missing_file_and_a_truncated_one_are_both_shortfalls() {
        let mut before = Census::new();
        before.insert("a.md".into(), Some(10));
        before.insert("b.md".into(), Some(3));
        let mut after = Census::new();
        after.insert("b.md".into(), Some(1));
        let missing = shortfall(&before, &after);
        assert_eq!(missing.len(), 2);
        assert!(missing.iter().any(|m| m == "a.md"));
        assert!(missing.iter().any(|m| m.starts_with("b.md (")));
    }

    #[test]
    fn folder_names_that_would_break_a_path_are_refused() {
        assert!(clean_folder_name("Drafts").is_ok());
        assert_eq!(clean_folder_name("  Drafts  ").unwrap(), "Drafts");
        assert!(clean_folder_name("").is_err());
        assert!(clean_folder_name("   ").is_err());
        assert!(clean_folder_name("..").is_err());
        assert!(clean_folder_name(".hidden").is_err());
        assert!(clean_folder_name("a/b").is_err());
    }
}
