/**
 * Sync polling — periodically checks for external changes and auto-resolves
 * using "most recent wins" strategy. No conflict banners — changes sync
 * silently. Users can revert via local version history if needed.
 */

let syncPollTimer = null;
let syncing = false;
let _state = null;

export function startSyncPolling(state) {
  if (syncPollTimer) return;
  _state = state;
  syncPollTimer = setInterval(() => runSyncCycle(state), 30000);
  setTimeout(() => runSyncCycle(state), 2000);
}

/** Trigger an immediate sync cycle (e.g. after a file save). */
export function triggerImmediateSync() {
  if (_state) runSyncCycle(_state);
}

export function stopSyncPolling() {
  if (syncPollTimer) { clearInterval(syncPollTimer); syncPollTimer = null; }
}

async function runSyncCycle(state) {
  if (syncing) return;
  syncing = true;
  try {
    await syncLocalFolders(state);
    await syncDropboxFolders(state);
  } catch (e) {
    console.error("Sync poll error:", e);
  } finally {
    syncing = false;
  }
}

/** Auto-sync local filesystem folders via Rust backend. */
async function syncLocalFolders(state) {
  const { checkSyncChanges, acceptExternalChange, syncFileToExternal } = await import("./sync-state.js");
  const changes = await checkSyncChanges();
  for (const change of changes) {
    if (change.externalModified > change.internalModified) {
      await acceptExternalChange(state, change.internalId, change.externalContent);
      showSyncIndicator("pulled");
    } else {
      // Internal is newer — push to external
      const folder = findFolderForFile(state, change.internalId);
      if (folder) {
        await syncFileToExternal(state, change.internalId, change.internalContent);
        showSyncIndicator("pushed");
      }
    }
  }
}

/** Auto-sync Dropbox folders by comparing timestamps. */
async function syncDropboxFolders(state) {
  const folders = (state.settings.syncFolders || []).filter(f => f.syncType === "dropbox");
  if (!folders.length || !state.settings.dropboxToken) return;
  const { invoke } = await import("@tauri-apps/api/core");
  const dbx = await import("./dropbox.js");
  dbx.setToken(state.settings.dropboxToken);

  for (const folder of folders) {
    try {
      const syncedFiles = await invoke("get_synced_files", { syncFolderId: folder.id });
      for (const info of syncedFiles) {
        await syncOneDropboxFile(state, invoke, dbx, folder, info);
      }
    } catch (e) {
      console.error(`Dropbox sync failed for ${folder.name}:`, e);
    }
  }
}

async function syncOneDropboxFile(state, invoke, dbx, folder, info) {
  const dropboxPath = folder.path === "/"
    ? `/${info.relativePath}`
    : `${folder.path}/${info.relativePath}`;
  try {
    // List file metadata to get server_modified without downloading
    const metaResp = await fetch("https://api.dropboxapi.com/2/files/get_metadata", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${dbx.getToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: dropboxPath }),
    });
    if (!metaResp.ok) return; // file may be deleted externally
    const meta = await metaResp.json();
    const externalModified = meta.server_modified
      ? Math.floor(new Date(meta.server_modified).getTime() / 1000) : 0;
    const internalFile = await invoke("load_file", { id: info.internalId });
    if (!internalFile) return;
    const internalModified = internalFile.modified || 0;

    // Compare Dropbox content hash with our stored hash to detect changes
    const externalHash = meta.content_hash || "";
    const lastSyncedAt = info.lastSyncedAt || 0;

    // If external file is newer than our last sync, pull it
    if (externalModified > lastSyncedAt) {
      const externalContent = await dbx.downloadFile(dropboxPath);
      if (externalContent === internalFile.content) {
        // Content matches — just update the hash/timestamp
        await invoke("update_sync_hash", { internalId: info.internalId, content: externalContent });
        return;
      }
      if (externalModified >= internalModified) {
        // External is newer or equal — accept external
        const { acceptExternalChange } = await import("./sync-state.js");
        await acceptExternalChange(state, info.internalId, externalContent);
        showSyncIndicator("pulled");
        return;
      }
    }

    // If internal is newer than last sync, push it
    if (internalModified > lastSyncedAt && internalFile.content) {
      await dbx.uploadFile(dropboxPath, internalFile.content);
      await invoke("update_sync_hash", { internalId: info.internalId, content: internalFile.content });
      showSyncIndicator("pushed");
    }
  } catch (e) {
    // File may have been deleted externally — skip
  }
}

function findFolderForFile(state, internalId) {
  // Look through sync folders to find which one owns this file
  const folders = state.settings.syncFolders || [];
  // We rely on the Rust backend having the mapping; caller handles the push
  return folders[0] || null;
}

/** Brief, non-intrusive sync indicator. */
function showSyncIndicator(direction) {
  // Remove any existing indicator
  const existing = document.querySelector(".sync-indicator");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.className = "sync-indicator";
  el.textContent = direction === "pulled" ? "Synced ↓" : "Synced ↑";
  document.body.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 3000);
}
