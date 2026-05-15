/**
 * Dropbox API client with OAuth PKCE authentication.
 * Uses Dropbox HTTP API directly via fetch (no SDK needed).
 * Token management: access tokens auto-refresh via refresh token.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

// Build-time config via Vite env variables
const APP_KEY = typeof import.meta !== "undefined"
  ? import.meta.env.VITE_DROPBOX_APP_KEY || ""
  : "";

const REDIRECT_URI = typeof import.meta !== "undefined"
  ? import.meta.env.VITE_DROPBOX_REDIRECT_URI || "hushwriter://auth/callback"
  : "hushwriter://auth/callback";

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
 * Load tokens from the Rust backend settings if not already in memory.
 * This ensures tokens survive across window contexts and re-renders.
 */
async function ensureTokens() {
  if (_accessToken) return;
  if (!IS_TAURI) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const settings = await invoke("get_settings");
    if (settings.dropboxAccessToken) {
      _accessToken = settings.dropboxAccessToken;
      _refreshToken = settings.dropboxRefreshToken || null;
    }
  } catch (_) {}
}

/**
 * Refresh the access token using the stored refresh token.
 * Deduplicates concurrent calls.
 */
async function refreshAccessToken() {
  if (_refreshing) return _refreshing;
  _refreshing = (async () => {
    try {
      // Make sure we have a refresh token loaded
      if (!_refreshToken) await ensureTokens();
      if (IS_TAURI && _refreshToken) {
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
 * Fetch wrapper that loads tokens on demand, auto-refreshes on 401.
 */
async function dbxFetch(url, options = {}) {
  await ensureTokens();
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
 * Returns { codeVerifier, redirectUri } — stored by caller to complete the flow.
 */
export async function startOAuthFlow() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    client_id: APP_KEY,
    response_type: "code",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
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

  return { codeVerifier, redirectUri: REDIRECT_URI };
}

export function getRedirectUri() {
  return REDIRECT_URI;
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

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "heif", "avif", "tif", "tiff"];

function classifyEntry(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".hushproject")) return { tag: "hushproject", stripExt: /\.hushproject$/ };
  if (lower.endsWith(".hushnote")) return { tag: "hushnote", stripExt: /\.hushnote$/ };
  if (lower.endsWith(".md")) return { tag: "md", stripExt: /\.md$/ };
  for (const ext of IMAGE_EXTENSIONS) {
    if (lower.endsWith(`.${ext}`)) return { tag: "image", stripExt: null };
  }
  return null;
}

/**
 * Recursively list all files in a folder. Returns flat array of
 * { relativePath, name, isDirectory, content, dropboxPath, modified, tag }.
 * Includes .md, .hushnote, .hushproject, image binaries, and directories.
 * For images the `name` keeps its extension since the filename *is* the
 * stable id used everywhere else in Hush.
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
        continue;
      }
      const cls = classifyEntry(entry.name);
      if (!cls) continue;
      const name = cls.stripExt ? entry.name.replace(cls.stripExt, "") : entry.name;
      entries.push({
        relativePath: rel,
        name,
        isDirectory: false,
        content: "",
        dropboxPath: display,
        modified: entry.server_modified,
        tag: cls.tag,
        // `id` + `rev` let `performInitialSync` register entries via
        // `register_synced_file_full` so the cursor seed's echo
        // suppression matches and we don't get a second tree node /
        // Tauri file for every just-downloaded item.
        id: entry.id || "",
        rev: entry.rev || "",
      });
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
 * Download a file's content as binary (ArrayBuffer).
 */
export async function downloadBinary(path) {
  const resp = await dbxFetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: { "Dropbox-API-Arg": JSON.stringify({ path }) },
  });
  if (!resp.ok) throw new Error(`Dropbox download failed: ${resp.status}`);
  return await resp.arrayBuffer();
}

/** Error subclass thrown when Dropbox rejects an upload because the
 *  `update` precondition doesn't match (409 with tag = "conflict").
 *  The op-log catches this specifically and runs the conflict path
 *  instead of leaving the op in the queue. */
export class DropboxRevConflictError extends Error {
  constructor(path, rev, body) {
    super(`Dropbox rev conflict at ${path} (rev=${rev || "<none>"})`);
    this.name = "DropboxRevConflictError";
    this.path = path;
    this.rev = rev || "";
    this.body = body;
  }
}

/** Build the upload `mode` arg. `rev` empty / nullish → "overwrite"
 *  (first upload after install, or echo backfill). `rev` set →
 *  `{ ".tag": "update", "update": rev }` so Dropbox rejects with 409
 *  when the remote has moved since we last read it. */
function buildUploadMode(rev) {
  if (!rev) return "overwrite";
  return { ".tag": "update", "update": rev };
}

/**
 * Upload (or overwrite) a file with binary content (Uint8Array/ArrayBuffer).
 * Pass `rev` to gate the upload on a known remote revision; on
 * mismatch the call throws `DropboxRevConflictError`.
 */
export async function uploadBinary(path, data, rev = "") {
  const resp = await dbxFetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      "Dropbox-API-Arg": JSON.stringify({ path, mode: buildUploadMode(rev), autorename: false, mute: true }),
      "Content-Type": "application/octet-stream",
    },
    body: data,
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    if (resp.status === 409 && isUpdateConflict(body)) {
      throw new DropboxRevConflictError(path, rev, body);
    }
    throw new Error(`Dropbox upload failed: ${resp.status}`);
  }
  return await resp.json();
}

