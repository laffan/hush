use tauri::State;

use crate::AppState;

#[tauri::command]
pub fn save_zotero_references(state: State<AppState>, data: String) -> Result<(), String> {
    state.zotero_manager.lock().unwrap()
        .save_references(&data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_zotero_references(state: State<AppState>) -> Result<String, String> {
    state.zotero_manager.lock().unwrap()
        .load_references()
        .map_err(|e| e.to_string())
}
