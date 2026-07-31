// Cross-window registry — tracks every open Hush window and the file
// each one is currently displaying. Consumed by the sidebar so it can
// paint a numeral badge next to whichever file each window has open.
//
// Every window calls `register_window` on init and `set_window_file`
// whenever its active document / notebook changes. Liveness is belt-
// and-braces: `lib.rs` removes entries on `WindowEvent::Destroyed`,
// the command layer prunes against the runtime's live window list, and
// each window heartbeats every few seconds so entries whose window
// silently vanished (iPad scene teardown gives us no event at all) can
// be expired by age on mobile.
//
// Numbers are DERIVED, never reserved: after every membership change
// the registry renumbers 1..N in creation order ("main" always first),
// so closing window 2 of 3 leaves 1..2, and the next window opened is
// 3 — no gaps, no stale reservations. The stable identity is the
// label; the number is purely the display ordinal the sidebar badges
// show.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub label: String,
    pub number: u32,
    pub file_id: Option<String>,
    pub file_type: Option<String>,
}

struct Entry {
    info: WindowInfo,
    /// Creation order; "main" is pinned to 0 so it always numbers 1.
    seq: u64,
    /// Refreshed by every registry touch from the window's JS side.
    last_seen: Instant,
}

struct Inner {
    windows: HashMap<String, Entry>,
    next_seq: u64,
}

pub struct WindowRegistry {
    inner: Mutex<Inner>,
}

