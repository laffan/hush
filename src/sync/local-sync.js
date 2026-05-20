/**
 * Local Sync — desktop-only direct-filesystem folder mounts.
 *
 * Thin JS wrapper over the Rust `local_sync_*` commands plus helpers for
 * rendering a Local Sync section under the files panel and opening +
 * saving the currently-edited Local Sync file.
 *
 * The currently-open file is tracked on `AppState` via two extra fields:
 *   - `state.currentLocalSync = { folderId, relPath }`
 *   - `state.runtime.localSyncWriteFlag` — guards against watcher-echo reloads
 *     when we just wrote the file ourselves.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export async function listLocalSyncFolders() {
  if (!IS_TAURI) return [];
  try { return await invoke("local_sync_list"); }
  catch (e) { console.error("local_sync_list failed:", e); return []; }
}

export async function addLocalSyncFolder(deskId = null) {
  if (!IS_TAURI) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false });
    if (!picked) return null;
    return await invoke("local_sync_add", { path: picked, deskId });
  } catch (e) {
    console.error("local_sync_add failed:", e);
    return null;
  }
}

export async function removeLocalSyncFolder(id) {
  if (!IS_TAURI) return;
  try { await invoke("local_sync_remove", { id }); }
  catch (e) { console.error("local_sync_remove failed:", e); }
}

export async function readDir(id, relPath = "") {
  if (!IS_TAURI) return [];
  try { return await invoke("local_sync_read_dir", { id, relPath }); }
  catch (e) { console.error("local_sync_read_dir failed:", e); return []; }
}

export async function readFile(id, relPath) {
  if (!IS_TAURI) return "";
  return invoke("local_sync_read_file", { id, relPath });
}

export async function writeFile(id, relPath, content) {
  if (!IS_TAURI) return;
  return invoke("local_sync_write_file", { id, relPath, content });
}

export async function readFileBytes(id, relPath) {
  if (!IS_TAURI) return null;
  return invoke("local_sync_read_file_bytes", { id, relPath });
}

/** Write a binary blob into a Local Sync folder with collision auto-suffix.
 *  Returns the actual relative path written so the caller can build a
 *  matching markdown ref. */
export async function writeFileBytes(id, relPath, bytes) {
  if (!IS_TAURI) return null;
  return invoke("local_sync_write_file_bytes", { id, relPath, bytes });
}

/** MIME type for an image filename's extension. */
function mimeForFilename(name) {
  const m = (name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return "application/octet-stream";
  switch (m[1]) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "bmp": return "image/bmp";
    case "heic": return "image/heic";
    case "heif": return "image/heif";
    case "avif": return "image/avif";
    case "tif": case "tiff": return "image/tiff";
    default: return "application/octet-stream";
  }
}

function bytesToBase64(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Read a sibling image and return a data URL. `baseDir` is the dirname
 *  of the .md that owns the ref ("" for files at the mount root). */
export async function readSiblingImageDataUrl(folderId, baseDir, filename) {
  if (!IS_TAURI || !folderId || !filename) return null;
  const relPath = baseDir ? `${baseDir}/${filename}` : filename;
  try {
    const bytes = await readFileBytes(folderId, relPath);
    if (!bytes) return null;
    const mime = mimeForFilename(filename);
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
  } catch (e) {
    return null;
  }
}

/** Open a Local Sync file into the main editor. */
export async function openLocalSyncFile(state, folderId, relPath) {
  if (state.dirty) await state.saveCurrentFile();
  if (state.currentNotebookFileId) {
    state.emit("notebook-unmount");
    state.currentNotebookFileId = null;
  }
  state.currentFileId = null;
  state.currentProjectId = null;
  state.projectDocIds = [];
  state.currentLocalSync = { folderId, relPath };
  try {
    const content = await readFile(folderId, relPath);
    if (state.editor) state.editor.setContent(content);
  } catch (e) {
    console.error("Failed to load local-sync file:", e);
    if (state.editor) state.editor.setContent("");
  }
  state.emit("file-opened");
}

/** Save the currently-open Local Sync doc (called from the autosave hook). */
export async function saveCurrentLocalSync(state) {
  if (!state.currentLocalSync || !state.editor) return;
  const { folderId, relPath } = state.currentLocalSync;
  const content = state.editor.getContent();
  state.runtime.localSyncWriteFlag = Date.now();
  state.dirty = false;
  try { await writeFile(folderId, relPath, content); }
  catch (e) { console.error("Local Sync save failed:", e); }
}

/** Listen for watcher events. Reloads the open file on external change,
 *  and refreshes the sidebar on any structural change. */
export async function startLocalSyncWatcher(state, onChanged) {
  if (!IS_TAURI) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen("local-sync-changed", (event) => {
    const { id, paths } = event.payload || {};
    // Ignore events that echo our own write (within 500ms of last write)
    if (state.runtime.localSyncWriteFlag && Date.now() - state.runtime.localSyncWriteFlag < 500) {
      return;
    }
    // If the currently-open local-sync file changed on disk, reload it.
    if (state.currentLocalSync && state.currentLocalSync.folderId === id) {
      const editedPath = state.currentLocalSync.relPath;
      // Match by suffix-with-separator, not bare endsWith — `a/foo.md`
      // shouldn't match `b/a/foo.md`'s ancestor walk.
      const matches = Array.isArray(paths) && paths.some(p => {
        if (p === editedPath) return true;
        return p.endsWith("/" + editedPath) || p.endsWith("\\" + editedPath);
      });
      if (matches) {
        readFile(id, editedPath).then((content) => {
          if (!state.editor || !state.currentLocalSync || state.currentLocalSync.relPath !== editedPath) return;
          // Skip identical-content events. notify can emit duplicate events
          // (e.g. metadata-only changes, atomic-write races) and reapplying
          // identical content would jump the cursor without any user-visible
          // benefit.
          if (state.editor.getContent() === content) return;
          // Local-sync paths don't have a Hush fileId; use a synthetic
          // lock key. _isPullLockedForCurrent matches it against
          // state.currentLocalSync so saves are correctly blocked.
          state.acquirePullLock(`localsync:${id}:${editedPath}`);
          try { state.editor.setContent(content); state.dirty = false; }
          finally { state.releasePullLock(); }
        }).catch(() => {});
      }
    }
    onChanged && onChanged(id);
  });
}
