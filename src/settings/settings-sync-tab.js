/**
 * Settings Sync tab bindings — extracted from settings-window.js.
 * Handles OAuth connect, folder browse, test connection, disconnect, unsync.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

/**
 * Indeterminate-or-determinate progress modal shown during the
 * clear-and-reseed flow. Returns `{ update(done, total, phase), close() }`.
 * Listens via `clear-reseed-progress` events so the caller doesn't have
 * to manage state directly.
 */
function showClearProgressModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "dbx-browser-backdrop";
  const modal = document.createElement("div");
  modal.className = "dbx-browser-modal";
  modal.style.maxWidth = "440px";
  modal.innerHTML = `
    <div class="dbx-browser-header">
      <span class="dbx-browser-path">Reseeding from Dropbox</span>
    </div>
    <div style="padding: 16px;">
      <div id="clear-progress-label" style="margin: 0 0 10px 0; font-size: 13px;">Listing Dropbox folder…</div>
      <div style="height: 8px; background: rgba(128,128,128,0.15); border-radius: 4px; overflow: hidden;">
        <div id="clear-progress-bar" style="height: 100%; width: 0%; background: var(--accent, #4a90e2); transition: width 0.2s ease;"></div>
      </div>
      <div id="clear-progress-count" style="margin-top: 8px; font-size: 12px; opacity: 0.7;">&nbsp;</div>
    </div>
  `;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const labelEl = modal.querySelector("#clear-progress-label");
  const barEl = modal.querySelector("#clear-progress-bar");
  const countEl = modal.querySelector("#clear-progress-count");

  return {
    update(done, total, phase) {
      if (phase === "begin") {
        labelEl.textContent = total > 0 ? `Pulling ${total} items from Dropbox…` : "Pulling items from Dropbox…";
      } else if (phase === "end") {
        labelEl.textContent = "Done. Reseed complete.";
        barEl.style.width = "100%";
      }
      if (total > 0) {
        const pct = Math.min(100, Math.round((done / total) * 100));
        barEl.style.width = pct + "%";
        countEl.textContent = `${done} / ${total}`;
      } else {
        countEl.textContent = done > 0 ? `${done} processed` : "";
      }
    },
    close() { backdrop.remove(); },
  };
}

/**
 * Hard-recovery confirmation: warn loudly, return true if the user
 * actually wants to wipe local state. Two-step: a "Clear" button plus
 * a typed confirmation so it can't be triggered with a stray click.
 */
