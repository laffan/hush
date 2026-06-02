/**
 * Sync settings tab — split into two sub-tabs (Dropbox / Google). Local
 * Sync used to live here as a third sub-tab; it now mounts directly from
 * the sidebar's Add (+) menu (entry: "Local Folder"), so this file no
 * longer renders it. The outer `renderSyncTab` paints the sub-nav at
 * the top and delegates the body to the active sub-tab's renderer;
 * bindings live in `settings-sync-tab.js` (Dropbox) and the same file's
 * `bindGoogleSubTab` (Google).
 *
 * Active sub-tab is module-local — the binding side calls
 * `setSyncSubTab(id)` followed by the parent `render()` to switch.
 */

import { escHtml, escAttr } from "./settings-tabs.js";
import { SYNC_LOG_ERROR_PREFIX } from "../sync/sync-feedback.js";

/** Render a single sync log row. Entries tagged with the error prefix
 *  (see {@link SYNC_LOG_ERROR_PREFIX}) paint red and strip the prefix
 *  from the visible body so the row reads as a normal timestamped
 *  message — just in danger colour. */
function renderSyncLogEntry(entry) {
  const raw = String(entry);
  const errIdx = raw.indexOf(SYNC_LOG_ERROR_PREFIX);
  if (errIdx >= 0) {
    const before = raw.slice(0, errIdx);
    const after = raw.slice(errIdx + SYNC_LOG_ERROR_PREFIX.length);
    return `<div class="sync-log-entry sync-log-entry-error" style="color:#d33;">${escHtml(before + after)}</div>`;
  }
  return `<div class="sync-log-entry">${escHtml(raw)}</div>`;
}

let _activeSubTab = "dropbox"; // "dropbox" | "google"

export function getSyncSubTab() { return _activeSubTab; }
export function setSyncSubTab(id) {
  if (id === "dropbox" || id === "google") _activeSubTab = id;
}

function subTabNav() {
  const tab = (id, label) => `<button class="sync-subtab${_activeSubTab === id ? " active" : ""}" data-sync-subtab="${id}">${label}</button>`;
  return `<div class="sync-subtab-nav">
    ${tab("dropbox", "Dropbox Sync")}
    ${tab("google", "Google Sync")}
  </div>`;
}

