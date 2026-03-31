/**
 * Sync polling — periodically checks for external changes to synced files
 * and shows conflict notification banners. Handles both local and Dropbox sync.
 */

let syncPollTimer = null;

export function startSyncPolling(state) {
  if (syncPollTimer) return;
  syncPollTimer = setInterval(() => pollSyncChanges(state), 30000);
  setTimeout(() => pollSyncChanges(state), 2000);
}

export function stopSyncPolling() {
  if (syncPollTimer) { clearInterval(syncPollTimer); syncPollTimer = null; }
}

async function pollSyncChanges(state) {
  try {
    // Check local sync folders via Rust backend
    const { checkSyncChanges } = await import("./sync-state.js");
    const localChanges = await checkSyncChanges();
    for (const change of localChanges) {
      showSyncConflictBanner(state, change);
    }
    // Check Dropbox sync folders via API
    const dropboxFolders = (state.settings.syncFolders || []).filter(f => f.syncType === "dropbox");
    if (dropboxFolders.length > 0 && state.settings.dropboxToken) {
      await pollDropboxChanges(state, dropboxFolders);
    }
  } catch (e) {
    console.error("Sync poll error:", e);
  }
}

async function pollDropboxChanges(state, folders) {
  const { invoke } = await import("@tauri-apps/api/core");
  const dbx = await import("./dropbox.js");
  dbx.setToken(state.settings.dropboxToken);

  for (const folder of folders) {
    try {
      const syncedFiles = await invoke("get_synced_files", { syncFolderId: folder.id });
      for (const info of syncedFiles) {
        const dropboxPath = folder.path === "/"
          ? `/${info.relativePath}`
          : `${folder.path}/${info.relativePath}`;
        try {
          const externalContent = await dbx.downloadFile(dropboxPath);
          // Compute hash to compare — use simple string comparison since we
          // can't easily call Rust's SHA256 from JS. Instead, compare against
          // the stored hash by asking the backend.
          const internalFile = await invoke("load_file", { id: info.internalId });
          if (externalContent !== internalFile.content) {
            showSyncConflictBanner(state, {
              internalId: info.internalId,
              relativePath: info.relativePath,
              externalContent,
              internalContent: internalFile.content,
              syncType: "dropbox",
              syncFolderId: folder.id,
            });
          }
        } catch (e) {
          // File may have been deleted externally — skip
        }
      }
    } catch (e) {
      console.error(`Dropbox poll failed for ${folder.name}:`, e);
    }
  }
}

function showSyncConflictBanner(state, change) {
  if (document.querySelector(`[data-sync-conflict-id="${change.internalId}"]`)) return;

  const banner = document.createElement("div");
  banner.className = "sync-conflict-banner";
  banner.dataset.syncConflictId = change.internalId;
  banner.innerHTML = `
    <div class="sync-conflict-title">External Change Detected</div>
    <div class="sync-conflict-path">${escapeHtml(change.relativePath)}</div>
    <div class="sync-conflict-btns">
      <button class="sync-btn-reject">Keep Local</button>
      <button class="sync-btn-accept">Accept External</button>
      <button class="sync-btn-dismiss">Dismiss</button>
    </div>
  `;
  document.body.appendChild(banner);

  banner.querySelector(".sync-btn-accept").addEventListener("click", async () => {
    const { acceptExternalChange } = await import("./sync-state.js");
    await acceptExternalChange(state, change.internalId, change.externalContent);
    banner.remove();
  });

  banner.querySelector(".sync-btn-reject").addEventListener("click", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const info = await invoke("get_sync_file_info", { internalId: change.internalId });
    if (!info) { banner.remove(); return; }
    const syncFolder = (state.settings.syncFolders || []).find(f => f.id === info.syncFolderId);
    if (!syncFolder) { banner.remove(); return; }

    if (syncFolder.syncType === "dropbox") {
      // Upload local content to Dropbox
      const dbx = await import("./dropbox.js");
      dbx.setToken(state.settings.dropboxToken);
      const internalFile = await invoke("load_file", { id: change.internalId });
      const dropboxPath = syncFolder.path === "/"
        ? `/${info.relativePath}`
        : `${syncFolder.path}/${info.relativePath}`;
      await dbx.uploadFile(dropboxPath, internalFile.content);
      await invoke("update_sync_hash", { internalId: change.internalId, content: internalFile.content });
    } else {
      const { rejectExternalChange } = await import("./sync-state.js");
      await rejectExternalChange(state, change.internalId, syncFolder.path);
    }
    banner.remove();
  });

  banner.querySelector(".sync-btn-dismiss").addEventListener("click", () => {
    banner.remove();
  });

  setTimeout(() => { if (banner.parentNode) banner.remove(); }, 30000);
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
