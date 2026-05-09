/**
 * Sync settings tab — split into three sub-tabs (Dropbox / Google /
 * Local). The outer `renderSyncTab` paints the sub-nav at the top and
 * delegates the body to the active sub-tab's renderer; bindings live in
 * `settings-sync-tab.js` (Dropbox + Local) and `settings-sync-tab.js`'s
 * `bindGoogleSubTab` (Google).
 *
 * Active sub-tab is module-local — the binding side calls
 * `setSyncSubTab(id)` followed by the parent `render()` to switch.
 */

import { escHtml, escAttr } from "./settings-tabs.js";

let _activeSubTab = "dropbox"; // "dropbox" | "google" | "local"

export function getSyncSubTab() { return _activeSubTab; }
export function setSyncSubTab(id) {
  if (id === "dropbox" || id === "google" || id === "local") _activeSubTab = id;
}

function subTabNav() {
  const tab = (id, label) => `<button class="sync-subtab${_activeSubTab === id ? " active" : ""}" data-sync-subtab="${id}">${label}</button>`;
  return `<div class="sync-subtab-nav">
    ${tab("dropbox", "Dropbox Sync")}
    ${tab("google", "Google Sync")}
    ${tab("local", "Local Sync")}
  </div>`;
}

export function renderSyncTab(settings) {
  let body = "";
  if (_activeSubTab === "dropbox") body = renderDropboxSubTab(settings);
  else if (_activeSubTab === "google") body = renderGoogleSubTab(settings);
  else body = renderLocalSyncSubTab(settings);
  return subTabNav() + `<div class="sync-subtab-body">${body}</div>`;
}

// ===== Dropbox =====

function renderDropboxSubTab(settings) {
  const isConnected = !!settings.dropboxAccessToken;
  const isEnabled = !!settings.dropboxEnabled;
  const syncPath = settings.dropboxSyncPath || "";
  const syncLog = settings.dropboxSyncLog || [];
  let html = "";
  if (!isConnected) {
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
  return html;
}

// ===== Google =====

function renderGoogleSubTab(settings) {
  const isConnected = !!settings.googleAccessToken || !!settings.googleRefreshToken;
  const email = settings.googleAccountEmail || "";
  const linkCount = Object.keys(settings.googleDocLinks || {}).length;
  const log = settings.googleSyncLog || [];
  let html = "";
  if (!isConnected) {
    html += `
      <div class="settings-section">
        <h2>Google Sync</h2>
        <p class="settings-help">
          Connect a Google account to link individual Hush documents to
          Google Docs. Unlike Dropbox sync, Google Sync is per-document
          and user-driven — each linked doc shows a bar above the editor
          with explicit Push and Pull buttons. There is no automatic
          syncing or conflict detection; both Hush and Google Docs keep
          version history if you change your mind.
        </p>
        <button id="google-connect" class="sync-action-btn">Connect Google account</button>
        <div id="google-auth-status" class="sync-status"></div>
      </div>
    `;
  } else {
    html += `
      <div class="settings-section">
        <h2>Google Sync</h2>
        <div class="sync-info-box">
          <div class="sync-info-row">
            <span class="sync-info-label">Status</span>
            <span class="sync-info-value" id="google-connection-status">Connected</span>
          </div>
          <div class="sync-info-row">
            <span class="sync-info-label">Account</span>
            <span class="sync-info-value">${email ? escHtml(email) : "(unknown)"}</span>
          </div>
          <div class="sync-info-row">
            <span class="sync-info-label">Linked documents</span>
            <span class="sync-info-value">${linkCount}</span>
          </div>
        </div>
        <div class="sync-btn-row">
          <button id="google-test-connection" class="sync-inline-btn">Test Connection</button>
        </div>
        <div id="google-auth-status" class="sync-status"></div>
      </div>
      <div class="settings-section">
        <h2>Activity Log</h2>
        <div class="sync-log-box" id="google-sync-log-box">
          ${log.length > 0
            ? log.slice(-20).reverse().map(entry => `<div class="sync-log-entry">${escHtml(entry)}</div>`).join("")
            : `<div class="sync-log-empty">No Google Docs activity yet.</div>`
          }
        </div>
        <div class="sync-btn-row">
          <button id="google-clear-log" class="sync-inline-btn">Clear log</button>
        </div>
      </div>
      <div class="settings-section">
        <h2>Disconnect</h2>
        <p class="settings-help">
          Revokes the Google access token, clears stored credentials, and
          forgets every per-document link. The Google Docs themselves are
          untouched.
        </p>
        <button id="google-disconnect" class="sync-danger-btn">Disconnect Google account</button>
      </div>
    `;
  }
  return html;
}

// ===== Local =====

function renderDeskDropdown(settings, mount) {
  const desks = settings.desks || [];
  if (desks.length < 2) return "";
  const current = mount.deskId || settings.activeDeskId || desks[0]?.id || "";
  const opts = desks.map(d => `<option value="${escAttr(d.id)}" ${d.id === current ? "selected" : ""}>${escHtml(d.name || "Untitled desk")}</option>`).join("");
  return `<select class="local-sync-desk-select" data-id="${escAttr(mount.id)}">${opts}</select>`;
}

function renderLocalSyncSubTab(settings) {
  const localSyncFolders = settings.localSyncFolders || [];
  return `
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
}
