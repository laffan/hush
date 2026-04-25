use serde::Serialize;
use tauri::State;

use crate::{AppState, FileEntry, TreeNode};

#[tauri::command]
pub fn list_files(state: State<AppState>) -> Result<Vec<FileEntry>, String> {
    state.file_manager.lock().unwrap().list_files().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_file(state: State<AppState>, id: String) -> Result<FileEntry, String> {
    state.file_manager.lock().unwrap().load_file(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_file(state: State<AppState>, id: String, content: String) -> Result<(), String> {
    let fm = state.file_manager.lock().unwrap();
    fm.save_file(&id, &content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn create_file(state: State<AppState>) -> Result<FileEntry, String> {
    state.file_manager.lock().unwrap().create_file().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_file(state: State<AppState>, id: String) -> Result<(), String> {
    state.file_manager.lock().unwrap().delete_file(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_file(state: State<AppState>, id: String, name: String) -> Result<(), String> {
    state.file_manager.lock().unwrap().rename_file(&id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_file_tree(state: State<AppState>) -> Result<Vec<TreeNode>, String> {
    state.file_manager.lock().unwrap().get_file_tree().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_file_tree(state: State<AppState>, tree: Vec<TreeNode>) -> Result<(), String> {
    state.file_manager.lock().unwrap().save_file_tree(&tree).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_folder(state: State<AppState>, name: String, parent_id: Option<String>) -> Result<TreeNode, String> {
    state.file_manager.lock().unwrap().create_folder(&name, parent_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_project(state: State<AppState>, name: String, parent_id: Option<String>) -> Result<TreeNode, String> {
    state.file_manager.lock().unwrap().create_project(&name, parent_id.as_deref()).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookCreated {
    node: TreeNode,
    file: FileEntry,
}

#[tauri::command]
pub fn create_notebook(state: State<AppState>, name: String, parent_id: Option<String>) -> Result<NotebookCreated, String> {
    let (node, file) = state.file_manager.lock().unwrap()
        .create_notebook(&name, parent_id.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(NotebookCreated { node, file })
}

#[tauri::command]
pub fn load_project_content(state: State<AppState>, project_id: String) -> Result<Vec<FileEntry>, String> {
    state.file_manager.lock().unwrap().load_project_content(&project_id).map_err(|e| e.to_string())
}
