use tauri::State;

use crate::settings::AppSettings;
use crate::AppState;

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> AppSettings {
    state.settings.lock().unwrap().clone()
}

/// Replace the whole settings object. **Superseded by `patch_settings`
/// — nothing in the frontend calls this any more.** It stays registered
/// because a stale web bundle paired with a fresh binary is a routine
/// state on iPad (see Settings → Debug → Build Info), and a bundle that
/// still writes this way should keep working rather than losing every
/// setting it tries to save.
#[tauri::command]
pub fn save_settings(state: State<AppState>, settings: AppSettings) -> Result<(), String> {
    let mut current = state.settings.lock().unwrap();
    let data_dir = current.data_dir.clone(); // Preserve — it's #[serde(skip)]
    *current = settings.clone();
    current.data_dir = data_dir;
    current.save().map_err(|e| e.to_string())
}

/// Write **only the keys in `patch`**, leaving every other setting as it
/// stands on disk. Returns the settings as they are after the write, so
/// the caller can reconcile its own copy without a second round trip.
///
/// This is the write path every caller should use. `save_settings` takes
/// a whole `AppSettings`, which means the caller is asserting a value for
/// every setting in the app — including the ones it has never heard of
/// and the ones that changed while it was holding its copy. That is how
/// a closed floating pane came back: the pane list is written on a 300 ms
/// debounce, and any unrelated full-object write in flight around it
/// (a session save, a slider release, the Settings panel's own snapshot
/// from when it was opened) carried the pre-close list back over the top.
/// Intermittent by nature — it depended on which write landed last.
///
/// Read-modify-write happens here, under the settings mutex, rather than
/// in JS across two `invoke` calls, so concurrent patches can't
/// interleave: whatever else is in flight, a patch changes its own keys
/// and nothing else.
///
/// Merging is done through `serde_json` because `AppSettings` is a typed
/// struct with no runtime field access. Unknown keys in the patch are
/// dropped on the round trip back through `Deserialize`, which is the
/// same contract every other settings write has always had (see the
/// "every JS-visible setting must have a field on `AppSettings`" rule).
#[tauri::command]
pub fn patch_settings(
    state: State<AppState>,
    patch: serde_json::Value,
) -> Result<AppSettings, String> {
    let patch = match patch {
        serde_json::Value::Object(map) => map,
        _ => return Err("patch must be an object".into()),
    };
    let mut current = state.settings.lock().unwrap();
    let data_dir = current.data_dir.clone(); // Preserve — it's #[serde(skip)]

    let mut merged = serde_json::to_value(&*current).map_err(|e| e.to_string())?;
    {
        let obj = merged
            .as_object_mut()
            .ok_or_else(|| "settings did not serialize to an object".to_string())?;
        for (key, value) in patch {
            obj.insert(key, value);
        }
    }
    let mut next: AppSettings = serde_json::from_value(merged).map_err(|e| e.to_string())?;
    next.data_dir = data_dir;
    *current = next;
    current.save().map_err(|e| e.to_string())?;
    Ok(current.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The merge itself, lifted out of the command so it can be exercised
    /// without a Tauri `State`. Mirrors `patch_settings` exactly.
    fn merge(current: &AppSettings, patch: serde_json::Value) -> AppSettings {
        let mut merged = serde_json::to_value(current).unwrap();
        let obj = merged.as_object_mut().unwrap();
        for (key, value) in patch.as_object().unwrap() {
            obj.insert(key.clone(), value.clone());
        }
        serde_json::from_value(merged).unwrap()
    }

    #[test]
    fn a_patch_changes_only_its_own_keys() {
        let mut current = AppSettings::default();
        current.font_size = 21;
        current.persisted_panes = vec![serde_json::json!({ "fileId": "keep-me" })];

        // A write about something else entirely must not disturb the
        // pane list — this is the bug the command exists to fix.
        let next = merge(&current, serde_json::json!({ "appearance": "light" }));
        assert_eq!(next.appearance, "light");
        assert_eq!(next.font_size, 21);
        assert_eq!(next.persisted_panes, current.persisted_panes);
    }

    #[test]
    fn a_patch_can_empty_a_list() {
        let mut current = AppSettings::default();
        current.persisted_panes = vec![serde_json::json!({ "fileId": "close-me" })];
        let next = merge(&current, serde_json::json!({ "persistedPanes": [] }));
        assert!(next.persisted_panes.is_empty());
    }

    #[test]
    fn unknown_keys_are_dropped_not_fatal() {
        let current = AppSettings::default();
        let next = merge(&current, serde_json::json!({ "notASetting": 1, "appearance": "dark" }));
        assert_eq!(next.appearance, "dark");
    }
}
