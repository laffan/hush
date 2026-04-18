/**
 * Settings Sync tab bindings — extracted from settings-window.js.
 * Handles OAuth connect, folder browse, test connection, disconnect, unsync.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

/**
 * Show a confirmation dialog for unsyncing, with options to keep or remove Dropbox files.
 * Returns "keep", "remove", or null (cancelled).
 */
function showUnsyncConfirmation() {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "dbx-browser-backdrop";
    const modal = document.createElement("div");
    modal.className = "dbx-browser-modal";
    modal.style.maxWidth = "400px";
    modal.innerHTML = `
      <div class="dbx-browser-header">
        <span class="dbx-browser-path">Stop Syncing</span>
        <button class="dbx-browser-close">\u2715</button>
      </div>
      <div style="padding: 16px;">
        <p style="margin: 0 0 16px 0; line-height: 1.5;">
          Would you like to keep or remove the files that were synced to Dropbox?
        </p>
        <p style="margin: 0 0 16px 0; opacity: 0.7; font-size: 0.9em;">
          Your local files in Hush will not be affected either way.
        </p>
        <div style="display: flex; gap: 8px; justify-content: flex-end;">
          <button id="unsync-cancel" style="padding: 8px 16px; cursor: pointer;">Cancel</button>
          <button id="unsync-remove" style="padding: 8px 16px; cursor: pointer; color: #ff4444;">Remove from Dropbox</button>
          <button id="unsync-keep" style="padding: 8px 16px; cursor: pointer;">Keep on Dropbox</button>
        </div>
      </div>
    `;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    function close(result) { backdrop.remove(); resolve(result); }

    modal.querySelector(".dbx-browser-close").addEventListener("click", () => close(null));
    modal.querySelector("#unsync-cancel").addEventListener("click", () => close(null));
    modal.querySelector("#unsync-keep").addEventListener("click", () => close("keep"));
    modal.querySelector("#unsync-remove").addEventListener("click", () => close("remove"));
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(null); });
  });
}

/**
 * Bind all Sync tab UI controls.
 * @param {Function} saveSetting - Async function to persist a setting key/value.
 * @param {Object} settings - Current settings object (mutated in place).
 * @param {Function} render - Re-render the settings UI.
 */
