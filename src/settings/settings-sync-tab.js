/**
 * Settings Sync tab bindings — extracted from settings-window.js.
 * Handles OAuth connect, folder browse, test connection, disconnect, unsync.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
const SYNC_FOLDER_ID = "__dropbox_sync__";

/**
 * Snapshot the local sync state into a plain-text report. Temporary
 * debug surface — bug-hunt for the iPad-first-sync duplication where we
 * suspect either (a) downloads are not registering with full
 * `remote_id`/`rev` (so the cursor seed re-imports them) or (b)
 * `.hush/desks.json` lands mid-seed and reshapes the tree under a
 * different parent path. Both cases show up here as either a
 * `remote_id` group with >1 row, a `relative_path` group with >1 row,
 * or two tree nodes pointing at the same `fileId`.
 */
async function gatherSyncDiagnostics() {
  if (!IS_TAURI) return "Diagnostics only available in the Tauri app.";
  const { invoke } = await import("@tauri-apps/api/core");
  const lines = [];

  const settings = await invoke("get_settings").catch(() => ({}));
  lines.push("=== HUSH SYNC DIAGNOSTICS ===");
  lines.push(`Time: ${new Date().toISOString()}`);
  lines.push(`Sync folder: ${settings?.dropboxSyncPath || "(none)"}`);
  lines.push(`Sync enabled: ${!!settings?.dropboxEnabled}`);

  // Cursor state
  let cursor = null;
  try { cursor = await invoke("get_dropbox_cursor", { syncFolderId: SYNC_FOLDER_ID }); } catch (_) {}
  if (cursor) {
    const c = cursor.cursor || "";
    lines.push(`Cursor present: ${c.length} chars (head=${c.slice(0, 24)}…)`);
    lines.push(`Cursor root: ${cursor.rootPath || "(empty)"}`);
  } else {
    lines.push("Cursor present: NO (next poll will seed)");
  }

  // Synced files
  let files = [];
  try { files = await invoke("get_synced_files", { syncFolderId: SYNC_FOLDER_ID }) || []; } catch (_) {}
  lines.push("");
  lines.push(`=== synced_files (${files.length} rows) ===`);
  lines.push("internal_id  remote_id              rev          relative_path");
  for (const f of files) {
    const iid = (f.internalId || "").slice(0, 12);
    const rid = (f.remoteId || "").slice(0, 22) || "(empty)";
    const rev = (f.lastKnownRev || "").slice(0, 12) || "(empty)";
    lines.push(`${iid.padEnd(12)} ${rid.padEnd(22)} ${rev.padEnd(12)} ${f.relativePath || ""}`);
  }

  // Duplicates by remote_id
  const byRemote = new Map();
  for (const f of files) {
    const k = f.remoteId || "(empty)";
    if (!byRemote.has(k)) byRemote.set(k, []);
    byRemote.get(k).push(f);
  }
  const dupRemote = [...byRemote.entries()].filter(([k, arr]) => k !== "(empty)" && arr.length > 1);
  const emptyRemoteCount = (byRemote.get("(empty)") || []).length;
  lines.push("");
  lines.push(`=== Duplicates by remote_id (${dupRemote.length} groups; ${emptyRemoteCount} rows have empty remote_id) ===`);
  if (dupRemote.length === 0) lines.push("(none)");
  for (const [rid, arr] of dupRemote) {
    lines.push(`  ${rid} → ${arr.length} rows:`);
    for (const f of arr) lines.push(`    internal=${(f.internalId || "").slice(0, 12)} path=${f.relativePath || ""}`);
  }

  // Duplicates by relative_path
  const byPath = new Map();
  for (const f of files) {
    const k = (f.relativePath || "").toLowerCase();
    if (!byPath.has(k)) byPath.set(k, []);
    byPath.get(k).push(f);
  }
  const dupPath = [...byPath.entries()].filter(([_, arr]) => arr.length > 1);
  lines.push("");
  lines.push(`=== Duplicates by relative_path (${dupPath.length} groups) ===`);
  if (dupPath.length === 0) lines.push("(none)");
  for (const [p, arr] of dupPath) {
    lines.push(`  ${p} → ${arr.length} rows:`);
    for (const f of arr) lines.push(`    internal=${(f.internalId || "").slice(0, 12)} remote=${(f.remoteId || "").slice(0, 22)}`);
  }

  // File tree
  let tree = [];
  try { tree = await invoke("get_file_tree") || []; } catch (_) {}
  lines.push("");
  lines.push("=== Tree (files / folders / desks; first 200 lines) ===");
  const treeLines = [];
  function walk(nodes, depth) {
    for (const n of nodes || []) {
      const indent = "  ".repeat(depth);
      const tag = n.type || "?";
      const fid = n.fileId ? ` fileId=${n.fileId.slice(0, 12)}` : "";
      const id = ` id=${(n.id || "").slice(0, 12)}`;
      treeLines.push(`${indent}- [${tag}] ${n.name || "(unnamed)"}${id}${fid}`);
      if (Array.isArray(n.children)) walk(n.children, depth + 1);
    }
  }
  walk(tree, 0);
  for (const ln of treeLines.slice(0, 200)) lines.push(ln);
  if (treeLines.length > 200) lines.push(`(... ${treeLines.length - 200} more lines truncated)`);

  // Tree fileId duplicates
  const fileIdNodes = new Map();
  function collectFileIds(nodes, path) {
    for (const n of nodes || []) {
      const here = path ? `${path}/${n.name}` : n.name;
      if (n.fileId) {
        if (!fileIdNodes.has(n.fileId)) fileIdNodes.set(n.fileId, []);
        fileIdNodes.get(n.fileId).push({ path: here, type: n.type, nodeId: n.id });
      }
      if (Array.isArray(n.children)) collectFileIds(n.children, here);
    }
  }
  collectFileIds(tree, "");
  const dupFileId = [...fileIdNodes.entries()].filter(([_, arr]) => arr.length > 1);
  lines.push("");
  lines.push(`=== Duplicates by tree fileId (${dupFileId.length} groups) ===`);
  if (dupFileId.length === 0) lines.push("(none)");
  for (const [fid, arr] of dupFileId) {
    lines.push(`  fileId=${fid.slice(0, 12)} → ${arr.length} nodes:`);
    for (const x of arr) lines.push(`    ${x.type} @ ${x.path} (node=${x.nodeId.slice(0, 12)})`);
  }

  // Tree nodes whose fileId has no synced_files row (orphans)
  const syncedFileIds = new Set(files.map(f => f.internalId));
  const orphanNodes = [...fileIdNodes.entries()].filter(([fid, _]) => !syncedFileIds.has(fid));
  lines.push("");
  lines.push(`=== Tree nodes with no synced_files row (${orphanNodes.length}) ===`);
  if (orphanNodes.length === 0) lines.push("(none)");
  for (const [fid, arr] of orphanNodes) {
    for (const x of arr) lines.push(`  ${x.type} @ ${x.path} (fileId=${fid.slice(0, 12)})`);
  }

  // Pending ops queue
  let ops = [];
  try { ops = await invoke("peek_pending_ops", { limit: 50 }) || []; } catch (_) {}
  lines.push("");
  lines.push(`=== pending_ops (${ops.length} rows; up to 50 shown) ===`);
  for (const op of ops) {
    const internal = op.internalId || "";
    const newPath = op.newPath || "";
    const attempts = op.attempts ?? 0;
    const lastErr = op.lastError || "";
    lines.push(`  #${op.id} ${op.kind.padEnd(14)} internal=${internal.slice(0, 12).padEnd(12)} ${op.path}${newPath ? ` → ${newPath}` : ""}${attempts ? ` attempts=${attempts}` : ""}${lastErr ? ` err=${lastErr}` : ""}`);
  }

  // Recent sync log
  const syncLog = settings?.dropboxSyncLog || [];
  lines.push("");
  lines.push(`=== Recent sync log (last 20 of ${syncLog.length}) ===`);
  for (const entry of syncLog.slice(-20)) lines.push(`  ${entry}`);

  return lines.join("\n");
}

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

  // Sync diagnostics (debug). Temporary UI for chasing duplication bugs.
  const syncDiagRefresh = document.getElementById("sync-diag-refresh");
  const syncDiagCopy = document.getElementById("sync-diag-copy");
  const syncDiagOutput = document.getElementById("sync-diag-output");
  const syncDiagStatus = document.getElementById("sync-diag-status");
  if (syncDiagRefresh && syncDiagOutput) {
    syncDiagRefresh.addEventListener("click", async () => {
      if (syncDiagStatus) { syncDiagStatus.textContent = "Gathering…"; syncDiagStatus.className = "sync-status"; }
      try {
        const text = await gatherSyncDiagnostics();
        syncDiagOutput.value = text;
        if (syncDiagStatus) { syncDiagStatus.textContent = ""; syncDiagStatus.className = "sync-status"; }
      } catch (e) {
        syncDiagOutput.value = "Diagnostics failed: " + (e?.message || e);
        if (syncDiagStatus) { syncDiagStatus.textContent = "Failed."; syncDiagStatus.className = "sync-status error"; }
      }
    });
  }
  if (syncDiagCopy && syncDiagOutput) {
    syncDiagCopy.addEventListener("click", async () => {
      const text = syncDiagOutput.value || "";
      if (!text) {
        if (syncDiagStatus) { syncDiagStatus.textContent = "Nothing to copy — tap Refresh first."; syncDiagStatus.className = "sync-status"; }
        return;
      }
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          // iOS Safari fallback: select + execCommand
          syncDiagOutput.removeAttribute("readonly");
          syncDiagOutput.focus();
          syncDiagOutput.select();
          document.execCommand("copy");
          syncDiagOutput.setAttribute("readonly", "true");
        }
        if (syncDiagStatus) { syncDiagStatus.textContent = "Copied."; syncDiagStatus.className = "sync-status success"; }
      } catch (e) {
        if (syncDiagStatus) { syncDiagStatus.textContent = "Copy failed: " + (e?.message || e); syncDiagStatus.className = "sync-status error"; }
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