/**
 * Authenticated POST to a Dropbox JSON endpoint. Returns the raw Response
 * so the caller can inspect non-OK status codes (e.g. cursor-reset 409).
 */
export async function authedJsonPost(url, body) {
  return dbxFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Issue a recursive list_folder rooted at `path`. Returns the full
 * Dropbox response object including `cursor` and `has_more` so the caller
 * can drive cursor-based delta consumption. Does NOT auto-paginate;
 * cursors must be persisted between calls.
 */
export async function listFolderRaw(path, { recursive = true, includeDeleted = false } = {}) {
  const norm = (path || "").replace(/\/+$/, "");
  const resp = await authedJsonPost("https://api.dropboxapi.com/2/files/list_folder", {
    path: norm || "",
    recursive,
    include_deleted: includeDeleted,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Dropbox list_folder ${resp.status}: ${txt}`);
  }
  return resp.json();
}

/**
 * Continue a cursor. The caller must check the response: a 409 with a
 * `reset` error means the cursor expired and the caller should reseed.
 */
export async function listFolderContinueRaw(cursor) {
  return authedJsonPost("https://api.dropboxapi.com/2/files/list_folder/continue", { cursor });
}

/**
 * Block server-side until Dropbox sees changes against `cursor`, or
 * `timeoutSecs` (30–480) elapses. Returns `{ changes, backoff? }`.
 *   * `changes: true` — there's work; caller runs the cursor pull.
 *   * `changes: false` + optional `backoff` (secs) — nothing happened
 *     within the timeout. Caller should wait `backoff` (default 0)
 *     and longpoll again.
 *
 * Longpoll uses the unauthenticated `notify.dropboxapi.com` host (no
 * Bearer header required — Dropbox identifies the user by the cursor
 * itself). The 502 retry pattern below handles the occasional gateway
 * blip without bubbling up to the caller.
 */
export async function listFolderLongpoll(cursor, timeoutSecs = 90) {
  const body = JSON.stringify({ cursor, timeout: Math.max(30, Math.min(480, timeoutSecs | 0)) });
  // Use a plain fetch — longpoll endpoint refuses auth headers.
  for (let attempt = 0; attempt < 3; attempt++) {
    let resp;
    try {
      resp = await fetch("https://notify.dropboxapi.com/2/files/list_folder/longpoll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch (e) {
      // Network blip — let the caller fall back to a short delay + retry.
      throw e;
    }
    if (resp.status === 502 || resp.status === 503) {
      // Transient gateway error. Brief backoff and retry.
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`Dropbox longpoll ${resp.status}: ${txt}`);
    }
    return resp.json();
  }
  // Exhausted retries — surface as a fallback-trigger error.
  throw new Error("Dropbox longpoll: repeated gateway errors");
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
 * Upload (or overwrite) a file with text content. Pass `rev` to gate
 * the upload on a known remote revision; on mismatch the call throws
 * `DropboxRevConflictError`.
 */
export async function uploadFile(path, content, rev = "") {
  const resp = await dbxFetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      "Dropbox-API-Arg": JSON.stringify({ path, mode: buildUploadMode(rev), autorename: false, mute: true }),
      "Content-Type": "application/octet-stream",
    },
    body: content,
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    if (resp.status === 409 && isUpdateConflict(body)) {
      throw new DropboxRevConflictError(path, rev, body);
    }
    throw new Error(`Dropbox upload failed: ${resp.status}`);
  }
  return await resp.json();
}

/** Recognise the specific 409 shape Dropbox returns when `mode: update`
 *  fails its precondition. The full body shape is
 *  `{ error_summary, error: { ".tag": "path", path: { ".tag": "conflict", conflict: { ".tag": "file" } } } }`
 *  but we accept any "conflict" tag inside the nested path error
 *  since the precise wrapper has shifted across Dropbox API versions. */
function isUpdateConflict(body) {
  const err = body?.error;
  if (!err) return false;
  const top = err[".tag"];
  if (top === "path") {
    const inner = err.path?.[".tag"];
    if (inner === "conflict") return true;
  }
  if (top === "conflict") return true;
  return false;
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
