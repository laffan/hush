/**
 * Sync settings tab — sub-tabs: Google Sync, iCloud (debug), Recovery
 * (local-desk snapshots), and the sync Log. Dropbox sync was removed
 * (see LOCAL-DESKS-PLANNING.md) — folder-based desks over the user's
 * own file provider replace it. Local Folder mounts live in the
 * sidebar's Add (+) menu, not here.
 *
 * Active sub-tab is module-local — the binding side calls
 * `setSyncSubTab(id)` followed by the parent `render()` to switch.
 */

import { escHtml, escAttr } from "./settings-tabs.js";
import { SYNC_LOG_ERROR_PREFIX } from "../sync/sync-feedback.js";
import { renderICloudSubTab } from "./settings-tabs-icloud.js";
import { renderRecoverySubTab } from "./settings-tabs-recovery.js";

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

let _activeSubTab = "google"; // "google" | "icloud" | "recovery" | "log"

export function getSyncSubTab() { return _activeSubTab; }
export function setSyncSubTab(id) {
  if (id === "google" || id === "icloud" || id === "recovery" || id === "log") _activeSubTab = id;
}

function subTabNav() {
  const tab = (id, label) => `<button class="sync-subtab${_activeSubTab === id ? " active" : ""}" data-sync-subtab="${id}">${label}</button>`;
  return `<div class="sync-subtab-nav">
    ${tab("google", "Google Sync")}
    ${tab("icloud", "iCloud")}
    ${tab("recovery", "Recovery")}
    ${tab("log", "Log")}
  </div>`;
}

export function renderSyncTab(settings) {
  let body = "";
  if (_activeSubTab === "icloud") body = renderICloudSubTab();
  else if (_activeSubTab === "recovery") body = renderRecoverySubTab();
  else if (_activeSubTab === "log") body = renderLogSubTab(settings);
  else body = renderGoogleSubTab(settings);
  return subTabNav() + `<div class="sync-subtab-body">${body}</div>`;
}

// ===== Log =====

/** Persistent sync-adjacent activity log (`settings.syncLog`) — Local
 *  Folder / desk reconcile activity and background-task errors (e.g.
 *  Zotero PDF downloads) land here via sync-feedback.js. */
function renderLogSubTab(settings) {
  const syncLog = settings.syncLog || [];
  return `
    <div class="settings-section">
      <h2>Sync Log</h2>
      <div class="sync-log-box" id="sync-log-box">
        ${syncLog.length > 0
          ? syncLog.slice(-20).reverse().map(renderSyncLogEntry).join("")
          : `<div class="sync-log-empty">No sync activity yet.</div>`
        }
      </div>
      <div class="sync-btn-row" style="margin-top:8px;">
        <button id="sync-clear-log" class="sync-inline-btn">Clear log</button>
      </div>
    </div>
  `;
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

