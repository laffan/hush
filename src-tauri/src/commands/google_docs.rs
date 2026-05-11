// Google Docs integration — OAuth PKCE token exchange / refresh, plus the
// per-document link map (`{ hushFileId: { docId, title, linkedAt } }`)
// stored alongside settings. There's intentionally no auto-sync engine
// here: push/pull are user-driven whole-document replaces, modelled on
// the link bar UI rather than the Dropbox cursor pipeline.

use tauri::State;

use crate::settings::GoogleDocLink;
use crate::AppState;

// ===== Google OAuth =====

#[tauri::command]
pub async fn exchange_google_token(
    state: State<'_, AppState>,
    code: String,
    code_verifier: String,
    redirect_uri: String,
) -> Result<serde_json::Value, String> {
    // Read client credentials from settings. Google's Desktop-app OAuth
    // clients still require the secret in the token-exchange POST even
    // with PKCE — it's documented "not really secret" since it ships
    // with the app, but the form needs it. Native / UWP clients with no
    // secret simply leave the field empty (we don't include it).
    let (client_id, client_secret) = {
        let settings = state.settings.lock().unwrap();
        (
            settings.google_client_id.clone().ok_or("Google Client ID is not set")?,
            settings.google_client_secret.clone(),
        )
    };
    let mut form: Vec<(&str, &str)> = vec![
        ("code", code.as_str()),
        ("grant_type", "authorization_code"),
        ("code_verifier", code_verifier.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("client_id", client_id.as_str()),
    ];
    let secret_str = client_secret.as_deref().unwrap_or("");
    if !secret_str.trim().is_empty() {
        form.push(("client_secret", secret_str));
    }
    let client = reqwest::Client::new();
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Google token exchange failed: {}", body));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    {
        let mut settings = state.settings.lock().unwrap();
        if let Some(at) = json.get("access_token").and_then(|v| v.as_str()) {
            settings.google_access_token = Some(at.to_string());
        }
        if let Some(rt) = json.get("refresh_token").and_then(|v| v.as_str()) {
            settings.google_refresh_token = Some(rt.to_string());
        }
        if let Some(exp) = json.get("expires_in").and_then(|v| v.as_i64()) {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            settings.google_token_expires_at = Some(now + exp);
        }
        let _ = settings.save();
    }

    Ok(json)
}

#[tauri::command]
pub async fn refresh_google_token(
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (refresh_token, client_id, client_secret) = {
        let settings = state.settings.lock().unwrap();
        (
            settings.google_refresh_token.clone()
                .ok_or("No Google refresh token stored")?,
            settings.google_client_id.clone()
                .ok_or("Google Client ID is not set")?,
            settings.google_client_secret.clone(),
        )
    };

    let mut form: Vec<(&str, &str)> = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token.as_str()),
        ("client_id", client_id.as_str()),
    ];
    let secret_str = client_secret.as_deref().unwrap_or("");
    if !secret_str.trim().is_empty() {
        form.push(("client_secret", secret_str));
    }
    let client = reqwest::Client::new();
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Google token refresh failed: {}", body));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let new_token = json.get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("No access_token in Google refresh response")?
        .to_string();

    {
        let mut settings = state.settings.lock().unwrap();
        settings.google_access_token = Some(new_token.clone());
        if let Some(exp) = json.get("expires_in").and_then(|v| v.as_i64()) {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            settings.google_token_expires_at = Some(now + exp);
        }
        let _ = settings.save();
    }

    Ok(new_token)
}

#[tauri::command]
pub async fn revoke_google_tokens(
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Try the revocation endpoint, but don't fail if it errors — the user
    // is disconnecting locally regardless. Their consent on Google's side
    // can also be cleared via myaccount.google.com.
    let access = {
        let s = state.settings.lock().unwrap();
        s.google_access_token.clone()
    };
    if let Some(token) = access {
        let client = reqwest::Client::new();
        let _ = client
            .post(format!("https://oauth2.googleapis.com/revoke?token={}", token))
            .send()
            .await;
    }
    {
        let mut settings = state.settings.lock().unwrap();
        settings.google_access_token = None;
        settings.google_refresh_token = None;
        settings.google_token_expires_at = None;
        settings.google_account_email = None;
        settings.google_doc_links.clear();
        let _ = settings.save();
    }
    Ok(())
}

#[tauri::command]
pub fn set_google_account_email(
    state: State<AppState>,
    email: String,
) -> Result<(), String> {
    let mut settings = state.settings.lock().unwrap();
    settings.google_account_email = Some(email);
    settings.save().map_err(|e| e.to_string())
}

// ===== Per-document link map =====

#[tauri::command]
pub fn set_google_doc_link(
    state: State<AppState>,
    file_id: String,
    doc_id: String,
    title: String,
) -> Result<(), String> {
    let mut settings = state.settings.lock().unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    settings.google_doc_links.insert(file_id, GoogleDocLink {
        doc_id,
        title,
        linked_at: now,
    });
    settings.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_google_doc_link(
    state: State<AppState>,
    file_id: String,
) -> Option<GoogleDocLink> {
    state.settings.lock().unwrap()
        .google_doc_links
        .get(&file_id)
        .cloned()
}

#[tauri::command]
pub fn clear_google_doc_link(
    state: State<AppState>,
    file_id: String,
) -> Result<(), String> {
    let mut settings = state.settings.lock().unwrap();
    settings.google_doc_links.remove(&file_id);
    settings.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_google_doc_links(
    state: State<AppState>,
) -> std::collections::HashMap<String, GoogleDocLink> {
    state.settings.lock().unwrap()
        .google_doc_links
        .clone()
}

// Append a single-line entry to the persisted Google sync log. Capped at
// 50 entries (FIFO) so the log doesn't grow unbounded across sessions.
#[tauri::command]
pub fn append_google_sync_log(
    state: State<AppState>,
    entry: String,
) -> Result<(), String> {
    let mut settings = state.settings.lock().unwrap();
    settings.google_sync_log.push(entry);
    let len = settings.google_sync_log.len();
    if len > 50 {
        settings.google_sync_log.drain(0..(len - 50));
    }
    settings.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_google_sync_log(
    state: State<AppState>,
) -> Result<(), String> {
    let mut settings = state.settings.lock().unwrap();
    settings.google_sync_log.clear();
    settings.save().map_err(|e| e.to_string())
}
