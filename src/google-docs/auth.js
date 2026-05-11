/**
 * Google OAuth 2.0 PKCE flow + token cache. Mirrors the structure of
 * `sync/dropbox.js` so the two providers behave the same way at the
 * `handleOAuthCode` dispatch level.
 *
 * Credentials live in `AppSettings` (entered by the user in Settings >
 * Sync > Google Sync — Client ID + optional Client Secret), so each
 * install supplies its own OAuth client rather than embedding one at
 * build time. The redirect URI is fixed at `hushwriter://auth/google/callback`
 * for production; dev installs that need to use the loopback flow can
 * override via the optional `VITE_GOOGLE_REDIRECT_URI` env var.
 *
 * Scopes requested (read+write to whatever Hush links to):
 *   - https://www.googleapis.com/auth/drive          full Drive R/W
 *   - https://www.googleapis.com/auth/userinfo.email account email for the
 *                                                    Settings tab "Connected as" line
 *
 * The narrow `drive.file` scope was tempting but only grants per-file
 * access for files the app created or that the user explicitly picked
 * via Google Picker. Since Hush's link flow uses our own picker (a small
 * Drive `files.list` modal — see `picker.js`), we'd be locked out of
 * existing user-created docs without `drive`.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

// Dev override for the redirect URI — only needed if the user wires
// the loopback flow into the OAuth client. Production always uses the
// custom-scheme deep link.
const DEV_REDIRECT_URI_OVERRIDE = typeof import.meta !== "undefined"
  ? (import.meta.env.VITE_GOOGLE_REDIRECT_URI || "")
  : "";
const PRODUCTION_REDIRECT_URI = "hushwriter://auth/google/callback";

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

let _clientId = null; // loaded on demand from settings
let _accessToken = null;
let _refreshToken = null;
let _expiresAt = 0; // unix seconds
let _refreshing = null;

export function getAccessToken() { return _accessToken; }
export function hasTokens() { return !!_accessToken || !!_refreshToken; }
export function getRedirectUri() {
  return DEV_REDIRECT_URI_OVERRIDE || PRODUCTION_REDIRECT_URI;
}
// Resolve the user-entered client id from settings. Cached after first
// read; explicit clear via `setClientId(null)` on credential edits.
export async function getClientId() {
  if (_clientId) return _clientId;
  if (!IS_TAURI) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const settings = await invoke("get_settings");
    _clientId = settings.googleClientId || null;
    return _clientId;
  } catch (_) { return null; }
}
export function setClientId(v) { _clientId = v || null; }

export function clearTokens() {
  _accessToken = null;
  _refreshToken = null;
  _expiresAt = 0;
}

async function ensureTokens() {
  if (_accessToken) return;
  if (!IS_TAURI) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const settings = await invoke("get_settings");
    if (settings.googleAccessToken) {
      _accessToken = settings.googleAccessToken;
      _refreshToken = settings.googleRefreshToken || null;
      _expiresAt = settings.googleTokenExpiresAt || 0;
    }
  } catch (_) { /* ignore */ }
}

async function refreshAccessToken() {
  if (_refreshing) return _refreshing;
  _refreshing = (async () => {
    try {
      if (!_refreshToken) await ensureTokens();
      if (!IS_TAURI) throw new Error("Google token refresh requires Tauri");
      if (!_refreshToken) throw new Error("No Google refresh token stored");
      const { invoke } = await import("@tauri-apps/api/core");
      const newToken = await invoke("refresh_google_token");
      _accessToken = newToken;
      // Re-pull expiry from settings — Rust updates it on the same call.
      try {
        const s = await invoke("get_settings");
        _expiresAt = s.googleTokenExpiresAt || 0;
      } catch (_) {}
      return newToken;
    } finally {
      _refreshing = null;
    }
  })();
  return _refreshing;
}

// Authenticated fetch: loads tokens on demand, refreshes proactively if
// the cached expiry is past, and reactively on a 401.
export async function gFetch(url, options = {}) {
  await ensureTokens();
  if (!_accessToken && _refreshToken) await refreshAccessToken();
  const now = Math.floor(Date.now() / 1000);
  if (_expiresAt && now >= _expiresAt - 30 && _refreshToken) {
    await refreshAccessToken();
  }
  const headers = { ..._authHeaders(), ...(options.headers || {}) };
  let resp = await fetch(url, { ...options, headers });
  if (resp.status === 401 && _refreshToken) {
    await refreshAccessToken();
    resp = await fetch(url, {
      ...options,
      headers: { ..._authHeaders(), ...(options.headers || {}) },
    });
  }
  return resp;
}

function _authHeaders() {
  if (!_accessToken) throw new Error("Google not authenticated");
  return { Authorization: `Bearer ${_accessToken}` };
}

// ===== PKCE =====

function generateCodeVerifier() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return base64UrlEncode(arr);
}

async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ===== OAuth flow =====

export async function startOAuthFlow() {
  const clientId = await getClientId();
  if (!clientId) {
    throw new Error("Google Client ID is not set. Enter your OAuth credentials in Settings > Sync > Google Sync.");
  }
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const redirectUri = getRedirectUri();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent", // force a refresh_token on every consent
    include_granted_scopes: "true",
    state: "google", // dispatch hint for the shared OAuth callback
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  if (IS_TAURI) {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.openUrl(authUrl);
  } else {
    window.open(authUrl, "_blank");
  }
  return { codeVerifier, redirectUri };
}

export async function completeOAuthFlow(code, codeVerifier, redirectUri) {
  if (!IS_TAURI) throw new Error("OAuth exchange requires Tauri");
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke("exchange_google_token", {
    code,
    codeVerifier,
    redirectUri,
  });
  _accessToken = result.access_token;
  _refreshToken = result.refresh_token || _refreshToken;
  if (result.expires_in) {
    _expiresAt = Math.floor(Date.now() / 1000) + Number(result.expires_in);
  }
  // Best-effort: fetch the account email so the Settings tab can show it.
  try {
    const r = await gFetch("https://www.googleapis.com/oauth2/v2/userinfo");
    if (r.ok) {
      const info = await r.json();
      if (info.email) {
        await invoke("set_google_account_email", { email: info.email });
      }
    }
  } catch (_) { /* non-fatal */ }
  return result;
}

export async function disconnect() {
  if (!IS_TAURI) {
    clearTokens();
    return;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("revoke_google_tokens");
  } catch (e) {
    console.warn("Google revoke failed (continuing locally):", e);
  }
  clearTokens();
}

// Quick connectivity check used by the Settings tab.
export async function testConnection() {
  try {
    const r = await gFetch("https://www.googleapis.com/oauth2/v2/userinfo");
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const data = await r.json();
    return { ok: true, email: data.email || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
