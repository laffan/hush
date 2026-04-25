use tauri::State;

use crate::settings::AppSettings;
use crate::AppState;

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> AppSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_settings(state: State<AppState>, settings: AppSettings) -> Result<(), String> {
    let mut current = state.settings.lock().unwrap();
    let data_dir = current.data_dir.clone(); // Preserve — it's #[serde(skip)]
    *current = settings.clone();
    current.data_dir = data_dir;
    current.save().map_err(|e| e.to_string())
}
