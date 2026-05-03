// Cross-window registry — tracks every open Hush window and the file
// each one is currently displaying. Consumed by the sidebar so it can
// paint a numeral badge next to whichever file each window has open.
//
// Every window calls `register_window` on init to claim its number and
// `set_window_file` whenever its active document / notebook changes.
// `lib.rs` removes the entry on `WindowEvent::Destroyed` so the badge
// disappears as soon as the window closes.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub label: String,
    pub number: u32,
    pub file_id: Option<String>,
    pub file_type: Option<String>,
}

struct Inner {
    windows: HashMap<String, WindowInfo>,
    next_number: u32,
}

pub struct WindowRegistry {
    inner: Mutex<Inner>,
}

impl WindowRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                windows: HashMap::new(),
                next_number: 1,
            }),
        }
    }

    /// Insert (or fetch) the entry for a label, assigning the next
    /// sequential number on first sighting.
    pub fn ensure(&self, label: &str) -> WindowInfo {
        let mut inner = self.inner.lock().unwrap();
        if let Some(info) = inner.windows.get(label) {
            return info.clone();
        }
        let n = inner.next_number;
        inner.next_number += 1;
        let info = WindowInfo {
            label: label.to_string(),
            number: n,
            file_id: None,
            file_type: None,
        };
        inner.windows.insert(label.to_string(), info.clone());
        info
    }

    pub fn set_file(&self, label: &str, file_id: Option<String>, file_type: Option<String>) {
        let mut inner = self.inner.lock().unwrap();
        let entry = inner.windows.entry(label.to_string()).or_insert_with(|| {
            // Defensive: a set_file before register_window shouldn't
            // happen, but if it does we still want a stable number.
            WindowInfo {
                label: label.to_string(),
                number: 0,
                file_id: None,
                file_type: None,
            }
        });
        entry.file_id = file_id;
        entry.file_type = file_type;
    }

    pub fn remove(&self, label: &str) {
        self.inner.lock().unwrap().windows.remove(label);
    }

    pub fn list(&self) -> Vec<WindowInfo> {
        let mut out: Vec<WindowInfo> = self
            .inner
            .lock()
            .unwrap()
            .windows
            .values()
            .cloned()
            .collect();
        out.sort_by_key(|w| w.number);
        out
    }
}
