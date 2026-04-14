/**
 * Sync polling — periodically checks for Dropbox changes and auto-resolves
 * using "most recent wins" strategy. Changes sync silently.
 * Users can revert via local version history if needed.
 */

let syncPollTimer = null;
let syncing = false;
let _state = null;

/** Dropbox connection health state. */
let _dropboxConnected = true;
let _healthCheckCounter = 0;
const HEALTH_CHECK_INTERVAL = 6; // check every 6 poll cycles (60 seconds)

/** Folder diff counter — full scan every 6 poll cycles (60 seconds). */
let _diffCounter = 0;
const DIFF_INTERVAL = 6;
/** Set by triggerFullReconcile — forces a folder diff on the next cycle. */
let _forceDiffNextCycle = false;

export function isDropboxConnected() {
  return _dropboxConnected;
}

export function startSyncPolling(state) {
  if (syncPollTimer) return;
  _state = state;
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
  if (!state.settings.dropboxEnabled || !state.settings.dropboxSyncPath) return;
  syncing = true;
  const forceDiff = _forceDiffNextCycle;
  _forceDiffNextCycle = false;
  try {
    await syncDropboxContent(state);

    // Periodic folder diff (new/deleted files on Dropbox)
    _diffCounter++;
    if (forceDiff || _diffCounter >= DIFF_INTERVAL) {
      _diffCounter = 0;
      await syncDropboxDiff(state);
    }

    // Periodic health check
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

/** Sync content changes (push/pull) for all registered files. */
async function syncDropboxContent(state) {
  const { checkDropboxChanges, acceptExternalChange, syncFileToExternal } =
    await import("./sync-state.js");

  try {
    const changes = await checkDropboxChanges(state);
    for (const change of changes) {
      if (change.type === "pull") {
        await acceptExternalChange(state, change.internalId, change.content);
        showSyncIndicator("pulled");
      } else if (change.type === "push") {
        await syncFileToExternal(state, change.internalId, change.content);
        showSyncIndicator("pushed");
      }
    }
    updateDropboxStatus(state, true);
  } catch (e) {
    console.error("Dropbox content sync failed:", e);
    updateDropboxStatus(state, false);
  }
}

/** Diff Dropbox folder contents to detect new/deleted external files. */
async function syncDropboxDiff(state) {
  const { diffDropboxSync } = await import("./sync-state.js");
  const { findNodeByFileId, removeNode } = await import("../state/tree-helpers.js");

  try {
    const diff = await diffDropboxSync(state);
    if (!diff) return;

    let changed = false;
    const { invoke } = await import("@tauri-apps/api/core");

    // Handle new files from Dropbox
    for (const entry of (diff.newFiles || [])) {
      if (entry.isDirectory) continue;
      const file = await invoke("create_file");
      await invoke("save_file", { id: file.id, content: entry.content || "" });
      await invoke("register_synced_file", {
        internalId: file.id, syncFolderId: "__dropbox_sync__",
        relativePath: entry.relativePath, content: entry.content || "",
      });

      // Insert tree node
      const parts = entry.relativePath.split("/");
      const fileName = parts.pop().replace(/\.md$/, "");
      let current = state.fileTree;
      for (const dirName of parts) {
        if (!dirName) continue;
        let folder = current.find(n => n.type === "folder" && n.name === dirName);
        if (!folder) {
          folder = { id: crypto.randomUUID(), type: "folder", name: dirName, children: [], flagged: false };
          current.push(folder);
        }
        if (!Array.isArray(folder.children)) folder.children = [];
        current = folder.children;
      }
      current.push({
        id: crypto.randomUUID(), type: "document",
        name: entry.name || fileName, fileId: file.id,
        children: [], flagged: false,
      });
      changed = true;
    }

    // Handle deleted files on Dropbox
    for (const internalId of (diff.deletedFileIds || [])) {
      const treeNode = findNodeByFileId(state.fileTree, internalId);
      if (treeNode) {
        removeNode(state.fileTree, treeNode.id);
        changed = true;
      }
      try {
        await invoke("delete_sync_file", { folderPath: "__dropbox__", internalId });
      } catch (_) {}
    }

    if (changed) {
      await state.saveFileTree();
      state.files = await invoke("list_files");
      state.emit("files-changed");
      showSyncIndicator("pulled");
    }
  } catch (e) {
    console.error("Dropbox diff failed:", e);
  }
}

/** Periodic Dropbox connection health check. */
async function checkDropboxHealth(state) {
  if (!state.settings.dropboxEnabled) return;
  try {
    const dbx = await import("./dropbox.js");
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

/** Brief, non-intrusive sync indicator. */
function showSyncIndicator(direction) {
  const existing = document.querySelector(".sync-indicator");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.className = "sync-indicator";
  el.textContent = direction === "pulled" ? "Synced \u2193" : "Synced \u2191";
  document.body.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 3000);
}
