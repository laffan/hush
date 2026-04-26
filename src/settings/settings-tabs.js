/**
 * Settings tab rendering functions — extracted from settings-window.js.
 * Each render function accepts a context object { settings, drySearchQuery }.
 */
import { themeList } from "../themes.js";
import { DEFAULT_STOPWORDS } from "../editor/plugins/dry-highlight.js";
import { renderFlagsTab } from "../longview/longview-settings.js";

// Shortcuts organized by category.  This list is the exhaustive inventory
// of every user-customizable shortcut in the app — every entry here must
// have a matching field in `AppSettings` (Rust) and a handler registered
// in `editor/editor.js` via `buildCodeMirrorKeymap` so that edits in the
// settings UI actually take effect.
export const shortcutCategories = [
  {
    name: "General",
    shortcuts: [
      { key: "shortcutOpenEditor", label: "Toggle editor" },
      { key: "shortcutOpenFullscreen", label: "Open fullscreen" },
      { key: "shortcutTogglePrivate", label: "Toggle private mode" },
      { key: "shortcutToggleSidebar", label: "Toggle sidebar" },
      { key: "shortcutToggleOutline", label: "Toggle right sidebar (outline / shelf)" },
      { key: "shortcutTypewriter", label: "Toggle typewriter mode" },
      { key: "shortcutToggleDry", label: "Toggle D.R.Y. highlighting" },
      { key: "shortcutToggleFocus", label: "Toggle focus mode" },
      { key: "shortcutZenFocus", label: "Toggle Zen Focus" },
      { key: "shortcutToggleWordCount", label: "Toggle word count" },
      { key: "shortcutNewFile", label: "New file" },
      { key: "shortcutSave", label: "Save file" },
      { key: "shortcutFind", label: "Find / replace" },
      { key: "shortcutFindAll", label: "Find across files" },
      { key: "shortcutFindNext", label: "Find next match" },
      { key: "shortcutFindPrev", label: "Find previous match" },
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
      { key: "shortcutSelectPrevious", label: "Select previous instance" },
      { key: "shortcutJumpNextSentence", label: "Jump to next sentence" },
      { key: "shortcutJumpPrevSentence", label: "Jump to previous sentence" },
      { key: "shortcutJumpNextParagraph", label: "Jump to next paragraph" },
      { key: "shortcutJumpPrevParagraph", label: "Jump to previous paragraph" },
      { key: "shortcutNextSentence", label: "Shift selection to next sentence" },
      { key: "shortcutPrevSentence", label: "Shift selection to previous sentence" },
      { key: "shortcutMoveSentenceForward", label: "Move sentence forward" },
      { key: "shortcutMoveSentenceBack", label: "Move sentence back" },
      { key: "shortcutDeleteToSentenceEnd", label: "Delete to sentence end" },
      { key: "shortcutJoinLines", label: "Join lines (pull up)" },
    ],
  },
  {
    name: "Styles",
    shortcuts: [
      { key: "shortcutStyleDefault", label: "Switch to Default style" },
      { key: "shortcutStyle1", label: "Switch to style 1" },
      { key: "shortcutStyle2", label: "Switch to style 2" },
      { key: "shortcutStyle3", label: "Switch to style 3" },
      { key: "shortcutStyle4", label: "Switch to style 4" },
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
  {
    name: "Notebooks",
    shortcuts: [
      { key: "shortcutNbSelect", label: "Select tool" },
      { key: "shortcutNbText", label: "Text tool" },
      { key: "shortcutNbDragArea", label: "Drag Area tool" },
      { key: "shortcutNbBrainstorm", label: "Toggle Brainstorm" },
      { key: "shortcutNbDelete", label: "Delete selected" },
      { key: "shortcutNbUndo", label: "Undo" },
      { key: "shortcutNbRedo", label: "Redo" },
      { key: "shortcutNbGroup", label: "Group shapes" },
      { key: "shortcutNbUngroup", label: "Ungroup shapes" },
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
        <label>Show tooltips</label>
        <input type="checkbox" id="setting-show-tooltips" ${s.showTooltips ? "checked" : ""} />
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
      <p class="settings-help">Theme, font, size and header options live in the Styles sidebar — edit the Default style to change these defaults.</p>
    </div>

    <div class="settings-section">
      <h2>Headers</h2>
      <div class="settings-row">
        <label>Sticky headers</label>
        <input type="checkbox" id="setting-sticky-headers" ${s.stickyHeaders ? "checked" : ""} />
      </div>
    </div>

    <div class="settings-section">
      <h2>Panes</h2>
      <div class="settings-row">
        <label>Make space for panes</label>
        <input type="checkbox" id="setting-make-space-for-panes" ${s.makeSpaceForPanes !== false ? "checked" : ""} />
      </div>
      <p class="settings-help">When a document pane is open, shift the edit column to the right, leaving space on the left for panes.</p>
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
      <h2>Focus mode</h2>
      <div class="settings-slider-row">
        <label>Dimmed opacity</label>
        <div class="slider-group">
          <input type="range" id="setting-focus-mode-opacity" min="0" max="1" step="0.05" value="${s.focusModeOpacity ?? 0.5}" />
          <span class="slider-value">${((s.focusModeOpacity ?? 0.5) * 100).toFixed(0)}%</span>
        </div>
      </div>
      <p class="settings-help">When focus mode is on, text outside the current sentence and any open panes fade to this opacity.</p>
    </div>

    <div class="settings-section">
      <h2>Zen Focus</h2>
      <div class="settings-slider-row">
        <label>Font size</label>
        <div class="slider-group">
          <input type="range" id="setting-zen-focus-font-size" min="18" max="72" step="1" value="${s.zenFocusFontSize || 30}" />
          <span class="slider-value">${s.zenFocusFontSize || 30}px</span>
        </div>
      </div>
      <p class="settings-help">Font size used while Zen Focus is open (toggle with the configured shortcut, default ⌘⇧S).</p>
    </div>

    <div class="settings-section">
      <h2>Notebook text</h2>
      <div class="settings-slider-row">
        <label>Max width</label>
        <div class="slider-group">
          <input type="range" id="setting-notebook-text-max-width" min="200" max="800" step="10" value="${s.notebookTextMaxWidth || 350}" />
          <span class="slider-value">${s.notebookTextMaxWidth || 350}px</span>
        </div>
      </div>
      <p class="settings-help">Width cap for new text shapes and brainstorm cards on the notebook canvas. Existing shapes you've manually resized aren't affected.</p>
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
    { name: "iA Writer Duo", family: "iA Writer Duo" },
    { name: "iA Writer Mono", family: "iA Writer Mono" },
    { name: "iA Writer Quattro", family: "iA Writer Quattro" },
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
export function renderShortcutsTab(settings, searchQuery = "") {
  const q = (searchQuery || "").trim().toLowerCase();

  // Collect all shortcuts with conflict + category info
  const all = [];
  for (const category of shortcutCategories) {
    for (const def of category.shortcuts) {
      all.push({
        ...def,
        categoryName: category.name,
        conflict: findConflict(settings, def.key),
      });
    }
  }

  const matchesQuery = (item) => {
    if (!q) return true;
    if (item.label.toLowerCase().includes(q)) return true;
    const val = settings[item.key];
    if (val && val.toLowerCase().includes(q)) return true;
    return false;
  };

  const conflictItems = all.filter((s) => s.conflict);
  const conflictKeys = new Set(conflictItems.map((s) => s.key));

  let html = `
    <div class="settings-section shortcut-search-section">
      <div class="shortcut-search-row">
        <input type="text" id="shortcut-search-input" placeholder="Search shortcuts…" value="${escAttr(searchQuery)}" autocomplete="off" spellcheck="false" />
      </div>
    </div>
  `;

  // Pinned conflicts — always visible at the top when any exist.
  if (conflictItems.length > 0) {
    html += `<div class="settings-section shortcut-conflicts-section"><h2>Conflicts</h2>`;
    for (const item of conflictItems) {
      html += renderShortcutRow(settings, item, q, item.categoryName);
    }
    html += `</div>`;
  }

  // Regular categories — exclude items already shown in the Conflicts section
  // and filter by search query.
  let anyMatches = false;
  for (const category of shortcutCategories) {
    const items = category.shortcuts
      .filter((def) => !conflictKeys.has(def.key))
      .map((def) => ({ ...def, conflict: null }))
      .filter(matchesQuery);
    if (items.length === 0) continue;
    anyMatches = true;
    html += `<div class="settings-section"><h2>${category.name}</h2>`;
    for (const item of items) {
      html += renderShortcutRow(settings, item, q);
    }
    html += `</div>`;
  }

  if (q && !anyMatches && conflictItems.filter(matchesQuery).length === 0) {
    html += `<div class="settings-section"><p class="settings-help">No shortcuts match "${escHtml(searchQuery)}".</p></div>`;
  }

  return html;
}

function renderShortcutRow(settings, def, query, categoryLabel) {
  const labelHtml = highlightMatch(def.label, query);
  const categoryTag = categoryLabel
    ? ` <span class="shortcut-category-tag">${escHtml(categoryLabel)}</span>`
    : "";
  return `<div class="shortcut-row-wrap" data-shortcut-key="${escAttr(def.key)}">
    <div class="shortcut-row-inner">
      <label>${labelHtml}${categoryTag}</label>
      <div class="shortcut-display">
        ${renderShortcutKeys(settings[def.key])}
      </div>
    </div>
    ${def.conflict ? `<div class="shortcut-conflict">Conflicts with "${escHtml(def.conflict)}"</div>` : ""}
  </div>`;
}

function highlightMatch(text, query) {
  if (!query) return escHtml(text);
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query);
  if (idx < 0) return escHtml(text);
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);
  return `${escHtml(before)}<mark class="shortcut-search-hit">${escHtml(match)}</mark>${escHtml(after)}`;
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
    `;
  }

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
                <button class="local-sync-remove-btn" data-id="${escAttr(f.id)}">Remove</button>
              </div>
            `).join("")}
      </div>
      <button id="local-sync-add" class="sync-action-btn">Add folder</button>
    </div>
  `;

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
