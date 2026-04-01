/**
 * Settings window — runs in a separate Tauri WebviewWindow.
 * Communicates with main window via Tauri events.
 * Tabbed layout: General, Editor, Shortcuts, D.R.Y., Flags
 */
import { themeList } from "./themes.js";
import { DEFAULT_STOPWORDS } from "./dry-highlight.js";
import { renderFlagsTab, bindFlagsTab } from "./longview-settings.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

let settings = {};
let activeTab = "general";
let settingsRootEl = null;
let onSaveCallback = null;

// Shortcuts organized by category
const shortcutCategories = [
  {
    name: "General",
    shortcuts: [
      { key: "shortcutOpenEditor", label: "Toggle editor" },
      { key: "shortcutOpenFullscreen", label: "Open fullscreen" },
      { key: "shortcutTogglePrivate", label: "Toggle private mode" },
      { key: "shortcutToggleSidebar", label: "Toggle sidebar" },
      { key: "shortcutToggleOutline", label: "Toggle outline view" },
      { key: "shortcutTypewriter", label: "Toggle typewriter mode" },
      { key: "shortcutToggleDry", label: "Toggle D.R.Y. highlighting" },
      { key: "shortcutToggleFocus", label: "Toggle focus mode" },
      { key: "shortcutNewFile", label: "New file" },
      { key: "shortcutFind", label: "Find / replace" },
      { key: "shortcutFindAll", label: "Find across files" },
    ],
  },
  {
    name: "Editing",
    shortcuts: [
      { key: "shortcutSelectSentence", label: "Select sentence" },
      { key: "shortcutReduceSentence", label: "Reduce sentence selection" },
      { key: "shortcutSelectNext", label: "Select next instance" },
      { key: "shortcutJumpNextSentence", label: "Jump to next sentence" },
      { key: "shortcutJumpPrevSentence", label: "Jump to previous sentence" },
      { key: "shortcutNextSentence", label: "Shift selection to next sentence" },
      { key: "shortcutPrevSentence", label: "Shift selection to previous sentence" },
      { key: "shortcutMoveSentenceForward", label: "Move sentence forward" },
      { key: "shortcutMoveSentenceBack", label: "Move sentence back" },
      { key: "shortcutSelectPrevious", label: "Select previous instance" },
      { key: "shortcutDeleteToSentenceEnd", label: "Delete to sentence end" },
    ],
  },
  {
    name: "Formatting",
    shortcuts: [
      { key: "shortcutBold", label: "Bold" },
      { key: "shortcutItalic", label: "Italic" },
      { key: "shortcutHighlight", label: "Highlight" },
      { key: "shortcutComment", label: "Comment" },
      { key: "shortcutStrikethrough", label: "Strikethrough" },
      { key: "shortcutInsertFootnote", label: "Insert footnote" },
    ],
  },
];

