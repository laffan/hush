/**
 * Dropbox API client with OAuth PKCE authentication.
 * Uses Dropbox HTTP API directly via fetch (no SDK needed).
 * Token management: access tokens auto-refresh via refresh token.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

// The Dropbox App Key is injected at build time via Vite env variable
const APP_KEY = typeof import.meta !== "undefined"
  ? import.meta.env.VITE_DROPBOX_APP_KEY || ""
  : "";

let _accessToken = null;
let _refreshToken = null;
let _refreshing = null; // dedup concurrent refresh attempts

// ===== Token Management =====

export function setTokens(accessToken, refreshToken) {
  _accessToken = accessToken;
  _refreshToken = refreshToken;
}

export function getAccessToken() {
  return _accessToken;
}

export function hasTokens() {
  return !!_accessToken;
}

export function clearTokens() {
  _accessToken = null;
  _refreshToken = null;
}

/**
 * Refresh the access token using the stored refresh token.
 * Deduplicates concurrent calls.
 */
async function refreshAccessToken() {
  if (_refreshing) return _refreshing;
  _refreshing = (async () => {
    try {
      if (IS_TAURI) {
        const { invoke } = await import("@tauri-apps/api/core");
        const newToken = await invoke("refresh_dropbox_token", { appKey: APP_KEY });
        _accessToken = newToken;
        return newToken;
      }
      throw new Error("Token refresh requires Tauri");
    } finally {
      _refreshing = null;
    }
  })();
  return _refreshing;
}

function authHeaders() {
  if (!_accessToken) throw new Error("Dropbox not authenticated");
  return { Authorization: `Bearer ${_accessToken}` };
}

/**
 * Fetch wrapper that auto-refreshes on 401 and retries once.
 */
async function dbxFetch(url, options = {}) {
  let resp = await fetch(url, {
    ...options,
    headers: { ...authHeaders(), ...options.headers },
  });
  if (resp.status === 401 && _refreshToken) {
    await refreshAccessToken();
    resp = await fetch(url, {
      ...options,
      headers: { ...authHeaders(), ...options.headers },
    });
  }
  return resp;
}

// ===== OAuth PKCE Flow =====

/**
 * Generate a cryptographically random code verifier for PKCE.
 */
function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

/**
 * Derive the code challenge from the verifier (S256).
 */
async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Start the OAuth PKCE flow. Opens the Dropbox auth page in the system browser.
 * Returns { codeVerifier } — the caller must store it to complete the flow.
 */
export async function startOAuthFlow(redirectUri) {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    client_id: APP_KEY,
    response_type: "code",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    token_access_type: "offline", // gives us a refresh token
  });

  const authUrl = `https://www.dropbox.com/oauth2/authorize?${params}`;

  // Open in system browser using Tauri opener plugin
  if (IS_TAURI) {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.openUrl(authUrl);
  } else {
    window.open(authUrl, "_blank");
  }

  return { codeVerifier };
}

/**
 * Complete the OAuth flow by exchanging the authorization code for tokens.
 * Tokens are stored both in memory and persisted via Rust backend.
 */
export async function completeOAuthFlow(code, codeVerifier, redirectUri) {
  if (IS_TAURI) {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke("exchange_dropbox_token", {
      code,
      codeVerifier,
      redirectUri,
      appKey: APP_KEY,
    });
    _accessToken = result.access_token;
    _refreshToken = result.refresh_token;
    return result;
  }
  throw new Error("OAuth exchange requires Tauri");
}

// ===== Dropbox API Operations =====

/**
 * Test connection — returns { ok: true, displayName } or { ok: false, error }.
 */
