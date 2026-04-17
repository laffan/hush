/**
 * Local Sync — desktop-only direct-filesystem folder mounts.
 *
 * Thin JS wrapper over the Rust `local_sync_*` commands plus helpers for
 * rendering a Local Sync section under the files panel and opening +
 * saving the currently-edited Local Sync file.
 *
 * The currently-open file is tracked on `AppState` via two extra fields:
 *   - `state.currentLocalSync = { folderId, relPath }`
 *   - `state._localSyncWriteFlag` — guards against watcher-echo reloads
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

export async function addLocalSyncFolder() {
  if (!IS_TAURI) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false });
    if (!picked) return null;
    return await invoke("local_sync_add", { path: picked });
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
  state._localSyncWriteFlag = Date.now();
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
    if (state._localSyncWriteFlag && Date.now() - state._localSyncWriteFlag < 500) {
      return;
    }
    // If the currently-open local-sync file changed on disk, reload it
    if (state.currentLocalSync && state.currentLocalSync.folderId === id) {
      const editedPath = state.currentLocalSync.relPath;
      const matches = Array.isArray(paths) && paths.some(p => p.endsWith(editedPath));
      if (matches) {
        readFile(id, editedPath).then((content) => {
          if (state.editor && state.currentLocalSync && state.currentLocalSync.relPath === editedPath) {
            state._syncPulling = true;
            state.editor.setContent(content);
            state._syncPulling = false;
          }
        }).catch(() => {});
      }
    }
    onChanged && onChanged(id);
  });
}
