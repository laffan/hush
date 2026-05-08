/**
 * Sync settings tab — Dropbox connect / pick folder / actively-syncing
 * states, plus the desktop-only Local Sync section. Extracted from
 * settings-tabs.js.
 */

import { escHtml, escAttr } from "./settings-tabs.js";

/** Per-mount desk picker. Hidden while there's only one desk — picking
 *  among a single option is just visual noise. */
function renderDeskDropdown(settings, mount) {
  const desks = settings.desks || [];
  if (desks.length < 2) return "";
  const current = mount.deskId || settings.activeDeskId || desks[0]?.id || "";
  const opts = desks.map(d => `<option value="${escAttr(d.id)}" ${d.id === current ? "selected" : ""}>${escHtml(d.name || "Untitled desk")}</option>`).join("");
  return `<select class="local-sync-desk-select" data-id="${escAttr(mount.id)}">${opts}</select>`;
}


export function renderSyncTab(settings) {
  const isConnected = !!settings.dropboxAccessToken;
  const isEnabled = !!settings.dropboxEnabled;
  const syncPath = settings.dropboxSyncPath || "";
  const syncLog = settings.dropboxSyncLog || [];
  const localSyncFolders = settings.localSyncFolders || [];

  let html = "";

  if (!isConnected) {
    // ---- Not connected ----
    html += `
      <div class="settings-section">
        <h2>Dropbox Sync</h2>
        <p class="settings-help">
          Connect your Dropbox account to sync all your documents, projects, and folders
          across devices. Hush mirrors your entire library to a Dropbox folder as a backup.
        </p>
        <button id="sync-connect-dropbox" class="sync-action-btn">Connect to Dropbox</button>
        <div id="sync-auth-status" class="sync-status"></div>
      </div>
    `;
  } else if (!isEnabled || !syncPath) {
    // ---- Connected, choosing folder ----
    html += `
      <div class="settings-section">
        <h2>Dropbox Sync</h2>
        <p class="settings-help">
          Connected to Dropbox. Select a folder to sync your library to.
          All documents, projects, and folders will be mirrored automatically.
        </p>
        <div class="settings-row">
          <label>Sync folder</label>
          <div class="sync-path-row">
            <span id="sync-selected-path" class="sync-path-display">${syncPath ? escHtml(syncPath) : "None"}</span>
            <button id="sync-browse-folder" class="sync-inline-btn">Browse</button>
          </div>
        </div>
        <div id="sync-preview" class="sync-preview-box" style="display:none;"></div>
        <div id="sync-auth-status" class="sync-status"></div>
      </div>
      <div class="settings-section">
        <button id="sync-disconnect" class="sync-danger-btn">Disconnect Dropbox</button>
      </div>
    `;
  } else {
    // ---- Actively syncing ----
    html += `
      <div class="settings-section">
        <h2>Dropbox Sync</h2>
        <div class="sync-info-box">
          <div class="sync-info-row">
            <span class="sync-info-label">Status</span>
            <span class="sync-info-value" id="sync-connection-status">Active</span>
          </div>
          <div class="sync-info-row">
            <span class="sync-info-label">Folder</span>
            <span class="sync-info-value">${escHtml(syncPath)}</span>
          </div>
        </div>
        <div class="sync-btn-row">
          <button id="sync-test-connection" class="sync-inline-btn">Test Connection</button>
          <button id="sync-change-folder" class="sync-inline-btn">Change Folder</button>
        </div>
        <div id="sync-auth-status" class="sync-status"></div>
      </div>
      <div class="settings-section">
        <h2>Sync Log</h2>
        <div class="sync-log-box" id="sync-log-box">
          ${syncLog.length > 0
            ? syncLog.slice(-20).reverse().map(entry => `<div class="sync-log-entry">${escHtml(entry)}</div>`).join("")
            : `<div class="sync-log-empty">No sync activity yet.</div>`
          }
        </div>
      </div>
      <div class="settings-section">
        <h2>Disconnect</h2>
        <p class="settings-help">Stop syncing and return to local-only mode.</p>
        <button id="sync-unsync" class="sync-danger-btn">Stop Syncing</button>
      </div>
      <div class="settings-section">
        <h2>Clear local versions</h2>
        <p class="settings-help">
          Wipe every locally-stored doc, notebook, image, and sync record
          on this device. The next sync poll reseeds from Dropbox. Use
          this to recover when the local file tree has diverged from
          what's on Dropbox. Files that exist only on this device and
          haven't been pushed will be lost.
        </p>
        <button id="sync-clear-local" class="sync-danger-btn">Clear local versions</button>
      </div>
    `;
  }

  // ── Diagnostics section (always shown so it's reachable from iPad) ──
  html += `
    <div class="settings-section">
      <h2>Sync Diagnostics</h2>
      <p class="settings-help">
        Captures a snapshot of the local sync state — file tree, sync map,
        pending op queue, in-memory event trace, and (if connected) a live
        Dropbox listing cross-checked against the local DB. Use this to
        debug situations like desks turning into folders or files
        landing under the wrong path.
      </p>
      <div class="sync-btn-row">
        <button id="sync-diag-run" class="sync-inline-btn">Run diagnostics</button>
        <button id="sync-diag-copy" class="sync-inline-btn" style="display:none;">Copy</button>
        <button id="sync-diag-clear-trace" class="sync-inline-btn">Clear trace</button>
      </div>
      <div id="sync-diag-status" class="sync-status" style="margin-top:6px;"></div>
      <textarea id="sync-diag-output"
                readonly
                spellcheck="false"
                style="display:none; width:100%; min-height:280px; max-height:60vh;
                       margin-top:10px; padding:8px; box-sizing:border-box;
                       font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                       font-size:11px; line-height:1.4; color: var(--fg);
                       background: rgba(0,0,0,0.04); border:1px solid var(--panel-border, rgba(0,0,0,0.2));
                       border-radius:4px; resize: vertical; white-space: pre;"></textarea>
    </div>
  `;

  // ── Local Sync section (desktop only) ──
  html += `
    <div class="settings-section local-sync-section">
      <h2>Local Sync</h2>
      <p class="settings-help">
        Mount a folder on this machine directly in Hush. Local Sync folders
        are outside the version control system — edits write straight to
        disk and external changes appear immediately. Unsyncing a folder
        only removes it from Hush; nothing on disk is changed.
      </p>
      <div class="local-sync-list" id="local-sync-list">
        ${localSyncFolders.length === 0
          ? `<div class="local-sync-empty">No folders yet.</div>`
          : localSyncFolders.map(f => `
              <div class="local-sync-item" data-id="${escAttr(f.id)}">
                <div class="local-sync-item-info">
                  <div class="local-sync-item-name">${escHtml(f.name)}</div>
                  <div class="local-sync-item-path">${escHtml(f.path)}</div>
                </div>
                ${renderDeskDropdown(settings, f)}
                <button class="local-sync-remove-btn" data-id="${escAttr(f.id)}">Remove</button>
              </div>
            `).join("")}
      </div>
      <button id="local-sync-add" class="sync-action-btn">Add folder</button>
    </div>
  `;

  return html;
}
