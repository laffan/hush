//! **Unindexed is not new, yet.** The other half of "absent is not
//! deleted" (`desk_scan`), for the file that *arrives* rather than the
//! one that goes.
//!
//! Typing a title is a rename and an edit at once: the naming rule moves
//! `Untitled.md` to `Chapter one.md` while the autosave rewrites its
//! bytes. The far device receives that as one file vanishing and another
//! appearing — and, when the file lands before the `index.json` /
//! `tree.json` that name it (the provider delivers them in whatever order
//! it likes, and coming back online delivers everything at once), it has
//! nothing to pair them by: the hash cache knows the old bytes, not the
//! new ones, and the name changed. So it minted a fresh id for the file,
//! published that, and the renaming device then saw one document as two
//! rows — the naming rule suffixed its own row ` (2)` to get out of the
//! other's way, the id it was saving through no longer named a file, and
//! the next save asked whether to overwrite. Nothing had been edited
//! anywhere else.
//!
//! So an arrival that *could* be a vanished file under a new name waits:
//! while an index entry of the same kind in the same folder is missing
//! and unpaired, the new file is held — no row, no id — for up to
//! `HOLD_SECS`. The sidecars normally land well inside that, and the
//! tree's claim or the index then names the file under the id it already
//! had. If the window runs out, the file is minted as before. It is not
//! paired with the candidate on a guess: if the guess were wrong, the
//! device still writing under that id would write its document over
//! this one.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// How long an ambiguous arrival waits for its sidecars.
pub(crate) const HOLD_SECS: u64 = 120;
/// Past this, a held stamp is left over from an arrival long since
/// settled, and the clock starts again.
const STALE_SECS: u64 = 4 * HOLD_SECS;

/// (desk root, desk-relative path) → epoch secs the arrival was first
/// held. In memory, like the missing ledger: a restart restarts the clock.
static HELD_SINCE: OnceLock<Mutex<HashMap<(String, String), u64>>> = OnceLock::new();

fn ledger() -> &'static Mutex<HashMap<(String, String), u64>> {
    HELD_SINCE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What to do with an unindexed, unpaired arrival.
pub(crate) enum Arrival {
    /// Nothing it could be a rename of — a new file.
    New,
    /// It may be a vanished file under a new name; leave it for now.
    Held,
}

/// Whether a vanished, still-unpaired index entry of `node_type` sits in
/// the same directory as `rel`.
fn has_candidate(rel: &str, node_type: &str, missing: &[(String, String)], paired: &HashSet<String>) -> bool {
    let dir = Path::new(rel).parent();
    missing.iter().any(|(id, old_rel)| {
        !paired.contains(id)
            && Path::new(old_rel).parent() == dir
            && crate::desk_scan::kind_for_rel(old_rel).as_deref() == Some(node_type)
    })
}

/// Decide an arrival. `now` is epoch secs.
pub(crate) fn decide(
    root: &Path,
    rel: &str,
    node_type: &str,
    missing: &[(String, String)],
    paired: &HashSet<String>,
    now: u64,
) -> Arrival {
    // Images are addressed by filename: a renamed image is a new image.
    if node_type == "image" {
        return Arrival::New;
    }
    let key = (root.to_string_lossy().into_owned(), rel.to_string());
    let mut held = ledger().lock().unwrap();
    if !has_candidate(rel, node_type, missing, paired) {
        held.remove(&key);
        return Arrival::New;
    }
    let first = held.entry(key.clone()).or_insert(now);
    // A stamp long past the window belongs to an earlier arrival at this
    // path that resolved some other way (the index or the tree named it).
    if now.saturating_sub(*first) > STALE_SECS {
        *first = now;
    }
    if now.saturating_sub(*first) < HOLD_SECS {
        return Arrival::Held;
    }
    held.remove(&key);
    Arrival::New
}

/// Backdate a held arrival so tests can cross the window without sleeping.
#[cfg(test)]
pub(crate) fn backdate_for_tests(root: &Path, rel: &str, secs: u64) {
    let key = (root.to_string_lossy().into_owned(), rel.to_string());
    if let Some(t) = ledger().lock().unwrap().get_mut(&key) {
        *t = t.saturating_sub(secs);
    }
}

#[cfg(test)]
#[path = "desk_hold_tests.rs"]
mod tests;
