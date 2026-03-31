/**
 * Dropbox API client for iPad sync.
 * Uses Dropbox HTTP API directly via fetch (no SDK needed).
 * Requires a Personal Access Token stored in settings.
 */

let _token = null;

export function setToken(token) {
  _token = token;
}

export function getToken() {
  return _token;
}

function authHeaders() {
  if (!_token) throw new Error("Dropbox token not set");
  return { Authorization: `Bearer ${_token}` };
}

/**
 * Test connection — returns { ok: true, displayName } or { ok: false, error }.
 */
export async function testConnection() {
  try {
    const resp = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
      method: "POST",
      headers: authHeaders(),
    });
    if (resp.ok) {
      const data = await resp.json();
      return { ok: true, displayName: data.name?.display_name || "unknown" };
    }
    return { ok: false, error: "Invalid token" };
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
    const resp = await fetch(url, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
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
 * Recursively list all .md files in a folder. Returns flat array of
 * { relativePath, name, isDirectory, content (empty for dirs) }.
 */
export async function listFolderRecursive(path) {
  const entries = [];
  let body = { path: path || "", recursive: true };
  let url = "https://api.dropboxapi.com/2/files/list_folder";

  while (true) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Dropbox list_folder failed: ${resp.status}`);
    const data = await resp.json();

    for (const entry of data.entries) {
      const rel = entry.path_display.slice(path.length + 1);
      if (entry[".tag"] === "folder") {
        entries.push({ relativePath: rel, name: entry.name, isDirectory: true, content: "" });
      } else if (entry.name.endsWith(".md")) {
        entries.push({
          relativePath: rel, name: entry.name.replace(/\.md$/, ""),
          isDirectory: false, content: "", // content fetched separately
          dropboxPath: entry.path_display,
          modified: entry.server_modified,
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
  const resp = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Dropbox-API-Arg": JSON.stringify({ path }),
    },
  });
  if (!resp.ok) throw new Error(`Dropbox download failed: ${resp.status}`);
  return await resp.text();
}

/**
 * Upload (or overwrite) a file with text content.
 */
export async function uploadFile(path, content) {
  const resp = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      ...authHeaders(),
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
  const resp = await fetch("https://api.dropboxapi.com/2/files/create_folder_v2", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ path, autorename: false }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    // Ignore "path/conflict/folder" — folder already exists
    if (err?.error?.[".tag"] !== "path" || err?.error?.path?.[".tag"] !== "conflict") {
      throw new Error(`Dropbox create_folder failed: ${resp.status}`);
    }
  }
}

/**
 * Delete a file or folder.
 */
export async function deleteEntry(path) {
  const resp = await fetch("https://api.dropboxapi.com/2/files/delete_v2", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!resp.ok) throw new Error(`Dropbox delete failed: ${resp.status}`);
}

/**
 * Move/rename a file or folder.
 */
export async function moveEntry(fromPath, toPath) {
  const resp = await fetch("https://api.dropboxapi.com/2/files/move_v2", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ from_path: fromPath, to_path: toPath, autorename: false }),
  });
  if (!resp.ok) throw new Error(`Dropbox move failed: ${resp.status}`);
}
