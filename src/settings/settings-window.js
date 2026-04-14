/**
 * Settings window — runs in a separate Tauri WebviewWindow.
 * Communicates with main window via Tauri events.
 * Tabbed layout: General, Editor, Shortcuts, D.R.Y., Flags
 */
import { DEFAULT_STOPWORDS } from "../editor/plugins/dry-highlight.js";
import { bindFlagsTab } from "../longview/longview-settings.js";
import { testZoteroConnection, downloadZoteroReferences, clearCache as clearZoteroCache } from "../zotero.js";
import {
  shortcutDefs, normalizeShortcut, isIOSSettings,
  renderGeneralTab, renderEditorTab, renderShortcutsTab,
  renderDryTab, renderFlagsSettingsTab, renderSyncTab, renderPrivacyTab, renderZoteroTab,
} from "./settings-tabs.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

let settings = {};
let activeTab = "general";
let settingsRootEl = null;
let onSaveCallback = null;
let drySearchQuery = '';
let shortcutSearchQuery = '';

/**
 * Initialize the settings UI into a given root element.
 * Called automatically when #settings-root exists (standalone window),
 * or manually via renderSettingsModal() for the iOS modal.
 */
export async function initSettingsInto(rootEl, saveCallback) {
  settingsRootEl = rootEl;
  onSaveCallback = saveCallback || null;

  if (IS_TAURI) {
    const { invoke } = await import("@tauri-apps/api/core");
    settings = await invoke("get_settings");
  } else {
    const saved = localStorage.getItem("hush_settings");
    if (saved) settings = JSON.parse(saved);
  }

  const appearance = settings.appearance || "dark";
  const theme = appearance === "auto"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : appearance;
  document.documentElement.setAttribute("data-theme", theme);

  // Ensure defaults
  if (!settings.styles) settings.styles = [];
  if (!settings.dryRange) settings.dryRange = "paragraph";
  if (!settings.dryStopwords || settings.dryStopwords.length === 0) settings.dryStopwords = [...DEFAULT_STOPWORDS];
  if (!settings.shortcutToggleSidebar) settings.shortcutToggleSidebar = "CmdOrCtrl+\\";
  if (!settings.shortcutToggleOutline) settings.shortcutToggleOutline = "CmdOrCtrl+Shift+\\";
  if (!settings.shortcutTypewriter) settings.shortcutTypewriter = "Mod+T";
  if (!settings.shortcutNewFile) settings.shortcutNewFile = "Mod+N";
  if (!settings.shortcutFind) settings.shortcutFind = "Mod+F";
  if (!settings.shortcutFindAll) settings.shortcutFindAll = "Mod+Shift+F";
  if (!settings.shortcutSelectSentence) settings.shortcutSelectSentence = "Mod+L";
  if (!settings.shortcutReduceSentence) settings.shortcutReduceSentence = "Alt+Shift+L";
  if (!settings.shortcutSelectNext) settings.shortcutSelectNext = "Mod+D";
  if (!settings.shortcutJumpNextSentence) settings.shortcutJumpNextSentence = "Mod+ArrowRight";
  if (!settings.shortcutJumpPrevSentence) settings.shortcutJumpPrevSentence = "Mod+ArrowLeft";
  if (!settings.shortcutNextSentence) settings.shortcutNextSentence = "Mod+Shift+ArrowRight";
  if (!settings.shortcutPrevSentence) settings.shortcutPrevSentence = "Mod+Shift+ArrowLeft";
  if (!settings.shortcutMoveSentenceForward) settings.shortcutMoveSentenceForward = "Alt+Mod+ArrowRight";
  if (!settings.shortcutMoveSentenceBack) settings.shortcutMoveSentenceBack = "Alt+Mod+ArrowLeft";
  if (!settings.shortcutSelectPrevious) settings.shortcutSelectPrevious = "Mod+Shift+D";
  if (!settings.shortcutDeleteToSentenceEnd) settings.shortcutDeleteToSentenceEnd = "Alt+Shift+Backspace";
  if (!settings.shortcutToggleDry) settings.shortcutToggleDry = "Mod+Shift+R";
  if (!settings.shortcutToggleFocus) settings.shortcutToggleFocus = "Mod+Shift+Y";
  if (!settings.shortcutBold) settings.shortcutBold = "Mod+B";
  if (!settings.shortcutItalic) settings.shortcutItalic = "Mod+I";
  if (!settings.shortcutHighlight) settings.shortcutHighlight = "Mod+=";
  if (!settings.shortcutComment) settings.shortcutComment = "Mod+/";
  if (!settings.shortcutStrikethrough) settings.shortcutStrikethrough = "Mod+`";
  if (!settings.shortcutInsertFootnote) settings.shortcutInsertFootnote = "Mod+Shift+M";
  if (!settings.shortcutSelectParagraph) settings.shortcutSelectParagraph = "Mod+Shift+L";
  if (!settings.shortcutZotero) settings.shortcutZotero = "Mod+Shift+I";
  if (!settings.shortcutSave) settings.shortcutSave = "Mod+S";
  if (!settings.shortcutFindNext) settings.shortcutFindNext = "Mod+G";
  if (!settings.shortcutFindPrev) settings.shortcutFindPrev = "Mod+Shift+G";
  if (!settings.shortcutJoinLines) settings.shortcutJoinLines = "Mod+J";
  if (!settings.shortcutJumpNextParagraph) settings.shortcutJumpNextParagraph = "Mod+ArrowDown";
  if (!settings.shortcutJumpPrevParagraph) settings.shortcutJumpPrevParagraph = "Mod+ArrowUp";
  // Migrate old "decoy" → "dummy" naming
  if (settings.privacyMode === "decoy") settings.privacyMode = "dummy";
  if (settings.decoyText && !settings.dummyText) settings.dummyText = settings.decoyText;

  // Cmd+Q — hide the main window instead of quitting when in menu-bar-only mode.
  // DOM-level listener so it only fires when this settings window is focused.
  if (IS_TAURI && settings.visibility === "menubar") {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    document.addEventListener("keydown", async (e) => {
      if (e.key === "q" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        await getCurrentWindow().hide();
      }
    });
  }

  render();
}