impl WindowRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                windows: HashMap::new(),
                next_seq: 1,
            }),
        }
    }

    /// Reassign numbers 1..N in creation (seq) order. Called after every
    /// membership change so the badge ordinals never carry gaps.
    fn renumber(inner: &mut Inner) {
        let mut order: Vec<(String, u64)> = inner
            .windows
            .iter()
            .map(|(label, e)| (label.clone(), e.seq))
            .collect();
        order.sort_by_key(|(_, seq)| *seq);
        for (i, (label, _)) in order.iter().enumerate() {
            if let Some(e) = inner.windows.get_mut(label) {
                e.info.number = (i + 1) as u32;
            }
        }
    }

    /// Insert (or refresh) the entry for a label. New labels take the
    /// next creation slot and the whole set renumbers.
    pub fn ensure(&self, label: &str) -> WindowInfo {
        let mut inner = self.inner.lock().unwrap();
        if let Some(e) = inner.windows.get_mut(label) {
            e.last_seen = Instant::now();
            return e.info.clone();
        }
        let seq = if label == "main" {
            0
        } else {
            let s = inner.next_seq;
            inner.next_seq += 1;
            s
        };
        inner.windows.insert(
            label.to_string(),
            Entry {
                info: WindowInfo {
                    label: label.to_string(),
                    number: 0,
                    file_id: None,
                    file_type: None,
                },
                seq,
                last_seen: Instant::now(),
            },
        );
        Self::renumber(&mut inner);
        inner.windows.get(label).unwrap().info.clone()
    }

    /// Refresh a window's liveness stamp. Returns false when the label
    /// is unknown (e.g. an iPad scene resuming after it was expired) —
    /// the caller re-registers it.
    pub fn touch(&self, label: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        match inner.windows.get_mut(label) {
            Some(e) => {
                e.last_seen = Instant::now();
                true
            }
            None => false,
        }
    }

    pub fn set_file(&self, label: &str, file_id: Option<String>, file_type: Option<String>) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(e) = inner.windows.get_mut(label) {
            e.info.file_id = file_id;
            e.info.file_type = file_type;
            e.last_seen = Instant::now();
        }
        // Unknown label: dropped silently — register_window owns entry
        // creation (set_file before register would mint a wrong seq).
    }

    pub fn remove(&self, label: &str) {
        let mut inner = self.inner.lock().unwrap();
        if inner.windows.remove(label).is_some() {
            Self::renumber(&mut inner);
        }
    }

    /// Drop entries whose label is not in `alive` — the windows the
    /// Tauri runtime still knows about. Returns true when anything went.
    pub fn prune<S: AsRef<str>>(&self, alive: &[S]) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let before = inner.windows.len();
        inner
            .windows
            .retain(|label, _| alive.iter().any(|a| a.as_ref() == label));
        let changed = inner.windows.len() != before;
        if changed {
            Self::renumber(&mut inner);
        }
        changed
    }

    /// Drop entries that haven't heartbeated within `max_age`. "main" is
    /// exempt — it's hidden rather than closed on macOS and must keep
    /// ordinal 1. Used on mobile, where a closed iPad scene produces no
    /// destroy event and can even linger in the runtime's window list.
    pub fn prune_stale(&self, max_age: Duration) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let before = inner.windows.len();
        inner
            .windows
            .retain(|label, e| label == "main" || e.last_seen.elapsed() <= max_age);
        let changed = inner.windows.len() != before;
        if changed {
            Self::renumber(&mut inner);
        }
        changed
    }

    pub fn list(&self) -> Vec<WindowInfo> {
        let mut out: Vec<WindowInfo> = self
            .inner
            .lock()
            .unwrap()
            .windows
            .values()
            .map(|e| e.info.clone())
            .collect();
        out.sort_by_key(|w| w.number);
        out
    }

    /// Test-only: age an entry's heartbeat stamp so staleness paths can
    /// be exercised without sleeping.
    #[cfg(test)]
    fn backdate(&self, label: &str, age: Duration) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(e) = inner.windows.get_mut(label) {
            e.last_seen = Instant::now() - age;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numbers(reg: &WindowRegistry) -> Vec<(String, u32)> {
        reg.list().into_iter().map(|w| (w.label, w.number)).collect()
    }

    #[test]
    fn numbers_follow_creation_order_with_main_first() {
        let reg = WindowRegistry::new();
        reg.ensure("window-a");
        reg.ensure("main");
        reg.ensure("window-b");
        assert_eq!(
            numbers(&reg),
            vec![
                ("main".into(), 1),
                ("window-a".into(), 2),
                ("window-b".into(), 3),
            ]
        );
    }

    #[test]
    fn closing_a_window_compacts_the_numbering() {
        let reg = WindowRegistry::new();
        reg.ensure("main");
        reg.ensure("window-a");
        reg.ensure("window-b");
        reg.remove("window-a");
        assert_eq!(
            numbers(&reg),
            vec![("main".into(), 1), ("window-b".into(), 2)]
        );
        // The next window takes the next compact slot — no reserved gap.
        reg.ensure("window-c");
        assert_eq!(
            numbers(&reg),
            vec![
                ("main".into(), 1),
                ("window-b".into(), 2),
                ("window-c".into(), 3),
            ]
        );
    }

    #[test]
    fn ensure_is_idempotent_and_keeps_the_number() {
        let reg = WindowRegistry::new();
        reg.ensure("main");
        let first = reg.ensure("window-a");
        let again = reg.ensure("window-a");
        assert_eq!(first.number, again.number);
        assert_eq!(reg.list().len(), 2);
    }

    #[test]
    fn stale_entries_expire_but_main_survives() {
        let reg = WindowRegistry::new();
        reg.ensure("main");
        reg.ensure("window-a");
        reg.ensure("window-b");
        reg.backdate("main", Duration::from_secs(60));
        reg.backdate("window-a", Duration::from_secs(60));
        assert!(reg.prune_stale(Duration::from_secs(15)));
        assert_eq!(
            numbers(&reg),
            vec![("main".into(), 1), ("window-b".into(), 2)]
        );
    }

    #[test]
    fn touch_keeps_an_entry_alive_and_reports_unknown_labels() {
        let reg = WindowRegistry::new();
        reg.ensure("window-a");
        reg.backdate("window-a", Duration::from_secs(60));
        assert!(reg.touch("window-a")); // refreshes last_seen
        assert!(!reg.prune_stale(Duration::from_secs(15)));
        assert!(!reg.touch("window-ghost"));
    }

    #[test]
    fn resumed_window_reregisters_with_a_fresh_compact_number() {
        let reg = WindowRegistry::new();
        reg.ensure("main");
        reg.ensure("window-a");
        reg.backdate("window-a", Duration::from_secs(60));
        reg.prune_stale(Duration::from_secs(15));
        reg.ensure("window-b");
        // window-a resumes after being expired: it re-registers at the
        // tail rather than reclaiming its old slot.
        reg.ensure("window-a");
        assert_eq!(
            numbers(&reg),
            vec![
                ("main".into(), 1),
                ("window-b".into(), 2),
                ("window-a".into(), 3),
            ]
        );
    }

    #[test]
    fn set_file_ignores_unknown_labels() {
        let reg = WindowRegistry::new();
        reg.set_file("window-ghost", Some("f1".into()), Some("document".into()));
        assert!(reg.list().is_empty());
    }
}
