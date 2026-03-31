/**
 * Sync polling — periodically checks for external changes to synced files
 * and shows conflict notification banners.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

let syncPollTimer = null;

export function startSyncPolling(state) {
  if (syncPollTimer) return;
  syncPollTimer = setInterval(() => pollSyncChanges(state), 30000);
  // Check shortly after start
  setTimeout(() => pollSyncChanges(state), 2000);
}

export function stopSyncPolling() {
  if (syncPollTimer) { clearInterval(syncPollTimer); syncPollTimer = null; }
}

async function pollSyncChanges(state) {
  try {
    const { checkSyncChanges } = await import("./sync-state.js");
    const changes = await checkSyncChanges();
    for (const change of changes) {
      showSyncConflictBanner(state, change);
    }
  } catch (e) {
    console.error("Sync poll error:", e);
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
    const { rejectExternalChange } = await import("./sync-state.js");
    const { invoke } = await import("@tauri-apps/api/core");
    const info = await invoke("get_sync_file_info", { internalId: change.internalId });
    if (info) {
      const syncFolder = (state.settings.syncFolders || []).find(f => f.id === info.syncFolderId);
      if (syncFolder) {
        await rejectExternalChange(state, change.internalId, syncFolder.path);
      }
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
