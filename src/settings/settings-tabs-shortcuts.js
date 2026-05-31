/**
 * Shortcuts settings tab — categories, conflict detection, and the
 * search-filtered render. Extracted from settings-tabs.js. Every entry
 * in `shortcutCategories` must have a matching field in `AppSettings`
 * (Rust) and a handler registered in `editor/editor.js` via
 * `buildCodeMirrorKeymap` so that edits in the settings UI actually
 * take effect.
 */

import { escHtml, escAttr } from "./settings-tabs.js";

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
      { key: "shortcutQuickFind", label: "Quick find (current document)" },
      { key: "shortcutFind", label: "Find / replace (all files)" },
      { key: "shortcutFindNext", label: "Find next match" },
      { key: "shortcutFindPrev", label: "Find previous match" },
      { key: "shortcutZotero", label: "Zotero search" },
      { key: "shortcutSwitchDesks", label: "Switch desks" },
    ],
  },
  {
    name: "Editing",
    shortcuts: [
      { key: "shortcutSelectSentence", label: "Select sentence" },
      { key: "shortcutSelectParagraph", label: "Select paragraph" },
      { key: "shortcutSelectParagraphUp", label: "Select to paragraph above" },
      { key: "shortcutSelectParagraphDown", label: "Select to paragraph below" },
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
      { key: "shortcutNbResetZoom", label: "Reset zoom to 100%" },
    ],
  },
];

// Flat list for conflict detection
export const shortcutDefs = shortcutCategories.flatMap(cat => cat.shortcuts);

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
    if (settings[def.key] && normalizeShortcut(settings[def.key]) === normalized) return def.label;
  }
  return null;
}

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
    .replace(/CmdOrCtrl|Mod/g, navigator.platform.includes("Mac") ? "⌘" : "Ctrl");
  const parts = display.split("+").map((p) => {
    const d = p
      .replace("Shift", "⇧")
      .replace("Alt", navigator.platform.includes("Mac") ? "⌥" : "Alt");
    return `<kbd>${d}</kbd>`;
  });
  return `<span class="shortcut-keys">${parts.join("")}</span>`;
}