function render() {
  const root = settingsRootEl || document.getElementById("settings-root");
  if (!root) return;
  root.innerHTML = `
    <div class="settings-layout">
      <div class="settings-tabs">
        ${tabBtn("general", "General", tabIcons.general)}
        ${tabBtn("editor", "Editor", tabIcons.editor)}
        ${tabBtn("shortcuts", "Shortcuts", tabIcons.shortcuts)}
        ${tabBtn("dry", "D.R.Y.", tabIcons.dry)}
        ${tabBtn("flags", "Flags", tabIcons.flags)}
        ${tabBtn("privacy", "Privacy", tabIcons.privacy)}
        ${tabBtn("sync", "Sync", tabIcons.sync)}
        ${tabBtn("zotero", "Zotero", tabIcons.zotero)}
      </div>
      <div class="settings-content">
        <div class="settings-panel${activeTab === 'general' ? ' active' : ''}" id="panel-general">
          ${renderGeneralTab(settings)}
        </div>
        <div class="settings-panel${activeTab === 'editor' ? ' active' : ''}" id="panel-editor">
          ${renderEditorTab(settings)}
        </div>
        <div class="settings-panel${activeTab === 'shortcuts' ? ' active' : ''}" id="panel-shortcuts">
          ${renderShortcutsTab(settings, shortcutSearchQuery)}
        </div>
        <div class="settings-panel${activeTab === 'dry' ? ' active' : ''}" id="panel-dry">
          ${renderDryTab(settings, drySearchQuery)}
        </div>
        <div class="settings-panel${activeTab === 'flags' ? ' active' : ''}" id="panel-flags">
          ${renderFlagsSettingsTab(settings)}
        </div>
        <div class="settings-panel${activeTab === 'privacy' ? ' active' : ''}" id="panel-privacy">
          ${renderPrivacyTab(settings)}
        </div>
        <div class="settings-panel${activeTab === 'sync' ? ' active' : ''}" id="panel-sync">
          ${renderSyncTab(settings)}
        </div>
        <div class="settings-panel${activeTab === 'zotero' ? ' active' : ''}" id="panel-zotero">
          ${renderZoteroTab(settings)}
        </div>
      </div>
    </div>
  `;

  bindAll();
}

const tabIcons = {
  general: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`,
  editor: `<svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  shortcuts: `<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="8" x2="6" y2="8"/><line x1="10" y1="8" x2="10" y2="8"/><line x1="14" y1="8" x2="14" y2="8"/><line x1="18" y1="8" x2="18" y2="8"/><line x1="6" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="18" y2="12"/><line x1="8" y1="16" x2="16" y2="16"/></svg>`,
  dry: `<svg viewBox="0 0 24 24"><path d="M12 2L4 7v10l8 5 8-5V7l-8-5z"/><line x1="12" y1="2" x2="12" y2="22"/><line x1="4" y1="7" x2="20" y2="7"/></svg>`,
  flags: `<svg viewBox="0 0 24 24"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>`,
  privacy: `<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/><line x1="1" y1="1" x2="23" y2="23" stroke-width="2"/></svg>`,
  sync: `<svg viewBox="0 0 24 24"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
  zotero: `<svg viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
};

