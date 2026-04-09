/**
 * Settings tab rendering functions — extracted from settings-window.js.
 * Each render function accepts a context object { settings, drySearchQuery }.
 */
import { themeList } from "../themes.js";
import { DEFAULT_STOPWORDS } from "../editor/plugins/dry-highlight.js";
import { renderFlagsTab } from "../longview/longview-settings.js";

// Shortcuts organized by category
export const shortcutCategories = [
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
      { key: "shortcutZotero", label: "Zotero search" },
    ],
  },
  {
    name: "Editing",
    shortcuts: [
      { key: "shortcutSelectSentence", label: "Select sentence" },
      { key: "shortcutSelectParagraph", label: "Select paragraph" },
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
export const shortcutDefs = shortcutCategories.flatMap(cat => cat.shortcuts);

// ===== Helpers =====
export function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

export function escAttr(str) {
  return (str || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function normalizeShortcut(s) {
  if (!s) return "";
  return s.replace(/CmdOrCtrl|Mod/g, "Cmd").toLowerCase();
}

export function findConflict(settings, key) {
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

export function isIOSSettings() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

// ===== General Tab =====
export function renderGeneralTab(settings) {
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
      <div class="settings-row">
        <label>Hide sidebar tooltips</label>
        <input type="checkbox" id="setting-hide-sidebar-tooltips" ${s.hideSidebarTooltips ? "checked" : ""} />
      </div>
    </div>
  `;
}

// ===== Editor Tab =====
export function renderEditorTab(settings) {
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
      <div class="settings-row">
        <label>Normalize header color</label>
        <input type="checkbox" id="setting-normalize-header-color" ${s.normalizeHeaderColor ? "checked" : ""} />
      </div>
      <div class="settings-row">
        <label>Sticky headers</label>
        <input type="checkbox" id="setting-sticky-headers" ${s.stickyHeaders ? "checked" : ""} />
      </div>
      <div class="settings-row">
        <label>Block cursor</label>
        <div class="settings-inline-group">
          <input type="checkbox" id="setting-block-cursor" ${s.blockCursor ? "checked" : ""} />
          ${s.blockCursor ? `<input type="color" id="setting-block-cursor-color" value="${s.blockCursorColor || '#888888'}" title="Block cursor color" />
          ${s.blockCursorColor ? `<button class="settings-inline-reset" id="setting-block-cursor-color-reset" title="Reset">&times;</button>` : ''}` : ''}
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h2>Typewriter</h2>
      <div class="settings-slider-row">
        <label>Line opacity</label>
        <div class="slider-group">
          <input type="range" id="setting-typewriter-line-opacity" min="0" max="0.5" step="0.01" value="${s.typewriterLineOpacity ?? 0.08}" />
          <span class="slider-value">${((s.typewriterLineOpacity ?? 0.08) * 100).toFixed(0)}%</span>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h2>Ratchet Mode</h2>
      <div class="settings-row">
        <label>Encourage typing</label>
        <input type="checkbox" id="setting-ratchet-encourage" ${s.ratchetEncourageTyping ? "checked" : ""} />
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
export function renderShortcutsTab(settings) {
  let html = '';
  for (const category of shortcutCategories) {
    html += `<div class="settings-section"><h2>${category.name}</h2>`;
    for (const def of category.shortcuts) {
      const conflict = findConflict(settings, def.key);
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

export function renderShortcutKeys(shortcut) {
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
export function renderDryTab(settings, drySearchQuery) {
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
export function renderFlagsSettingsTab(settings) {
  return renderFlagsTab(settings);
}

// ===== Sync Tab =====
export function renderSyncTab(settings) {
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

// ===== Privacy Tab =====
export function renderPrivacyTab(settings) {
  const s = settings;
  const mode = s.privacyMode || "blackout";
  const hasDummy = !!(s.dummyText && s.dummyText.trim());

  return `
    <div class="settings-section">
      <h2>Privacy Mode Style</h2>
      <p class="settings-help">Choose what happens when you toggle private mode.</p>
      <div class="settings-row">
        <label>Mode</label>
        <select id="setting-privacy-mode">
          <option value="blackout" ${mode === "blackout" ? "selected" : ""}>Blackout (opaque boxes)</option>
          <option value="dummy" ${mode === "dummy" ? "selected" : ""}>Dummy document</option>
        </select>
      </div>
    </div>
    <div class="settings-section">
      <h2>Dummy Document</h2>
      <p class="settings-help">Paste the text of a dummy document below. When dummy mode is active, your writing will appear to be this text instead. Line breaks and formatting are stripped on paste.</p>
      <textarea id="setting-dummy-text" rows="12" placeholder="Paste your dummy document text here... e.g. a boring quarterly report, meeting notes, etc.">${escHtml(s.dummyText || "")}</textarea>
      ${hasDummy ? `<p class="settings-help" style="margin-top: 8px;">${s.dummyText.length.toLocaleString()} characters loaded</p>` : ""}
    </div>
  `;
}

// ===== Zotero Tab =====
export function renderZoteroTab(settings) {
  const s = settings;
  const hasCredentials = s.zoteroApiKey && s.zoteroUserId;
  const hasRefs = s.zoteroReferenceCount > 0;
  return `
    <div class="settings-section">
      <h2>Zotero API</h2>
      <p class="settings-help">
        Enter your Zotero User ID and API Key to connect your library.
        Create an API key at <a href="https://www.zotero.org/settings/keys" target="_blank" style="color: inherit; text-decoration: underline;">zotero.org/settings/keys</a>.
      </p>
      <div class="zotero-credentials">
        <div class="settings-row">
          <label>User ID</label>
          <input type="text" id="zotero-user-id" placeholder="e.g. 12345678" value="${escAttr(s.zoteroUserId || "")}" />
        </div>
        <div class="settings-row">
          <label>API Key</label>
          <input type="password" id="zotero-api-key" placeholder="Zotero API key" value="${escAttr(s.zoteroApiKey || "")}" />
        </div>
        <button id="zotero-test-btn" class="zotero-test-btn">Test Connection</button>
        <div id="zotero-test-status" class="zotero-status"></div>
      </div>
    </div>
    <div class="settings-section">
      <h2>References</h2>
      <div id="zotero-progress" class="zotero-progress" style="display:none;">
        <div class="zotero-progress-bar"><div id="zotero-progress-fill" class="zotero-progress-fill"></div></div>
        <div id="zotero-progress-text" class="zotero-progress-text"></div>
      </div>
      ${hasRefs ? `
        <div class="zotero-ref-info">
          <strong>${s.zoteroReferenceCount}</strong> reference${s.zoteroReferenceCount !== 1 ? "s" : ""}
          ${s.zoteroLastUpdate ? `<br/><span class="zotero-ref-detail">Last updated: ${s.zoteroLastUpdate}</span>` : ""}
          ${s.zoteroFileSize ? `<br/><span class="zotero-ref-detail">File size: ${s.zoteroFileSize}</span>` : ""}
        </div>
      ` : ""}
      <button id="zotero-download-btn" class="zotero-download-btn" ${!hasCredentials ? "disabled" : ""}>
        ${hasRefs ? "Update References" : "Download References"}
      </button>
    </div>
  `;
}
