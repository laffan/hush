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

#[tauri::command]
pub fn save_zotero_collections(state: State<AppState>, data: String) -> Result<(), String> {
    state.zotero_manager.lock().unwrap()
        .save_collections(&data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_zotero_collections(state: State<AppState>) -> Result<String, String> {
    state.zotero_manager.lock().unwrap()
        .load_collections()
        .map_err(|e| e.to_string())
}

/// Persist a downloaded Zotero PDF locally, keyed by attachment id.
/// PDFs live under `{data_dir}/zotero_pdfs/{itemKey}.pdf` and are not
/// part of any sync folder — they're a local cache for snapshot
/// generation and follow-up reads.
#[tauri::command]
pub fn save_zotero_pdf(state: State<AppState>, item_key: String, bytes: Vec<u8>) -> Result<(), String> {
    state.zotero_manager.lock().unwrap()
        .save_pdf(&item_key, &bytes)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_zotero_pdf(state: State<AppState>, item_key: String) -> Result<Vec<u8>, String> {
    state.zotero_manager.lock().unwrap()
        .load_pdf(&item_key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn zotero_pdf_exists(state: State<AppState>, item_key: String) -> Result<bool, String> {
    Ok(state.zotero_manager.lock().unwrap().pdf_exists(&item_key))
}

/// Download a Zotero PDF attachment server-side (avoiding the webview's
/// CORS restrictions on S3-redirected attachment URLs), persist it under
/// `{data_dir}/zotero_pdfs/{itemKey}.pdf`, and return the bytes.
///
/// If the PDF was previously downloaded for this key, it's served from
/// disk without re-fetching. Callers should invalidate by deleting the
/// file out-of-band if they want a fresh copy.
#[tauri::command]
pub async fn download_zotero_pdf(
    state: State<'_, AppState>,
    item_key: String,
    user_id: String,
    api_key: String,
) -> Result<Vec<u8>, String> {
    {
        let mgr = state.zotero_manager.lock().unwrap();
        if mgr.pdf_exists(&item_key) {
            return mgr.load_pdf(&item_key).map_err(|e| e.to_string());
        }
    }
    let url = format!(
        "https://api.zotero.org/users/{}/items/{}/file",
        user_id, item_key
    );
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .header("Zotero-API-Key", &api_key)
        .header("Zotero-API-Version", "3")
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("PDF download failed: {} {}", status, body));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
    state
        .zotero_manager
        .lock()
        .unwrap()
        .save_pdf(&item_key, &bytes)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

/// Persist annotations JSON for a Zotero attachment.
#[tauri::command]
pub fn save_zotero_annotations(
    state: State<AppState>,
    item_key: String,
    data: String,
) -> Result<(), String> {
    state
        .zotero_manager
        .lock()
        .unwrap()
        .save_annotations(&item_key, &data)
        .map_err(|e| e.to_string())
}

/// Load cached annotations JSON for an attachment. Returns `None` when
/// the cache hasn't been populated yet.
#[tauri::command]
pub fn load_zotero_annotations(
    state: State<AppState>,
    item_key: String,
) -> Result<Option<String>, String> {
    state
        .zotero_manager
        .lock()
        .unwrap()
        .load_annotations(&item_key)
        .map_err(|e| e.to_string())
}

/// Fetch all annotations for a PDF attachment server-side (avoiding
/// webview CORS quirks for the rare deployment that gates the
/// annotations endpoint), persist the raw response into the local
/// cache, and return the JSON string. The frontend handles the
/// parent/sort/grouping logic; this command just gathers the pages
/// and stitches them together.
#[tauri::command]
pub async fn fetch_zotero_annotations(
    state: State<'_, AppState>,
    item_key: String,
    user_id: String,
    api_key: String,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;

    let mut all = Vec::<serde_json::Value>::new();
    let page_size: usize = 100;
    let mut start: usize = 0;
    loop {
        // The `/items?parentItem=…` filter doesn't actually scope to that
        // parent — Zotero returns every matching item in the library. The
        // `/items/{key}/children` endpoint is the documented way to fetch
        // the annotations attached to a specific PDF.
        let url = format!(
            "https://api.zotero.org/users/{}/items/{}/children?itemType=annotation&format=json&limit={}&start={}",
            user_id, item_key, page_size, start
        );
        let resp = client
            .get(&url)
            .header("Zotero-API-Key", &api_key)
            .header("Zotero-API-Version", "3")
            .send()
            .await
            .map_err(|e| format!("Network error: {}", e))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Annotation fetch failed: {} {}", status, body));
        }
        let total_results: usize = resp
            .headers()
            .get("Total-Results")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let batch: Vec<serde_json::Value> =
            resp.json().await.map_err(|e| e.to_string())?;
        let batch_len = batch.len();
        all.extend(batch);
        start += page_size;
        if start >= total_results || batch_len == 0 {
            break;
        }
    }

    let serialized = serde_json::to_string(&all).map_err(|e| e.to_string())?;
    state
        .zotero_manager
        .lock()
        .unwrap()
        .save_annotations(&item_key, &serialized)
        .map_err(|e| e.to_string())?;
    Ok(serialized)
}