function tabBtn(id, label, icon) {
  return `<button class="settings-tab${activeTab === id ? ' active' : ''}" data-tab="${id}">
    ${icon}<span>${label}</span>
  </button>`;
}

// ===== Bindings =====
function bindAll() {
  // Tab switching
  document.querySelectorAll(".settings-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      render();
    });
  });

  // General tab
  bindSelect("setting-visibility", "visibility");
  bindCheckbox("setting-always-on-top", "alwaysOnTop");
  bindCheckbox("setting-hide-sidebar-tooltips", "hideSidebarTooltips");

  // Editor tab
  bindSelect("setting-appearance", "appearance");
  bindSelect("setting-light-theme", "lightTheme");
  bindSelect("setting-dark-theme", "darkTheme");
  bindSelect("setting-font-family", "fontFamily");
  bindCheckbox("setting-normalize-headers", "normalizeHeaders");
  bindCheckbox("setting-normalize-header-color", "normalizeHeaderColor");
  bindCheckbox("setting-sticky-headers", "stickyHeaders");
  const blockCursorEl = document.getElementById("setting-block-cursor");
  if (blockCursorEl) {
    blockCursorEl.addEventListener("change", () => {
      saveSetting("blockCursor", blockCursorEl.checked);
    });
  }
  bindSlider("setting-typewriter-line-opacity", "typewriterLineOpacity", "%", v => (v * 100).toFixed(0));
  bindSlider("setting-footnote-font-size", "footnoteFontSize", "%");
  bindSelect("setting-footnote-font-family", "footnoteFontFamily");
  bindCheckbox("setting-footnote-use-colors", "footnoteUseColors");
  bindSelect("setting-footnote-margin-side", "footnoteMarginSide");
  bindSlider("setting-font-size", "fontSize", "px");
  bindSlider("setting-line-height", "lineHeight", "");

  // Privacy tab
  bindSelect("setting-privacy-mode", "privacyMode");
  const dummyTextEl = document.getElementById("setting-dummy-text");
  if (dummyTextEl) {
    let dummyTimer = null;
    dummyTextEl.addEventListener("input", () => {
      clearTimeout(dummyTimer);
      dummyTimer = setTimeout(() => {
        saveSetting("dummyText", dummyTextEl.value);
      }, 500);
    });
    // Strip line breaks and extra whitespace on paste, save immediately
    dummyTextEl.addEventListener("paste", (e) => {
      e.preventDefault();
      const raw = (e.clipboardData || window.clipboardData).getData("text");
      const cleaned = raw.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ");
      const start = dummyTextEl.selectionStart;
      const end = dummyTextEl.selectionEnd;
      const before = dummyTextEl.value.slice(0, start);
      const after = dummyTextEl.value.slice(end);
      dummyTextEl.value = before + cleaned + after;
      dummyTextEl.selectionStart = dummyTextEl.selectionEnd = start + cleaned.length;
      clearTimeout(dummyTimer);
      saveSetting("dummyText", dummyTextEl.value);
      render();
    });
  }

  // Flags tab
  bindFlagsTab(saveSetting, settings, render);

  // D.R.Y. tab
  bindSelect("setting-dry-range", "dryRange");
  bindCheckbox("setting-dry-proper-nouns", "dryIgnoreProperNouns");
  bindCheckbox("setting-dry-base-words", "dryIncludeBaseWords");

  const drySearchInput = document.getElementById("dry-search-input");
  if (drySearchInput) {
    drySearchInput.addEventListener("input", () => {
      drySearchQuery = drySearchInput.value;
      render();
    });
  }

  const dryAddBtn = document.getElementById("dry-add-btn");
  if (dryAddBtn) {
    dryAddBtn.addEventListener("click", () => {
      const input = document.getElementById("dry-add-input");
      if (!input) return;
      const word = input.value.trim().toLowerCase();
      if (!word) return;
      const list = settings.dryStopwords || [];
      if (!list.includes(word)) {
        list.push(word);
        list.sort();
        saveSetting("dryStopwords", list);
        render();
      }
    });
  }
  const dryAddInput = document.getElementById("dry-add-input");
  if (dryAddInput) {
    dryAddInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const btn = document.getElementById("dry-add-btn");
        if (btn) btn.click();
      }
    });
  }

  document.querySelectorAll(".dry-stopword-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      const word = btn.dataset.word;
      settings.dryStopwords = (settings.dryStopwords || []).filter(w => w !== word);
      saveSetting("dryStopwords", settings.dryStopwords);
      render();
    });
  });

  const dryResetBtn = document.getElementById("dry-reset-btn");
  if (dryResetBtn) {
    dryResetBtn.addEventListener("click", () => {
      settings.dryStopwords = [...DEFAULT_STOPWORDS];
      saveSetting("dryStopwords", settings.dryStopwords);
      drySearchQuery = "";
      render();
    });
  }

  // Sync tab — OAuth connect
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

        // Listen for the oauth-callback Tauri event (fired by the Rust
        // deep-link handler when hushwriter://auth/callback?code=xxx arrives).
        // The settings window has the verifier in its own sessionStorage.
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
          // Auto-cleanup after 5 minutes
          setTimeout(() => unlisten(), 300000);
        }
      } catch (e) {
        console.error("OAuth start failed:", e);
        if (status) { status.textContent = "Failed to start authorization: " + e.message; status.className = "sync-status error"; }
      }
    });
  }

  // Sync tab — Browse folder (initial setup or change folder)
  async function handleFolderBrowse() {
    try {
      const { openDropboxBrowser } = await import("../sync/dropbox-browser.js");
      const result = await openDropboxBrowser();
      if (!result) return;

      const status = document.getElementById("sync-auth-status");
      const path = result.path;

      // Show preview before committing
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

      // Save path, enable sync, and start
      saveSetting("dropboxSyncPath", path);
      saveSetting("dropboxEnabled", true);
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

  // Sync tab — Change folder (already syncing)
  const syncChangeFolderBtn = document.getElementById("sync-change-folder");
  if (syncChangeFolderBtn) {
    syncChangeFolderBtn.addEventListener("click", async () => {
      // Stop current sync, pick new folder, restart
      if (IS_TAURI) {
        const sp = await import("../sync/sync-polling.js");
        sp.stopSyncPolling();
      }
      await handleFolderBrowse();
    });
  }

  // Sync tab — Test connection
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

  // Sync tab — Disconnect (before sync started)
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

  // Sync tab — Stop syncing (unsync)
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

  /** Add an entry to the persisted sync log. */
  function addSyncLogEntry(message) {
    const now = new Date();
    const ts = now.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const entry = `${ts}  ${message}`;
    const log = settings.dropboxSyncLog || [];
    log.push(entry);
    // Keep last 50 entries
    if (log.length > 50) log.splice(0, log.length - 50);
    saveSetting("dropboxSyncLog", log);
  }

  // Sync tab — handle OAuth callback (deep link returns with auth code)
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

  // Zotero tab
  const zoteroTestBtn = document.getElementById("zotero-test-btn");
  if (zoteroTestBtn) {
    zoteroTestBtn.addEventListener("click", async () => {
      const userIdInput = document.getElementById("zotero-user-id");
      const apiKeyInput = document.getElementById("zotero-api-key");
      const status = document.getElementById("zotero-test-status");
      const userId = userIdInput?.value?.trim();
      const apiKey = apiKeyInput?.value?.trim();
      if (!userId || !apiKey) { status.textContent = "Please enter both User ID and API Key."; status.className = "zotero-status error"; return; }
      status.textContent = "Testing..."; status.className = "zotero-status";
      try {
        await testZoteroConnection(userId, apiKey);
        status.textContent = "Connected successfully!"; status.className = "zotero-status success";
        saveSetting("zoteroUserId", userId); saveSetting("zoteroApiKey", apiKey);
        const dlBtn = document.getElementById("zotero-download-btn");
        if (dlBtn) dlBtn.disabled = false;
      } catch (e) {
        status.textContent = "Connection failed: " + e.message; status.className = "zotero-status error";
      }
    });
  }

  const zoteroDownloadBtn = document.getElementById("zotero-download-btn");
  if (zoteroDownloadBtn) {
    zoteroDownloadBtn.addEventListener("click", async () => {
      const userId = settings.zoteroUserId || document.getElementById("zotero-user-id")?.value?.trim();
      const apiKey = settings.zoteroApiKey || document.getElementById("zotero-api-key")?.value?.trim();
      if (!userId || !apiKey) return;
      zoteroDownloadBtn.disabled = true;
      const progressEl = document.getElementById("zotero-progress");
      const fillEl = document.getElementById("zotero-progress-fill");
      const textEl = document.getElementById("zotero-progress-text");
      if (progressEl) progressEl.style.display = "";
      try {
        const refs = await downloadZoteroReferences(userId, apiKey, (msg, pct) => {
          if (fillEl) fillEl.style.width = Math.round(pct * 100) + "%";
          if (textEl) textEl.textContent = msg;
        });
        // Save references via Tauri command
        const jsonStr = JSON.stringify(refs);
        const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
        if (IS_TAURI) {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("save_zotero_references", { data: jsonStr });
        } else {
          localStorage.setItem("hush_zotero_refs", jsonStr);
        }
        clearZoteroCache();
        // Compute human-readable file size
        const bytes = new Blob([jsonStr]).size;
        const fileSize = bytes < 1024 * 1024
          ? (bytes / 1024).toFixed(1) + " KB"
          : (bytes / (1024 * 1024)).toFixed(1) + " MB";
        const timestamp = new Date().toLocaleString();
        saveSetting("zoteroLastUpdate", timestamp);
        saveSetting("zoteroReferenceCount", refs.length);
        saveSetting("zoteroFileSize", fileSize);
        saveSetting("zoteroUserId", userId);
        saveSetting("zoteroApiKey", apiKey);
        render();
      } catch (e) {
        if (textEl) textEl.textContent = "Download failed: " + e.message;
        zoteroDownloadBtn.disabled = false;
      }
    });
  }

  // Shortcuts tab — click on shortcut-keys to record
  document.querySelectorAll(".shortcut-display .shortcut-keys").forEach(el => {
    el.addEventListener("click", () => {
      const wrap = el.closest(".shortcut-row-wrap");
      const settingKey = wrap?.dataset?.shortcutKey;
      if (settingKey) {
        startShortcutRecording(el, settingKey);
      }
    });
  });

  // Shortcuts tab — search input
  const shortcutSearchInput = document.getElementById("shortcut-search-input");
  if (shortcutSearchInput) {
    shortcutSearchInput.addEventListener("input", () => {
      shortcutSearchQuery = shortcutSearchInput.value;
      const pos = shortcutSearchInput.selectionStart;
      render();
      // Restore focus + caret after re-render so typing is seamless.
      const newInput = document.getElementById("shortcut-search-input");
      if (newInput) {
        newInput.focus();
        try { newInput.setSelectionRange(pos, pos); } catch (e) { /* noop */ }
      }
    });
  }

}

function bindSelect(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", () => saveSetting(key, el.value));
}

function bindCheckbox(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", () => saveSetting(key, el.checked));
}

function bindSlider(id, key, suffix, formatter) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("input", () => {
    const val = parseFloat(el.value);
    el.nextElementSibling.textContent = formatter ? formatter(val) + suffix : val + suffix;
    saveSetting(key, val);
  });
}

