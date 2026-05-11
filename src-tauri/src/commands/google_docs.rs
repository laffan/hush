// Google Docs integration — OAuth PKCE token exchange / refresh, plus the
// per-document link map (`{ hushFileId: { docId, title, linkedAt } }`)
// stored alongside settings. There's intentionally no auto-sync engine
// here: push/pull are user-driven whole-document replaces, modelled on
// the link bar UI rather than the Dropbox cursor pipeline.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, State};

use crate::settings::GoogleDocLink;
use crate::AppState;

// ===== Google OAuth loopback listener =====

/// Start an ephemeral HTTP listener on `127.0.0.1:<random>` and return
/// the chosen port. Google's OAuth-for-Desktop policy requires loopback
/// redirects rather than custom URI schemes (custom schemes are only
/// supported for iOS / Android / UWP clients) — register `http://127.0.0.1`
/// as the redirect URI on your OAuth client and Google wildcards the
/// port at runtime.
///
/// The listener accepts a single inbound connection, parses the OAuth
/// callback's `code` (or `error`) param out of the query string, writes
/// a tiny "you can close this window" HTML page back, and emits an
/// `oauth-callback` event with the captured code so the existing
/// settings-window dispatcher can complete the flow exactly like the
/// deep-link path used to. A 5-minute timeout cleans up if no callback
/// arrives (the user closed the browser tab, etc.).
#[tauri::command]
pub fn start_google_oauth_listener(handle: AppHandle) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind loopback listener: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    listener.set_nonblocking(true).ok();

    std::thread::spawn(move || {
        let start = Instant::now();
        let timeout = Duration::from_secs(300);
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    handle_oauth_callback_request(&mut stream, &handle);
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if start.elapsed() > timeout {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(150));
                }
                Err(_) => break,
            }
        }
    });

    Ok(port)
}

fn handle_oauth_callback_request(stream: &mut std::net::TcpStream, handle: &AppHandle) {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .ok();
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf).unwrap_or(0);
    let req = String::from_utf8_lossy(&buf[..n]).to_string();

    let (code, error) = parse_code_and_error(&req);

    // Write a friendly response page so the browser shows something
    // useful regardless of outcome.
    let body = if code.is_some() {
        SUCCESS_HTML.to_string()
    } else {
        format!(
            "{}<p style=\"color:#ff6b6b;font-size:13px;margin-top:12px\">{}</p>{}",
            ERROR_HTML_PREFIX,
            html_escape(error.as_deref().unwrap_or("No authorization code received.")),
            ERROR_HTML_SUFFIX,
        )
    };
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();

    if let Some(c) = code {
        let _ = handle.emit(
            "oauth-callback",
            serde_json::json!({ "code": c, "provider": "google" }),
        );
    }
}

// Parses `code` + `error` from the request line `GET /?…&code=…&… HTTP/1.1`.
// Hand-rolled because the OAuth callback format is fixed and shapeless
// enough that pulling in a URL crate would be overkill.
fn parse_code_and_error(req: &str) -> (Option<String>, Option<String>) {
    let first_line = match req.lines().next() {
        Some(s) => s,
        None => return (None, None),
    };
    let path = match first_line.split_whitespace().nth(1) {
        Some(p) => p,
        None => return (None, None),
    };
    let query = match path.split_once('?') {
        Some((_, q)) => q,
        None => return (None, None),
    };
    let mut code = None;
    let mut error = None;
    for pair in query.split('&') {
        let (key, value) = match pair.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        match key {
            "code" => code = Some(url_decode(value)),
            "error" => error = Some(url_decode(value)),
            _ => {}
        }
    }
    (code, error)
}

fn url_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'+' {
            out.push(' ');
            i += 1;
        } else if b == b'%' && i + 2 < bytes.len() {
            let h1 = bytes[i + 1] as char;
            let h2 = bytes[i + 2] as char;
            if let Some(d1) = h1.to_digit(16) {
                if let Some(d2) = h2.to_digit(16) {
                    out.push(((d1 << 4) | d2) as u8 as char);
                    i += 3;
                    continue;
                }
            }
            out.push('%');
            i += 1;
        } else {
            out.push(b as char);
            i += 1;
        }
    }
    out
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

const SUCCESS_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Hush — Connected</title><style>body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}.card{text-align:center;padding:40px;border-radius:12px;background:#16213e;max-width:400px}h1{font-size:1.4em;margin:0 0 12px}p{opacity:0.7;margin:0;line-height:1.5}</style></head><body><div class=\"card\"><h1>Connected!</h1><p>You can close this window and return to Hush.</p></div></body></html>";

const ERROR_HTML_PREFIX: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Hush — Authorization Failed</title><style>body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}.card{text-align:center;padding:40px;border-radius:12px;background:#16213e;max-width:400px}h1{font-size:1.4em;margin:0 0 12px}p{opacity:0.7;margin:0;line-height:1.5}</style></head><body><div class=\"card\"><h1>Authorization failed</h1>";
const ERROR_HTML_SUFFIX: &str = "</div></body></html>";

// ===== Google OAuth (token exchange / refresh) =====

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