export function renderSyncTab(settings) {
  let body = "";
  if (_activeSubTab === "dropbox") body = renderDropboxSubTab(settings);
  else body = renderGoogleSubTab(settings);
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
            ? syncLog.slice(-20).reverse().map(renderSyncLogEntry).join("")
            : `<div class="sync-log-empty">No sync activity yet.</div>`
          }
        </div>
      </div>
      <div class="settings-section">
        <h2>Pending sync queue</h2>
        <p class="settings-help">
          Operations queued for Dropbox. Rows with attempts &gt; 0 or an
          error are waiting on a retry — usually because the network was
          down. Click <strong>Retry now</strong> to kick the drain.
        </p>
        <div class="sync-log-box" id="sync-pending-box">
          <div class="sync-log-empty">Loading…</div>
        </div>
        <div class="sync-btn-row" style="margin-top:8px;">
          <button id="sync-retry-pending" class="sync-inline-btn">Retry now</button>
        </div>
      </div>
      <div class="settings-section">
        <h2>Force sync</h2>
        <p class="settings-help">
          Run the standard reconcile + cursor pull right now instead of
          waiting for the next 10-second poll. A progress bar tracks the
          check so you can see when it finishes.
        </p>
        <button id="sync-force" class="sync-action-btn">Force sync now</button>
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
          on this device, then reseed from Dropbox. You'll see a preview
          of what's on Dropbox (including which top-level folders will
          become desks) before anything is touched, and a progress bar
          while the reseed runs. Anything that exists only on this device
          and hasn't been pushed will be lost.
        </p>
        <button id="sync-clear-local" class="sync-danger-btn">Clear local versions…</button>
      </div>
    `;
  }
  return html;
}

// ===== Google =====

function renderGoogleSubTab(settings) {
  const isConnected = !!settings.googleAccessToken || !!settings.googleRefreshToken;
  const hasCredentials = !!(settings.googleClientId && settings.googleClientId.trim());
  const email = settings.googleAccountEmail || "";
  const linkCount = Object.keys(settings.googleDocLinks || {}).length;
  const log = settings.googleSyncLog || [];

  // The credential form takes over when the user clicks "Edit
  // credentials" OR when no client id is saved yet.
  if (_editingGoogleCreds || !hasCredentials) {
    return renderGoogleCredentialForm(settings, /* editing= */ hasCredentials);
  }

  // State B — credentials saved, not yet connected. Surface the Connect
  // button alongside an "Edit credentials" affordance.
  if (!isConnected) {
    return `
      <div class="settings-section">
        <h2>Google Sync</h2>
        <p class="settings-help">
          Connect your Google account to link individual Hush documents to
          Google Docs. Each linked doc shows a bar above the editor with
          explicit Push and Pull buttons. There is no automatic syncing or
          conflict detection; both Hush and Google Docs keep version
          history if you change your mind.
        </p>
        <div class="sync-info-box">
          <div class="sync-info-row">
            <span class="sync-info-label">OAuth client</span>
            <span class="sync-info-value">${escHtml(maskedClientId(settings.googleClientId))}</span>
          </div>
        </div>
        <div class="sync-btn-row">
          <button id="google-connect" class="sync-action-btn">Connect Google account</button>
          <button id="google-edit-credentials" class="sync-inline-btn">Edit credentials</button>
        </div>
        <div id="google-auth-status" class="sync-status"></div>
      </div>
    `;
  }

  // State C — fully connected. Show status, log, edit-creds + disconnect.
  return `
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
        <div class="sync-info-row">
          <span class="sync-info-label">OAuth client</span>
          <span class="sync-info-value">${escHtml(maskedClientId(settings.googleClientId))}</span>
        </div>
      </div>
      <div class="sync-btn-row">
        <button id="google-test-connection" class="sync-inline-btn">Test Connection</button>
        <button id="google-edit-credentials" class="sync-inline-btn">Edit credentials</button>
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
        Revokes the Google access token and forgets every per-document
        link. Your saved OAuth credentials remain so you can re-connect
        without re-entering them; the Google Docs themselves are untouched.
      </p>
      <button id="google-disconnect" class="sync-danger-btn">Disconnect Google account</button>
    </div>
  `;
}

// Module-local flag flipped by "Edit credentials" so the next render
// surfaces the form even though credentials are already saved.
let _editingGoogleCreds = false;
export function setEditingGoogleCreds(v) { _editingGoogleCreds = !!v; }

function renderGoogleCredentialForm(settings, editing) {
  const clientId = settings.googleClientId || "";
  const hasSecret = !!(settings.googleClientSecret && settings.googleClientSecret.trim());
  return `
    <div class="settings-section">
      <h2>Google Sync</h2>
      <p class="settings-help">
        Hush uses your own Google Cloud OAuth client so each install
        authenticates against an account you control. Setup:
      </p>
      <ol class="settings-help-list">
        <li>At <code>console.cloud.google.com/apis/credentials</code>,
          create credentials → <strong>OAuth client ID</strong> →
          application type <strong>Desktop app</strong>.</li>
        <li>Under <strong>Authorised redirect URIs</strong>, add
          <code>http://127.0.0.1</code> (no port). Google wildcards the
          port for loopback URIs, so Hush can use any free port at
          runtime.</li>
        <li>Enable the <strong>Google Drive API</strong> on the same
          Cloud project (APIs &amp; Services → Library).</li>
        <li>Configure the <strong>OAuth consent screen</strong> with at
          least an app name + your support email, and add your Gmail
          account to the <strong>Test users</strong> list while the
          screen is still in Testing.</li>
        <li>Paste the Client ID and Secret below.</li>
      </ol>
      <div class="settings-row settings-row-stacked">
        <label for="google-client-id">Client ID</label>
        <input id="google-client-id" type="text" autocomplete="off" spellcheck="false"
               class="settings-input" value="${escAttr(clientId)}"
               placeholder="123456-abc.apps.googleusercontent.com" />
      </div>
      <div class="settings-row settings-row-stacked">
        <label for="google-client-secret">Client Secret <span class="settings-hint">(optional for some client types)</span></label>
        <input id="google-client-secret" type="password" autocomplete="off" spellcheck="false"
               class="settings-input" value="${hasSecret ? "••••••••" : ""}"
               placeholder="${hasSecret ? "stored — leave blank to keep" : "GOCSPX-…"}" />
      </div>
      <div class="sync-btn-row">
        <button id="google-creds-save" class="sync-action-btn">Save credentials</button>
        ${editing ? `<button id="google-creds-cancel" class="sync-inline-btn">Cancel</button>` : ""}
      </div>
      <div id="google-auth-status" class="sync-status"></div>
    </div>
  `;
}

function maskedClientId(id) {
  if (!id) return "(unset)";
  if (id.length < 16) return id;
  return id.slice(0, 12) + "…" + id.slice(-12);
}