// ===== Shortcut Recording =====
function startShortcutRecording(display, settingKey) {
  display.innerHTML = "";
  display.classList.add("recording");

  function onKeyDown(e) {
    e.preventDefault();
    e.stopPropagation();

    if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;

    if (e.key === "Escape") {
      cleanup();
      render();
      return;
    }

    const parts = [];
    if (e.metaKey || e.ctrlKey) parts.push("CmdOrCtrl");
    if (e.shiftKey) parts.push("Shift");
    if (e.altKey) parts.push("Alt");
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);

    const shortcut = parts.join("+");

    // Check for conflict
    const normalized = normalizeShortcut(shortcut);
    for (const def of shortcutDefs) {
      if (def.key === settingKey) continue;
      if (settings[def.key] && normalizeShortcut(settings[def.key]) === normalized) {
        // Conflict: swap — clear the conflicting one
        settings[def.key] = "";
        saveSetting(def.key, "");
        break;
      }
    }

    cleanup();
    saveSetting(settingKey, shortcut);
    render();
  }

  function cleanup() {
    document.removeEventListener("keydown", onKeyDown, true);
    display.classList.remove("recording");
  }

  document.addEventListener("keydown", onKeyDown, true);
}

// ===== Save =====
async function saveSetting(key, value) {
  settings[key] = value;
  if (IS_TAURI) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_settings", { settings });
    // In modal mode, use the callback instead of cross-window emit
    if (onSaveCallback) {
      onSaveCallback(settings);
    } else {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("settings-updated", settings);
    }
  } else {
    localStorage.setItem("hush_settings", JSON.stringify(settings));
    if (onSaveCallback) onSaveCallback(settings);
  }
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

// Auto-init only when running in the standalone settings window
async function init() {
  const root = document.getElementById("settings-root");
  if (root) await initSettingsInto(root);
}
init().catch(console.error);
