/**
 * Sync polling — periodically checks for external changes and auto-resolves
 * using "most recent wins" strategy. No conflict banners — changes sync
 * silently. Users can revert via local version history if needed.
 */

let syncPollTimer = null;
let syncing = false;
let _state = null;

/** Dropbox connection health state. */
let _dropboxConnected = true;
let _healthCheckCounter = 0;
const HEALTH_CHECK_INTERVAL = 6; // check every 6 poll cycles (60 seconds)

/** Folder diff counter — full scan every 3 poll cycles (30 seconds). */
let _diffCounter = 0;
const DIFF_INTERVAL = 3;
/** Set by triggerFullReconcile — forces a folder diff on the next cycle. */
let _forceDiffNextCycle = false;

export function isDropboxConnected() {
  return _dropboxConnected;
}

export function startSyncPolling(state) {
  if (syncPollTimer) return;
  _state = state;
  // Force the very first cycle to run the full folder diff so that any
  // external changes made while the app was closed are reconciled
  // immediately, rather than waiting ~22s for the counter to tick over.
  _forceDiffNextCycle = true;
  syncPollTimer = setInterval(() => runSyncCycle(state), 10000);
  setTimeout(() => runSyncCycle(state), 500);
}

/** Trigger an immediate sync cycle (e.g. after a file save). */
export function triggerImmediateSync() {
  if (_state) runSyncCycle(_state);
}

/**
 * Trigger an immediate full reconciliation (content check + folder diff).
 * Use this on window focus or after the user returns from another app —
 * files may have been moved, renamed, added, or deleted externally.
 */
export function triggerFullReconcile() {
  if (!_state) return;
  _forceDiffNextCycle = true;
  runSyncCycle(_state);
}

export function stopSyncPolling() {
  if (syncPollTimer) { clearInterval(syncPollTimer); syncPollTimer = null; }
}

async function runSyncCycle(state) {
  if (syncing) return;
  syncing = true;
  // Capture and clear the force-diff flag once per cycle so both local and
  // Dropbox passes observe the same value.
  const forceDiff = _forceDiffNextCycle;
  _forceDiffNextCycle = false;
  try {
    await syncLocalFolders(state, forceDiff);
    await syncDropboxFolders(state, forceDiff);
    // Periodic Dropbox connection health check
    _healthCheckCounter++;
    if (_healthCheckCounter >= HEALTH_CHECK_INTERVAL) {
      _healthCheckCounter = 0;
      await checkDropboxHealth(state);
    }
  } catch (e) {
    console.error("Sync poll error:", e);
  } finally {
    syncing = false;
  }
}

/** Auto-sync local filesystem folders via Rust backend. */
async function syncLocalFolders(state, forceDiff) {
  const { checkSyncChanges, acceptExternalChange, syncFileToExternal,
          diffSyncFolder } = await import("./sync-state.js");

  // Check content changes on registered files
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

  // Periodically diff folder contents to detect new/deleted/moved external
  // files and stale folders. Normally runs every DIFF_INTERVAL cycles, but
  // can be forced for startup or window-focus reconciliation.
  _diffCounter++;
  if (forceDiff || _diffCounter >= DIFF_INTERVAL) {
    _diffCounter = 0;
    const localFolders = (state.settings.syncFolders || []).filter(f => f.syncType === "local");
    for (const folder of localFolders) {
      const changed = await diffSyncFolder(state, folder);
      if (changed) showSyncIndicator("pulled");
    }
  }
}

/** Auto-sync Dropbox folders by comparing timestamps. */
async function syncDropboxFolders(state, forceDiff) {
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
      // If we got here without error, connection is good
      updateDropboxStatus(state, true);
    } catch (e) {
      console.error(`Dropbox sync failed for ${folder.name}:`, e);
      updateDropboxStatus(state, false);
    }
  }

  // Periodically diff Dropbox folder contents (uses HEALTH_CHECK_INTERVAL
  // since listing is expensive — same cadence as the health check, ~60s).
  // Also run immediately if a full reconcile was requested (startup, focus).
  if (_healthCheckCounter === 0 || forceDiff) {
    const { diffSyncFolder } = await import("./sync-state.js");
    for (const folder of folders) {
      try {
        const changed = await diffSyncFolder(state, folder);
        if (changed) showSyncIndicator("pulled");
      } catch (e) {
        console.error(`Dropbox diff failed for ${folder.name}:`, e);
      }
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

/** Periodic Dropbox connection health check via lightweight API call. */
async function checkDropboxHealth(state) {
  const folders = (state.settings.syncFolders || []).filter(f => f.syncType === "dropbox");
  if (!folders.length || !state.settings.dropboxToken) return;
  try {
    const dbx = await import("./dropbox.js");
    dbx.setToken(state.settings.dropboxToken);
    const result = await dbx.testConnection();
    updateDropboxStatus(state, result.ok);
  } catch (_) {
    updateDropboxStatus(state, false);
  }
}

/** Update Dropbox connection status and emit event if changed. */
function updateDropboxStatus(state, connected) {
  if (_dropboxConnected !== connected) {
    _dropboxConnected = connected;
    state.emit("dropbox-status-changed", { connected });
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