export function bindSyncTab(saveSetting, settings, render) {

  // OAuth connect
  const syncConnectBtn = document.getElementById("sync-connect-dropbox");
  if (syncConnectBtn) {
    syncConnectBtn.addEventListener("click", async () => {
      const status = document.getElementById("sync-auth-status");
      if (status) { status.textContent = "Opening Dropbox login..."; status.className = "sync-status"; }
      try {
        const dbx = await import("../sync/dropbox.js");
        const { codeVerifier, redirectUri } = await dbx.startOAuthFlow();
        sessionStorage.setItem("hush_oauth_verifier", codeVerifier);
        sessionStorage.setItem("hush_oauth_redirect", redirectUri);
        if (status) { status.textContent = "Waiting for Dropbox authorization..."; status.className = "sync-status"; }

        if (IS_TAURI) {
          const { listen } = await import("@tauri-apps/api/event");
          const unlisten = await listen("oauth-callback", async (event) => {
            const { code } = event.payload || {};
            if (!code) return;
            unlisten();
            if (status) { status.textContent = "Completing authorization..."; status.className = "sync-status"; }
            try {
              const storedVerifier = sessionStorage.getItem("hush_oauth_verifier");
              const storedRedirect = sessionStorage.getItem("hush_oauth_redirect") || dbx.getRedirectUri();
              sessionStorage.removeItem("hush_oauth_verifier");
              sessionStorage.removeItem("hush_oauth_redirect");
              await dbx.completeOAuthFlow(code, storedVerifier, storedRedirect);
              const { invoke } = await import("@tauri-apps/api/core");
              const newSettings = await invoke("get_settings");
              Object.assign(settings, newSettings);
              if (status) { status.textContent = "Connected!"; status.className = "sync-status success"; }
              setTimeout(() => render(), 1000);
            } catch (err) {
              console.error("OAuth completion failed:", err);
              if (status) { status.textContent = "Authorization failed: " + err.message; status.className = "sync-status error"; }
            }
          });
          setTimeout(() => unlisten(), 300000);
        }
      } catch (e) {
        console.error("OAuth start failed:", e);
        if (status) { status.textContent = "Failed to start authorization: " + e.message; status.className = "sync-status error"; }
      }
    });
  }

  // Browse folder (initial setup or change folder)
  async function handleFolderBrowse() {
    try {
      const { openDropboxBrowser } = await import("../sync/dropbox-browser.js");
      const result = await openDropboxBrowser();
      if (!result) return;

      const status = document.getElementById("sync-auth-status");
      const path = result.path;

      const previewEl = document.getElementById("sync-preview");
      if (previewEl) {
        previewEl.style.display = "";
        previewEl.innerHTML = `<h3>Preview</h3><p>Scanning...</p>`;
        try {
          const { generateSyncPreview } = await import("../sync/sync-state.js");
          const { invoke } = await import("@tauri-apps/api/core");
          const fileTree = await invoke("get_file_tree");
          const preview = await generateSyncPreview({ fileTree, settings }, path);
          let html = `<h3>Preview</h3>`;
          if (preview.toUpload.length > 0)
            html += `<p><strong>${preview.toUpload.length}</strong> file${preview.toUpload.length !== 1 ? "s" : ""} will be uploaded</p>`;
          if (preview.toDownload.length > 0)
            html += `<p><strong>${preview.toDownload.length}</strong> file${preview.toDownload.length !== 1 ? "s" : ""} will be downloaded</p>`;
          if (preview.unchanged > 0)
            html += `<p><strong>${preview.unchanged}</strong> file${preview.unchanged !== 1 ? "s" : ""} already in sync</p>`;
          if (!preview.toUpload.length && !preview.toDownload.length && !preview.unchanged)
            html += `<p>Your library will be uploaded to this folder.</p>`;
          previewEl.innerHTML = html;
        } catch (e) {
          previewEl.innerHTML = `<h3>Preview</h3><p>Could not generate preview.</p>`;
        }
      }

      await saveSetting("dropboxSyncPath", path);
      await saveSetting("dropboxEnabled", true);
      addSyncLogEntry(`Sync started to ${path}`);

      if (status) { status.textContent = "Starting sync..."; status.className = "sync-status"; }
      if (IS_TAURI) {
        const { emit } = await import("@tauri-apps/api/event");
        await emit("dropbox-sync-start", { path });
      }
      if (status) { status.textContent = ""; }
      setTimeout(() => render(), 1500);
    } catch (e) {
      console.error("Dropbox browse failed:", e);
      const status = document.getElementById("sync-auth-status");
      if (status) { status.textContent = "Browse failed: " + e.message; status.className = "sync-status error"; }
    }
  }

  const syncBrowseBtn = document.getElementById("sync-browse-folder");
  if (syncBrowseBtn) syncBrowseBtn.addEventListener("click", handleFolderBrowse);

  // Change folder (already syncing)
  const syncChangeFolderBtn = document.getElementById("sync-change-folder");
  if (syncChangeFolderBtn) {
    syncChangeFolderBtn.addEventListener("click", async () => {
      if (IS_TAURI) {
        const sp = await import("../sync/sync-polling.js");
        sp.stopSyncPolling();
      }
      await handleFolderBrowse();
    });
  }

  // Test connection
  const syncTestConnectionBtn = document.getElementById("sync-test-connection");
  if (syncTestConnectionBtn) {
    syncTestConnectionBtn.addEventListener("click", async () => {
      const status = document.getElementById("sync-auth-status");
      const statusVal = document.getElementById("sync-connection-status");
      if (status) { status.textContent = "Testing..."; status.className = "sync-status"; }
      try {
        const dbx = await import("../sync/dropbox.js");
        const result = await dbx.testConnection();
        if (result.ok) {
          if (status) { status.textContent = `Connected as ${result.displayName}`; status.className = "sync-status success"; }
          if (statusVal) statusVal.textContent = "Active";
        } else {
          if (status) { status.textContent = "Connection failed: " + result.error; status.className = "sync-status error"; }
          if (statusVal) statusVal.textContent = "Disconnected";
        }
      } catch (e) {
        if (status) { status.textContent = "Connection failed."; status.className = "sync-status error"; }
        if (statusVal) statusVal.textContent = "Error";
      }
    });
  }

  // Disconnect (before sync started)
  const syncDisconnectBtn = document.getElementById("sync-disconnect");
  if (syncDisconnectBtn) {
    syncDisconnectBtn.addEventListener("click", async () => {
      saveSetting("dropboxAccessToken", null);
      saveSetting("dropboxRefreshToken", null);
      saveSetting("dropboxSyncPath", null);
      saveSetting("dropboxEnabled", false);
      saveSetting("dropboxSyncLog", []);
      const dbx = await import("../sync/dropbox.js");
      dbx.clearTokens();
      render();
    });
  }

  // Stop syncing (unsync)
  const syncUnsyncBtn = document.getElementById("sync-unsync");
  if (syncUnsyncBtn) {
    syncUnsyncBtn.addEventListener("click", async () => {
      const choice = await showUnsyncConfirmation();
      if (choice === null) return;

      const status = document.getElementById("sync-auth-status");
      if (status) { status.textContent = "Disconnecting..."; status.className = "sync-status"; }

      try {
        if (IS_TAURI) {
          const { emit } = await import("@tauri-apps/api/event");
          await emit("dropbox-sync-stop", { removeFromDropbox: choice === "remove" });
        }
        saveSetting("dropboxAccessToken", null);
        saveSetting("dropboxRefreshToken", null);
        saveSetting("dropboxSyncPath", null);
        saveSetting("dropboxEnabled", false);
        saveSetting("dropboxSyncLog", []);
        const dbx = await import("../sync/dropbox.js");
        dbx.clearTokens();
        render();
      } catch (e) {
        if (status) { status.textContent = "Disconnect failed: " + e.message; status.className = "sync-status error"; }
      }
    });
  }

  // Local Sync: add/remove folders. The Rust side picks the path via a
  // native folder dialog and registers the watcher; on success the
  // settings window re-renders with the updated list.
  async function emitLocalSyncUpdated(folders) {
    if (!IS_TAURI) return;
    try {
      const { emit } = await import("@tauri-apps/api/event");
      // Include the current list in the payload so the main window
      // doesn't have to re-fetch settings to pick up the change —
      // avoids any window-ordering races between save_settings and the
      // event listener.
      await emit("local-sync-folders-updated", { folders: folders || [] });
    } catch (e) {
      console.error("Failed to emit local-sync-folders-updated:", e);
    }
  }
  const localSyncAddBtn = document.getElementById("local-sync-add");
  if (localSyncAddBtn) {
    localSyncAddBtn.addEventListener("click", async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const { open } = await import("@tauri-apps/plugin-dialog");
        const picked = await open({ directory: true, multiple: false });
        if (!picked) return;
        const folder = await invoke("local_sync_add", { path: picked });
        settings.localSyncFolders = (settings.localSyncFolders || []).concat(folder);
        await saveSetting("localSyncFolders", settings.localSyncFolders);
        await emitLocalSyncUpdated(settings.localSyncFolders);
        render();
      } catch (e) {
        console.error("Failed to add Local Sync folder:", e);
      }
    });
  }
  document.querySelectorAll(".local-sync-remove-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("local_sync_remove", { id });
        settings.localSyncFolders = (settings.localSyncFolders || []).filter(f => f.id !== id);
        await saveSetting("localSyncFolders", settings.localSyncFolders);
        await emitLocalSyncUpdated(settings.localSyncFolders);
        render();
      } catch (e) {
        console.error("Failed to remove Local Sync folder:", e);
      }
    });
  });

  function addSyncLogEntry(message) {
    const now = new Date();
    const ts = now.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const entry = `${ts}  ${message}`;
    const log = settings.dropboxSyncLog || [];
    log.push(entry);
    if (log.length > 50) log.splice(0, log.length - 50);
    saveSetting("dropboxSyncLog", log);
  }

  // Handle OAuth callback (deep link returns with auth code)
  if (IS_TAURI) {
    const verifier = sessionStorage.getItem("hush_oauth_verifier");
    if (verifier) {
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get("code");
      if (code) {
        sessionStorage.removeItem("hush_oauth_verifier");
        (async () => {
          try {
            const dbx = await import("../sync/dropbox.js");
            const redirectUri = sessionStorage.getItem("hush_oauth_redirect") || dbx.getRedirectUri();
            sessionStorage.removeItem("hush_oauth_redirect");
            await dbx.completeOAuthFlow(code, verifier, redirectUri);
            const { invoke } = await import("@tauri-apps/api/core");
            const newSettings = await invoke("get_settings");
            Object.assign(settings, newSettings);
            render();
          } catch (e) {
            console.error("OAuth completion failed:", e);
          }
        })();
      }
    }
  }
}
