use tauri::State;

use crate::{AppState, pdfs::PdfMeta};

#[tauri::command]
pub fn save_pdf(state: State<AppState>, file_id: String, bytes: Vec<u8>) -> Result<(), String> {
    state.pdf_manager.lock().unwrap()
        .save(&file_id, &bytes)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_pdf(state: State<AppState>, file_id: String) -> Result<Vec<u8>, String> {
    state.pdf_manager.lock().unwrap()
        .load(&file_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_pdf(state: State<AppState>, file_id: String) -> Result<(), String> {
    state.pdf_manager.lock().unwrap()
        .delete(&file_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pdf_exists(state: State<AppState>, file_id: String) -> Result<bool, String> {
    Ok(state.pdf_manager.lock().unwrap().exists(&file_id))
}

#[tauri::command]
pub fn save_pdf_meta(state: State<AppState>, file_id: String, meta: PdfMeta) -> Result<(), String> {
    state.pdf_manager.lock().unwrap()
        .save_meta(&file_id, &meta)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_pdf_meta(state: State<AppState>, file_id: String) -> Result<Option<PdfMeta>, String> {
    state.pdf_manager.lock().unwrap()
        .load_meta(&file_id)
        .map_err(|e| e.to_string())
}