// Flat list for conflict detection
const shortcutDefs = shortcutCategories.flatMap(cat => cat.shortcuts);

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
  if (!settings.shortcutReduceSentence) settings.shortcutReduceSentence = "Mod+Shift+L";
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
        ${tabBtn("sync", "Sync", tabIcons.sync)}
      </div>
      <div class="settings-content">
        <div class="settings-panel${activeTab === 'general' ? ' active' : ''}" id="panel-general">
          ${renderGeneralTab()}
        </div>
        <div class="settings-panel${activeTab === 'editor' ? ' active' : ''}" id="panel-editor">
          ${renderEditorTab()}
        </div>
        <div class="settings-panel${activeTab === 'shortcuts' ? ' active' : ''}" id="panel-shortcuts">
          ${renderShortcutsTab()}
        </div>
        <div class="settings-panel${activeTab === 'dry' ? ' active' : ''}" id="panel-dry">
          ${renderDryTab()}
        </div>
        <div class="settings-panel${activeTab === 'flags' ? ' active' : ''}" id="panel-flags">
          ${renderFlagsSettingsTab()}
        </div>
        <div class="settings-panel${activeTab === 'sync' ? ' active' : ''}" id="panel-sync">
          ${renderSyncTab()}
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
  sync: `<svg viewBox="0 0 24 24"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
};

function tabBtn(id, label, icon) {
  return `<button class="settings-tab${activeTab === id ? ' active' : ''}" data-tab="${id}">
    ${icon}<span>${label}</span>
  </button>`;
}

// ===== General Tab =====
function renderGeneralTab() {
  const s = settings;
  return `
    <div class="settings-section">
      <h2>Visibility</h2>
      <div class="settings-row">
        <label>App visibility</label>
        <select id="setting-visibility">
          <option value="menubar" ${s.visibility === "menubar" ? "selected" : ""}>Show only menu bar</option>
          <option value="dock" ${s.visibility === "dock" ? "selected" : ""}>Show dock icon</option>
          <option value="both" ${s.visibility === "both" ? "selected" : ""}>Show both</option>
        </select>
      </div>
      <div class="settings-row">
        <label>Show app above all other windows</label>
        <input type="checkbox" id="setting-always-on-top" ${s.alwaysOnTop ? "checked" : ""} />
      </div>
    </div>
  `;
}

// ===== Editor Tab =====
function renderEditorTab() {
  const s = settings;
  const lightThemes = themeList.filter((t) => t.type === "light");
  const darkThemes = themeList.filter((t) => t.type === "dark");

  return `
    <div class="settings-section">
      <h2>Appearance</h2>
      <div class="settings-row">
        <label>Color scheme</label>
        <select id="setting-appearance">
          <option value="light" ${s.appearance === "light" ? "selected" : ""}>Light</option>
          <option value="dark" ${s.appearance === "dark" ? "selected" : ""}>Dark</option>
          <option value="auto" ${s.appearance === "auto" ? "selected" : ""}>Automatic</option>
        </select>
      </div>
    </div>

    <div class="settings-section">
      <h2>Themes</h2>
      <div class="settings-row">
        <label>Default light theme</label>
        <select id="setting-light-theme">
          ${lightThemes.map((t) => `<option value="${t.id}" ${s.lightTheme === t.id ? "selected" : ""}>${t.name}</option>`).join("")}
        </select>
      </div>
      <div class="settings-row">
        <label>Default dark theme</label>
        <select id="setting-dark-theme">
          ${darkThemes.map((t) => `<option value="${t.id}" ${s.darkTheme === t.id ? "selected" : ""}>${t.name}</option>`).join("")}
        </select>
      </div>
    </div>

    <div class="settings-section">
      <h2>Font</h2>
      <div class="settings-row">
        <label>Font family</label>
        <select id="setting-font-family">
          ${renderFontOptions(s.fontFamily)}
        </select>
      </div>
    </div>

    <div class="settings-section">
      <h2>Headers</h2>
      <div class="settings-row">
        <label>Normalize header sizes</label>
        <input type="checkbox" id="setting-normalize-headers" ${s.normalizeHeaders ? "checked" : ""} />
      </div>
    </div>

    <div class="settings-section">
      <h2>Footnotes</h2>
      <div class="settings-slider-row">
        <label>Font size</label>
        <div class="slider-group">
          <input type="range" id="setting-footnote-font-size" min="50" max="150" step="5" value="${s.footnoteFontSize || 100}" />
          <span class="slider-value">${s.footnoteFontSize || 100}%</span>
        </div>
      </div>
      <div class="settings-row">
        <label>Font family</label>
        <select id="setting-footnote-font-family">
          <option value="sans-serif" ${(s.footnoteFontFamily || "sans-serif") === "sans-serif" ? "selected" : ""}>Sans-serif</option>
          <option value="serif" ${s.footnoteFontFamily === "serif" ? "selected" : ""}>Serif</option>
          <option value="match" ${s.footnoteFontFamily === "match" ? "selected" : ""}>Match main text</option>
        </select>
      </div>
      <div class="settings-row">
        <label>Use colors</label>
        <input type="checkbox" id="setting-footnote-use-colors" ${s.footnoteUseColors !== false ? "checked" : ""} />
      </div>
      <div class="settings-row">
        <label>Margin placement</label>
        <select id="setting-footnote-margin-side">
          <option value="closest" ${(s.footnoteMarginSide || "closest") === "closest" ? "selected" : ""}>Use closest</option>
          <option value="split" ${s.footnoteMarginSide === "split" ? "selected" : ""}>Split</option>
          <option value="left" ${s.footnoteMarginSide === "left" ? "selected" : ""}>Left only</option>
          <option value="right" ${s.footnoteMarginSide === "right" ? "selected" : ""}>Right only</option>
        </select>
      </div>
    </div>

    <div class="settings-section">
      <h2>Text</h2>
      <div class="settings-slider-row">
        <label>Font size</label>
        <div class="slider-group">
          <input type="range" id="setting-font-size" min="12" max="36" step="1" value="${s.fontSize || 20}" />
          <span class="slider-value">${s.fontSize || 20}px</span>
        </div>
      </div>
      <div class="settings-slider-row">
        <label>Line height</label>
        <div class="slider-group">
          <input type="range" id="setting-line-height" min="1.0" max="2.5" step="0.1" value="${s.lineHeight || 1.6}" />
          <span class="slider-value">${s.lineHeight || 1.6}</span>
        </div>
      </div>
    </div>
  `;
}

// System font options
function renderFontOptions(currentFamily) {
  const builtIn = [
    { name: "Source Sans Pro", family: "Source Sans Pro" },
    { name: "Source Serif Pro", family: "Source Serif Pro" },
    { name: "Libre Franklin", family: "Libre Franklin" },
    { name: "Libre Baskerville", family: "Libre Baskerville" },
    { name: "Karla", family: "Karla" },
    { name: "Lora", family: "Lora" },
    { name: "Helvetica", family: "Helvetica" },
    { name: "EB Garamond", family: "EB Garamond" },
    { name: "Inter", family: "Inter" },
    { name: "Fira Code", family: "Fira Code" },
  ];

  const systemFonts = getSystemFonts();
  let html = `<optgroup label="Built-in">`;
  for (const f of builtIn) {
    html += `<option value="${f.family}" ${currentFamily === f.family ? "selected" : ""} style="font-family: '${f.family}'">${f.name}</option>`;
  }
  html += `</optgroup>`;

  if (systemFonts.length > 0) {
    html += `<optgroup label="System Fonts">`;
    for (const name of systemFonts) {
      const sel = currentFamily === name ? "selected" : "";
      html += `<option value="${name}" ${sel} style="font-family: '${name}'">${name}</option>`;
    }
    html += `</optgroup>`;
  }

  return html;
}

function getSystemFonts() {
  // Use the Local Font Access API if available, else return common system fonts
  const common = [
    "Arial", "Avenir", "Avenir Next", "Baskerville", "Bookman Old Style",
    "Courier New", "Didot", "Futura", "Garamond", "Geneva", "Georgia",
    "Gill Sans", "Hoefler Text",
    "Lucida Grande", "Menlo", "Monaco", "Optima", "Palatino",
    "SF Mono", "SF Pro", "SF Pro Display", "SF Pro Rounded", "SF Pro Text",
    "System UI", "Times New Roman", "Trebuchet MS", "Verdana",
  ];
  return common;
}

// ===== Shortcuts Tab =====
function renderShortcutsTab() {
  let html = '';
  for (const category of shortcutCategories) {
    html += `<div class="settings-section"><h2>${category.name}</h2>`;
    for (const def of category.shortcuts) {
      const conflict = findConflict(def.key);
      html += `<div class="shortcut-row-wrap">
        <div class="shortcut-row-inner">
          <label>${def.label}</label>
          <div class="shortcut-display">
            ${renderShortcutKeys(settings[def.key])}
          </div>
        </div>
        ${conflict ? `<div class="shortcut-conflict">Conflicts with "${conflict}"</div>` : ''}
      </div>`;
    }
    html += `</div>`;
  }
  return html;
}

function findConflict(key) {
  const val = settings[key];
  if (!val) return null;
  const normalized = normalizeShortcut(val);
  for (const def of shortcutDefs) {
    if (def.key === key) continue;
    if (settings[def.key] && normalizeShortcut(settings[def.key]) === normalized) {
      return def.label;
    }
  }
  return null;
}

function normalizeShortcut(s) {
  if (!s) return "";
  return s.replace(/CmdOrCtrl|Mod/g, "Cmd").toLowerCase();
}

function renderShortcutKeys(shortcut) {
  if (!shortcut) return `<span class="shortcut-keys"><kbd>None</kbd></span>`;
  const display = shortcut
    .replace(/CmdOrCtrl|Mod/g, navigator.platform.includes("Mac") ? "\u2318" : "Ctrl");
  const parts = display.split("+").map((p) => {
    const d = p
      .replace("Shift", "\u21E7")
      .replace("Alt", navigator.platform.includes("Mac") ? "\u2325" : "Alt");
    return `<kbd>${d}</kbd>`;
  });
  return `<span class="shortcut-keys">${parts.join("")}</span>`;
}

// ===== D.R.Y. Tab =====
let drySearchQuery = '';

function renderDryTab() {
  const s = settings;
  const stopwords = s.dryStopwords || DEFAULT_STOPWORDS;
  const filtered = stopwords
    .filter(w => w.includes(drySearchQuery.toLowerCase()))
    .sort();

  return `
    <div class="settings-section">
      <h2>Detection</h2>
      <div class="settings-row">
        <label>Detection range</label>
        <select id="setting-dry-range">
          <option value="paragraph" ${s.dryRange === "paragraph" ? "selected" : ""}>Current paragraph</option>
          <option value="two-paragraphs" ${s.dryRange === "two-paragraphs" ? "selected" : ""}>Two paragraphs</option>
          <option value="document" ${s.dryRange === "document" ? "selected" : ""}>Full document</option>
        </select>
      </div>
      <div class="settings-row">
        <label>Ignore proper nouns</label>
        <input type="checkbox" id="setting-dry-proper-nouns" ${s.dryIgnoreProperNouns ? "checked" : ""} />
      </div>
      <div class="settings-row">
        <label>Include base word repeats</label>
        <input type="checkbox" id="setting-dry-base-words" ${s.dryIncludeBaseWords ? "checked" : ""} />
      </div>
    </div>
    <div class="settings-section">
      <h2>Stopwords</h2>
      <p class="settings-help">Common words to ignore when detecting repeats.</p>
      <div class="dry-add-row">
        <input type="text" id="dry-add-input" placeholder="Add stopword…" />
        <button id="dry-add-btn">Add</button>
      </div>
      <div class="dry-search-row">
        <input type="text" id="dry-search-input" placeholder="Search stopwords…" value="${escAttr(drySearchQuery)}" />
      </div>
      <div class="dry-stopwords-list">
        <div class="dry-stopwords-grid">
          ${filtered.map(word => `
            <div class="dry-stopword-item">
              <span>${escHtml(word)}</span>
              <button class="dry-stopword-remove" data-word="${escAttr(word)}">✕</button>
            </div>
          `).join("")}
        </div>
        <p class="dry-stopwords-count">${filtered.length} stopword${filtered.length !== 1 ? "s" : ""} ${drySearchQuery ? "found" : "total"}</p>
      </div>
      <div class="dry-reset-row">
        <button id="dry-reset-btn" class="dry-reset-button">Reset to defaults</button>
      </div>
    </div>
  `;
}

// ===== Flags Tab =====
function renderFlagsSettingsTab() {
  return renderFlagsTab(settings);
}

// ===== Sync Tab =====
function isIOSSettings() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function renderSyncTab() {
  const folders = settings.syncFolders || [];
  const isIpad = isIOSSettings();

  let html = `<div class="settings-section"><h2>Sync Folders</h2>`;
  html += `<p class="settings-help">Add folders to sync with Hush. Files in synced folders are managed internally with version control.</p>`;

  if (isIpad) {
    // Dropbox token section
    const hasToken = !!settings.dropboxToken;
    html += `
      <div class="settings-section">
        <h3>Dropbox Connection</h3>
        <div class="sync-token-row">
          <input type="password" id="sync-dropbox-token"
            placeholder="Dropbox Personal Access Token"
            value="${escAttr(settings.dropboxToken || "")}" />
          <button id="sync-test-token">${hasToken ? "Re-test" : "Test"}</button>
        </div>
        <div id="sync-token-status" class="sync-status"></div>
      </div>
    `;
  }

  if (folders.length > 0) {
    html += `<div class="sync-folder-list">`;
    for (const f of folders) {
      html += `
        <div class="sync-folder-item" data-folder-id="${f.id}">
          <div class="sync-folder-info">
            <span class="sync-folder-name">${escHtml(f.name)}</span>
            <span class="sync-folder-path">${escHtml(f.path)}</span>
          </div>
          <button class="sync-folder-remove" data-folder-id="${f.id}" title="Remove folder">✕</button>
        </div>`;
    }
    html += `</div>`;
  } else {
    html += `<div class="sync-empty">No folders synced yet.</div>`;
  }

  html += `<button id="sync-add-folder" class="sync-add-btn">Add Folder</button>`;
  html += `</div>`;
  return html;
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

  // Editor tab
  bindSelect("setting-appearance", "appearance");
  bindSelect("setting-light-theme", "lightTheme");
  bindSelect("setting-dark-theme", "darkTheme");
  bindSelect("setting-font-family", "fontFamily");
  bindCheckbox("setting-normalize-headers", "normalizeHeaders");
  bindSlider("setting-footnote-font-size", "footnoteFontSize", "%");
  bindSelect("setting-footnote-font-family", "footnoteFontFamily");
  bindCheckbox("setting-footnote-use-colors", "footnoteUseColors");
  bindSelect("setting-footnote-margin-side", "footnoteMarginSide");
  bindSlider("setting-font-size", "fontSize", "px");
  bindSlider("setting-line-height", "lineHeight", "");

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

  // Sync tab
  const syncAddBtn = document.getElementById("sync-add-folder");
  if (syncAddBtn) {
    syncAddBtn.addEventListener("click", async () => {
      if (isIOSSettings()) {
        // iPad: open Dropbox folder browser
        if (!settings.dropboxToken) {
          alert("Please set up your Dropbox token first.");
          return;
        }
        try {
          const { setToken } = await import("./dropbox.js");
          setToken(settings.dropboxToken);
          const { openDropboxBrowser } = await import("./dropbox-browser.js");
          const result = await openDropboxBrowser();
          if (result) {
            const folders = settings.syncFolders || [];
            const id = crypto.randomUUID();
            const newFolder = { id, path: result.path, syncType: "dropbox", name: result.name };
            folders.push(newFolder);
            saveSetting("syncFolders", folders);
            if (IS_TAURI) {
              const { emit } = await import("@tauri-apps/api/event");
              await emit("sync-folder-added", newFolder);
            }
            render();
          }
        } catch (e) {
          console.error("Dropbox folder selection failed:", e);
          alert("Failed to browse Dropbox: " + e.message);
        }
      } else {
        // Desktop: native folder picker
        if (!IS_TAURI) { alert("Folder selection requires the desktop app."); return; }
        try {
          const { open } = await import("@tauri-apps/plugin-dialog");
          const selected = await open({ directory: true, multiple: false });
          if (selected) {
            const folders = settings.syncFolders || [];
            const name = selected.split(/[\\/]/).filter(Boolean).pop() || "Folder";
            const id = crypto.randomUUID();
            const newFolder = { id, path: selected, syncType: "local", name };
            folders.push(newFolder);
            saveSetting("syncFolders", folders);
            // Notify main window to import the folder contents
            const { emit } = await import("@tauri-apps/api/event");
            await emit("sync-folder-added", newFolder);
            render();
          }
        } catch (e) {
          console.error("Folder selection failed:", e);
        }
      }
    });
  }

  document.querySelectorAll(".sync-folder-remove").forEach(btn => {
    btn.addEventListener("click", async () => {
      const folderId = btn.dataset.folderId;
      settings.syncFolders = (settings.syncFolders || []).filter(f => f.id !== folderId);
      saveSetting("syncFolders", settings.syncFolders);
      // Notify main window to remove the folder from the file tree
      if (IS_TAURI) {
        const { emit } = await import("@tauri-apps/api/event");
        await emit("sync-folder-removed", { id: folderId });
      }
      render();
    });
  });

  const syncTestBtn = document.getElementById("sync-test-token");
  if (syncTestBtn) {
    syncTestBtn.addEventListener("click", async () => {
      const tokenInput = document.getElementById("sync-dropbox-token");
      const status = document.getElementById("sync-token-status");
      if (!tokenInput || !status) return;
      const token = tokenInput.value.trim();
      if (!token) { status.textContent = "Please enter a token."; status.className = "sync-status error"; return; }
      status.textContent = "Testing...";
      status.className = "sync-status";
      try {
        const resp = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (resp.ok) {
          const data = await resp.json();
          status.textContent = `Connected as ${data.name?.display_name || "unknown"}`;
          status.className = "sync-status success";
          saveSetting("dropboxToken", token);
        } else {
          status.textContent = "Invalid token.";
          status.className = "sync-status error";
        }
      } catch (e) {
        status.textContent = "Connection failed.";
        status.className = "sync-status error";
      }
    });
  }

  // Shortcuts tab — click on shortcut-keys to record
  document.querySelectorAll(".shortcut-display .shortcut-keys").forEach(el => {
    el.addEventListener("click", () => {
      // Find the parent row to get the shortcut key
      const wrap = el.closest(".shortcut-row-wrap");
      const idx = Array.from(document.querySelectorAll(".shortcut-row-wrap")).indexOf(wrap);
      if (idx >= 0 && idx < shortcutDefs.length) {
        startShortcutRecording(el, shortcutDefs[idx].key);
      }
    });
  });

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

function bindSlider(id, key, suffix) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("input", () => {
    const val = parseFloat(el.value);
    el.nextElementSibling.textContent = val + suffix;
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

// ===== Helpers =====
function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escAttr(str) {
  return (str || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// Auto-init only when running in the standalone settings window
async function init() {
  const root = document.getElementById("settings-root");
  if (root) await initSettingsInto(root);
}
init().catch(console.error);