export async function testConnection() {
  try {
    const resp = await dbxFetch("https://api.dropboxapi.com/2/users/get_current_account", {
      method: "POST",
    });
    if (resp.ok) {
      const data = await resp.json();
      return { ok: true, displayName: data.name?.display_name || "unknown" };
    }
    return { ok: false, error: `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * List folder contents. Returns array of { name, pathDisplay, pathLower, isFolder, modified }.
 * Handles pagination via cursor.
 */
export async function listFolder(path) {
  const entries = [];
  let body = { path: path || "", recursive: false };
  let url = "https://api.dropboxapi.com/2/files/list_folder";

  while (true) {
    const resp = await dbxFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Dropbox list_folder failed: ${resp.status}`);
    const data = await resp.json();

    for (const entry of data.entries) {
      entries.push({
        name: entry.name,
        pathDisplay: entry.path_display,
        pathLower: entry.path_lower,
        isFolder: entry[".tag"] === "folder",
        modified: entry.server_modified || null,
      });
    }

    if (!data.has_more) break;
    url = "https://api.dropboxapi.com/2/files/list_folder/continue";
    body = { cursor: data.cursor };
  }

  return entries;
}

/**
 * Recursively list all files in a folder. Returns flat array of
 * { relativePath, name, isDirectory, content, dropboxPath, modified, tag }.
 * Includes .md files, .hushproject files, and directories.
 */
export async function listFolderRecursive(path) {
  const entries = [];
  const norm = path.replace(/\/+$/, "");
  let body = { path: norm || "", recursive: true };
  let url = "https://api.dropboxapi.com/2/files/list_folder";

  while (true) {
    const resp = await dbxFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Dropbox list_folder failed: ${resp.status}`);
    const data = await resp.json();

    for (const entry of data.entries) {
      const display = entry.path_display;
      const prefixLen = norm.length;
      const rel = display.length > prefixLen ? display.slice(prefixLen + 1) : "";
      if (!rel) continue;
      if (entry[".tag"] === "folder") {
        entries.push({ relativePath: rel, name: entry.name, isDirectory: true, content: "" });
      } else if (entry.name.endsWith(".md") || entry.name.endsWith(".hushproject")) {
        entries.push({
          relativePath: rel,
          name: entry.name.replace(/\.(md|hushproject)$/, ""),
          isDirectory: false,
          content: "",
          dropboxPath: display,
          modified: entry.server_modified,
          tag: entry.name.endsWith(".hushproject") ? "hushproject" : "md",
        });
      }
    }

    if (!data.has_more) break;
    url = "https://api.dropboxapi.com/2/files/list_folder/continue";
    body = { cursor: data.cursor };
  }

  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return entries;
}

/**
 * Download a file's content as text.
 */
export async function downloadFile(path) {
  const resp = await dbxFetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: { "Dropbox-API-Arg": JSON.stringify({ path }) },
  });
  if (!resp.ok) throw new Error(`Dropbox download failed: ${resp.status}`);
  return await resp.text();
}

/**
 * Get file metadata (server_modified, content_hash, etc.) without downloading.
 */
export async function getMetadata(path) {
  const resp = await dbxFetch("https://api.dropboxapi.com/2/files/get_metadata", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!resp.ok) return null;
  return await resp.json();
}

/**
 * Upload (or overwrite) a file with text content.
 */
export async function uploadFile(path, content) {
  const resp = await dbxFetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      "Dropbox-API-Arg": JSON.stringify({ path, mode: "overwrite", autorename: false, mute: true }),
      "Content-Type": "application/octet-stream",
    },
    body: content,
  });
  if (!resp.ok) throw new Error(`Dropbox upload failed: ${resp.status}`);
  return await resp.json();
}

/**
 * Create a folder.
 */
export async function createFolder(path) {
  const resp = await dbxFetch("https://api.dropboxapi.com/2/files/create_folder_v2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, autorename: false }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    if (err?.error?.[".tag"] !== "path" || err?.error?.path?.[".tag"] !== "conflict") {
      throw new Error(`Dropbox create_folder failed: ${resp.status}`);
    }
  }
}

/**
 * Delete a file or folder.
 */
export async function deleteEntry(path) {
  const resp = await dbxFetch("https://api.dropboxapi.com/2/files/delete_v2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!resp.ok) throw new Error(`Dropbox delete failed: ${resp.status}`);
}

/**
 * Move/rename a file or folder.
 */
export async function moveEntry(fromPath, toPath) {
  const resp = await dbxFetch("https://api.dropboxapi.com/2/files/move_v2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from_path: fromPath, to_path: toPath, autorename: false }),
  });
  if (!resp.ok) throw new Error(`Dropbox move failed: ${resp.status}`);
}

export function getAppKey() {
  return APP_KEY;
}