function showClearLocalConfirmation() {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "dbx-browser-backdrop";
    const modal = document.createElement("div");
    modal.className = "dbx-browser-modal";
    modal.style.maxWidth = "440px";
    modal.innerHTML = `
      <div class="dbx-browser-header">
        <span class="dbx-browser-path">Clear local versions</span>
        <button class="dbx-browser-close">✕</button>
      </div>
      <div style="padding: 16px;">
        <p style="margin: 0 0 12px 0; line-height: 1.5;">
          This wipes every locally-stored doc, notebook, image, and sync
          record on this device. Hush will reseed from Dropbox on the
          next poll.
        </p>
        <p style="margin: 0 0 12px 0; line-height: 1.5; color: #ff4444;">
          Anything that exists only on this device and hasn't pushed
          yet will be lost.
        </p>
        <p style="margin: 0 0 8px 0; line-height: 1.5;">
          Type <code>clear</code> below to confirm.
        </p>
        <input id="clear-confirm-input" type="text" autocomplete="off" spellcheck="false"
               style="width: 100%; padding: 6px 8px; font-family: inherit; font-size: 13px;
                      border: 1px solid var(--panel-border, rgba(0,0,0,0.2));
                      background: transparent; color: var(--fg); border-radius: 4px;" />
        <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;">
          <button id="clear-cancel" style="padding: 8px 16px; cursor: pointer;">Cancel</button>
          <button id="clear-confirm" disabled
                  style="padding: 8px 16px; cursor: pointer; color: #ff4444; opacity: 0.4;">
            Clear local versions
          </button>
        </div>
      </div>
    `;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const input = modal.querySelector("#clear-confirm-input");
    const confirmBtn = modal.querySelector("#clear-confirm");
    input.addEventListener("input", () => {
      const ready = input.value.trim().toLowerCase() === "clear";
      confirmBtn.disabled = !ready;
      confirmBtn.style.opacity = ready ? "1" : "0.4";
    });
    setTimeout(() => input.focus(), 0);

    const close = (result) => { backdrop.remove(); resolve(result); };
    modal.querySelector(".dbx-browser-close").addEventListener("click", () => close(false));
    modal.querySelector("#clear-cancel").addEventListener("click", () => close(false));
    confirmBtn.addEventListener("click", () => { if (!confirmBtn.disabled) close(true); });
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(false); });
  });
}

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

  // Sub-tab nav switching (Dropbox / Google / Local).
  document.querySelectorAll(".sync-subtab").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.syncSubtab;
      const { setSyncSubTab } = await import("./settings-tabs-sync.js");
      setSyncSubTab(id);
      render();
    });
  });

  // ===== Google Sync sub-tab =====
  bindGoogleSubTab(saveSetting, settings, render);

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
  const syncClearLocalBtn = document.getElementById("sync-clear-local");
  if (syncClearLocalBtn) {
    syncClearLocalBtn.addEventListener("click", async () => {
      const ok = await showClearLocalConfirmation();
      if (!ok) return;
      const status = document.getElementById("sync-auth-status");
      if (status) { status.textContent = "Clearing local data..."; status.className = "sync-status"; }
      try {
        if (IS_TAURI) {
          const { emit, listen } = await import("@tauri-apps/api/event");
          const progress = showClearProgressModal();
          let unlisten = null;
          unlisten = await listen("clear-reseed-progress", (ev) => {
            const { done, total, phase } = ev?.payload || {};
            progress.update(done || 0, total || 0, phase);
            if (phase === "end") {
              setTimeout(() => { progress.close(); if (unlisten) unlisten(); }, 800);
            }
          });
          await emit("clear-local-data-request");
        }
        if (status) { status.textContent = "Done. Reseeding from Dropbox…"; status.className = "sync-status success"; }
      } catch (e) {
        if (status) { status.textContent = "Clear failed: " + e.message; status.className = "sync-status error"; }
      }
    });
  }

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
  // Per-mount desk picker (only visible with desks on). Tags the mount
  // so the file panel knows which desk's subtree to render it under.
  document.querySelectorAll(".local-sync-desk-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const id = sel.dataset.id;
      const deskId = sel.value;
      const list = (settings.localSyncFolders || []).map(f => f.id === id ? { ...f, deskId } : f);
      settings.localSyncFolders = list;
      await saveSetting("localSyncFolders", list);
      await emitLocalSyncUpdated(list);
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

  // Handle OAuth callback (deep link returns with auth code). The
  // sessionStorage `hush_oauth_provider` flag was set when the flow
  // started so we know which provider to dispatch to.
  if (IS_TAURI) {
    const verifier = sessionStorage.getItem("hush_oauth_verifier");
    if (verifier) {
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get("code");
      const provider = sessionStorage.getItem("hush_oauth_provider") || "dropbox";
      if (code) {
        sessionStorage.removeItem("hush_oauth_verifier");
        sessionStorage.removeItem("hush_oauth_provider");
        (async () => {
          try {
            const mod = provider === "google"
              ? await import("../google-docs/auth.js")
              : await import("../sync/dropbox.js");
            const redirectUri = sessionStorage.getItem("hush_oauth_redirect") || mod.getRedirectUri();
            sessionStorage.removeItem("hush_oauth_redirect");
            await mod.completeOAuthFlow(code, verifier, redirectUri);
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

// ===== Google sub-tab bindings =====

function bindGoogleSubTab(saveSetting, settings, render) {
  // ===== Credential form (Save / Cancel) =====
  // The form surfaces either when no client id is saved or when the
  // user clicked "Edit credentials". Save persists both fields (a blank
  // secret means "keep what's stored") then flips back to the normal
  // connect / connected view.
  const credsSaveBtn = document.getElementById("google-creds-save");
  if (credsSaveBtn) {
    credsSaveBtn.addEventListener("click", async () => {
      const idEl = document.getElementById("google-client-id");
      const secretEl = document.getElementById("google-client-secret");
      const id = (idEl?.value || "").trim();
      const status = document.getElementById("google-auth-status");
      if (!id) {
        if (status) { status.textContent = "Client ID is required."; status.className = "sync-status error"; }
        idEl?.focus();
        return;
      }
      const rawSecret = secretEl?.value || "";
      const isMask = rawSecret === "••••••••";
      const secret = isMask ? (settings.googleClientSecret || "") : rawSecret.trim();
      await saveSetting("googleClientId", id);
      await saveSetting("googleClientSecret", secret);
      // Tell auth.js's in-memory cache to re-read from settings.
      try {
        const auth = await import("../google-docs/auth.js");
        auth.setClientId(id);
      } catch (_) {}
      const { setEditingGoogleCreds } = await import("./settings-tabs-sync.js");
      setEditingGoogleCreds(false);
      render();
    });
  }
  const credsCancelBtn = document.getElementById("google-creds-cancel");
  if (credsCancelBtn) {
    credsCancelBtn.addEventListener("click", async () => {
      const { setEditingGoogleCreds } = await import("./settings-tabs-sync.js");
      setEditingGoogleCreds(false);
      render();
    });
  }
  const editCredsBtn = document.getElementById("google-edit-credentials");
  if (editCredsBtn) {
    editCredsBtn.addEventListener("click", async () => {
      const { setEditingGoogleCreds } = await import("./settings-tabs-sync.js");
      setEditingGoogleCreds(true);
      render();
    });
  }

  // Connect: starts the OAuth PKCE flow, listens for the callback event,
  // refreshes settings on completion. Mirrors `sync-connect-dropbox`.
  const connectBtn = document.getElementById("google-connect");
  if (connectBtn) {
    connectBtn.addEventListener("click", async () => {
      const status = document.getElementById("google-auth-status");
      if (status) { status.textContent = "Opening Google sign-in…"; status.className = "sync-status"; }
      try {
        const auth = await import("../google-docs/auth.js");
        const { codeVerifier, redirectUri } = await auth.startOAuthFlow();
        sessionStorage.setItem("hush_oauth_verifier", codeVerifier);
        sessionStorage.setItem("hush_oauth_redirect", redirectUri);
        sessionStorage.setItem("hush_oauth_provider", "google");
        if (status) { status.textContent = "Waiting for Google authorization…"; }
        if (IS_TAURI) {
          const { listen } = await import("@tauri-apps/api/event");
          const unlisten = await listen("oauth-callback", async (event) => {
            const { code, provider } = event.payload || {};
            if (!code || provider !== "google") return;
            unlisten();
            if (status) { status.textContent = "Completing authorization…"; }
            try {
              const verifier = sessionStorage.getItem("hush_oauth_verifier");
              const ru = sessionStorage.getItem("hush_oauth_redirect") || auth.getRedirectUri();
              sessionStorage.removeItem("hush_oauth_verifier");
              sessionStorage.removeItem("hush_oauth_redirect");
              sessionStorage.removeItem("hush_oauth_provider");
              await auth.completeOAuthFlow(code, verifier, ru);
              const { invoke } = await import("@tauri-apps/api/core");
              const newSettings = await invoke("get_settings");
              Object.assign(settings, newSettings);
              if (status) { status.textContent = "Connected!"; status.className = "sync-status success"; }
              setTimeout(() => render(), 800);
            } catch (err) {
              console.error("Google OAuth completion failed:", err);
              if (status) { status.textContent = "Authorization failed: " + err.message; status.className = "sync-status error"; }
            }
          });
          setTimeout(() => unlisten(), 300000);
        }
      } catch (e) {
        console.error("Google OAuth start failed:", e);
        if (status) { status.textContent = "Failed to start: " + e.message; status.className = "sync-status error"; }
      }
    });
  }

  const testBtn = document.getElementById("google-test-connection");
  if (testBtn) {
    testBtn.addEventListener("click", async () => {
      const status = document.getElementById("google-auth-status");
      const statusVal = document.getElementById("google-connection-status");
      if (status) { status.textContent = "Testing…"; status.className = "sync-status"; }
      try {
        const auth = await import("../google-docs/auth.js");
        const result = await auth.testConnection();
        if (result.ok) {
          if (status) { status.textContent = `Connected as ${result.email || "Google account"}`; status.className = "sync-status success"; }
          if (statusVal) statusVal.textContent = "Connected";
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

  const disconnectBtn = document.getElementById("google-disconnect");
  if (disconnectBtn) {
    disconnectBtn.addEventListener("click", async () => {
      const ok = window.confirm(
        "Disconnect the Google account?\n\n" +
        "This revokes the access token, clears stored credentials, and " +
        "forgets every per-document link. The Google Docs themselves are untouched."
      );
      if (!ok) return;
      const auth = await import("../google-docs/auth.js");
      await auth.disconnect();
      const { invoke } = await import("@tauri-apps/api/core");
      const newSettings = await invoke("get_settings");
      Object.assign(settings, newSettings);
      render();
    });
  }

  const clearLogBtn = document.getElementById("google-clear-log");
  if (clearLogBtn) {
    clearLogBtn.addEventListener("click", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("clear_google_sync_log");
      const newSettings = await invoke("get_settings");
      Object.assign(settings, newSettings);
      render();
    });
  }
}
