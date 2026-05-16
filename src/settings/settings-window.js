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
  renderProofreadTab, bindProofreadTab,
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
  if (!settings.shortcutFindAll) settings.shortcutFindAll = "Alt+Shift+F";
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
  if (!settings.shortcutFindNext) settings.shortcutFindNext = "Ctrl+R";
  if (!settings.shortcutFindPrev) settings.shortcutFindPrev = "Ctrl+Shift+R";
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
  const tabs = [
    ["general", "General"],
    ["editor", "Editor"],
    ["shortcuts", "Shortcuts"],
    ["dry", "D.R.Y."],
    ["proofread", "Proofread"],
    ["flags", "Flags"],
    ["privacy", "Privacy"],
    ["sync", "Sync"],
    ["zotero", "Zotero"],
  ];
  root.innerHTML = `
    <div class="settings-layout">
      <select class="settings-tabs-dropdown" id="settings-tabs-dropdown">
        ${tabs.map(([id, label]) => `<option value="${id}"${activeTab === id ? " selected" : ""}>${label}</option>`).join("")}
      </select>
      <div class="settings-tabs">
        ${tabs.map(([id, label]) => tabBtn(id, label, tabIcons[id])).join("")}
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
        <div class="settings-panel${activeTab === 'proofread' ? ' active' : ''}" id="panel-proofread">
          ${renderProofreadTab(settings)}
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
  proofread: `<svg viewBox="0 0 24 24"><path d="M3 19 L7 5 L11 19 M4.5 14 H9.5"/><circle cx="17" cy="14.5" r="3.5"/><path d="M20.5 11.5 V18"/><line x1="2" y1="14" x2="22" y2="10"/><line x1="2" y1="10" x2="22" y2="14"/></svg>`,
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
  // Phone-only tab dropdown — the sidebar is hidden by CSS at narrow
  // widths and this select takes its place above the panel.
  const tabsDropdown = document.getElementById("settings-tabs-dropdown");
  if (tabsDropdown) {
    tabsDropdown.addEventListener("change", () => {
      activeTab = tabsDropdown.value;
      render();
    });
  }

  // General tab
  bindSelect("setting-visibility", "visibility");
  bindCheckbox("setting-always-on-top", "alwaysOnTop");
  bindCheckbox("setting-show-tooltips", "showTooltips");
  bindCheckbox("setting-touch-mode", "touchMode");
  bindCheckbox("setting-hide-system-chrome", "hideSystemChrome");

  // Editor tab — font/theme/size/line-height live in the Styles sidebar now;
  // only sticky headers, panes, typewriter and footnotes remain here.
  bindCheckbox("setting-make-space-for-panes", "makeSpaceForPanes");
  bindSelect("setting-make-space-direction", "makeSpaceDirection");
  bindCheckbox("setting-sticky-headers", "stickyHeaders");
  bindSlider("setting-typewriter-line-opacity", "typewriterLineOpacity", "%", v => (v * 100).toFixed(0));
  bindSlider("setting-focus-mode-opacity", "focusModeOpacity", "%", v => (v * 100).toFixed(0));
  bindSlider("setting-comment-opacity", "commentOpacity", "%", v => (v * 100).toFixed(0));
  bindSlider("setting-zen-focus-font-size", "zenFocusFontSize", "px");
  bindSlider("setting-notebook-text-max-width", "notebookTextMaxWidth", "px");
  bindSelect("setting-flow-connect-mode", "flowConnectMode");
  bindSlider("setting-footnote-font-size", "footnoteFontSize", "%");
  bindSelect("setting-footnote-font-family", "footnoteFontFamily");
  bindCheckbox("setting-footnote-use-colors", "footnoteUseColors");
  bindSelect("setting-footnote-margin-side", "footnoteMarginSide");

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

  // Proofread tab — async because the rule list comes from the Rust
  // `list_grammar_rules` command. The first call returns null and
  // re-renders once the cache is populated; subsequent renders bind
  // checkbox handlers immediately.
  bindProofreadTab(saveSetting, settings, render);

  // Sync tab (delegated to settings-sync-tab.js)
  import("./settings-sync-tab.js").then(m => m.bindSyncTab(saveSetting, settings, render));

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

  bindNumber("zotero-snapshot-render-height", "zoteroSnapshotRenderHeight");
  bindNumber("zotero-snapshot-display-height", "zoteroSnapshotDisplayHeight");
  bindNumber("zotero-snapshot-quality", "zoteroSnapshotQuality");

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

function bindNumber(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", () => {
    const v = parseInt(el.value, 10);
    if (Number.isFinite(v)) saveSetting(key, v);
  });
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


// Auto-init only when running in the standalone settings window
async function init() {
  const root = document.getElementById("settings-root");
  if (root) await initSettingsInto(root);
}
init().catch(console.error);
