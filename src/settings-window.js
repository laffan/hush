/**
 * Settings window — runs in a separate Tauri WebviewWindow.
 * Communicates with main window via Tauri events.
 * Tabbed layout: General, Editor, Styles, Shortcuts.
 */
import { themeList } from "./themes.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

let settings = {};
let activeTab = "general";

// Shortcuts organized by category
const shortcutCategories = [
  {
    name: "General",
    shortcuts: [
      { key: "shortcutOpenEditor", label: "Toggle editor" },
      { key: "shortcutOpenFullscreen", label: "Open fullscreen" },
      { key: "shortcutTogglePrivate", label: "Toggle private mode" },
      { key: "shortcutToggleSidebar", label: "Toggle sidebar" },
      { key: "shortcutTypewriter", label: "Toggle typewriter mode" },
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
      { key: "shortcutNextSentence", label: "Next sentence" },
      { key: "shortcutPrevSentence", label: "Previous sentence" },
      { key: "shortcutMoveSentenceForward", label: "Move sentence forward" },
      { key: "shortcutMoveSentenceBack", label: "Move sentence back" },
      { key: "shortcutSelectToSentenceEnd", label: "Select to sentence end" },
      { key: "shortcutSelectToSentenceStart", label: "Select to sentence start" },
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
    ],
  },
];

// Flat list for conflict detection
const shortcutDefs = shortcutCategories.flatMap(cat => cat.shortcuts);

async function init() {
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
  if (!settings.shortcutToggleSidebar) settings.shortcutToggleSidebar = "Mod+\\";
  if (!settings.shortcutTypewriter) settings.shortcutTypewriter = "Mod+T";
  if (!settings.shortcutNewFile) settings.shortcutNewFile = "Mod+N";
  if (!settings.shortcutFind) settings.shortcutFind = "Mod+F";
  if (!settings.shortcutFindAll) settings.shortcutFindAll = "Mod+Shift+F";
  if (!settings.shortcutSelectSentence) settings.shortcutSelectSentence = "Mod+L";
  if (!settings.shortcutReduceSentence) settings.shortcutReduceSentence = "Mod+Shift+L";
  if (!settings.shortcutSelectNext) settings.shortcutSelectNext = "Mod+D";
  if (!settings.shortcutNextSentence) settings.shortcutNextSentence = "Mod+Shift+ArrowRight";
  if (!settings.shortcutPrevSentence) settings.shortcutPrevSentence = "Mod+Shift+ArrowLeft";
  if (!settings.shortcutMoveSentenceForward) settings.shortcutMoveSentenceForward = "Alt+Mod+ArrowRight";
  if (!settings.shortcutMoveSentenceBack) settings.shortcutMoveSentenceBack = "Alt+Mod+ArrowLeft";
  if (!settings.shortcutSelectToSentenceEnd) settings.shortcutSelectToSentenceEnd = "Alt+Shift+.";
  if (!settings.shortcutSelectToSentenceStart) settings.shortcutSelectToSentenceStart = "Alt+Shift+,";
  if (!settings.shortcutDeleteToSentenceEnd) settings.shortcutDeleteToSentenceEnd = "Alt+Shift+Backspace";
  if (!settings.shortcutBold) settings.shortcutBold = "Mod+B";
  if (!settings.shortcutItalic) settings.shortcutItalic = "Mod+I";
  if (!settings.shortcutHighlight) settings.shortcutHighlight = "Mod+=";
  if (!settings.shortcutComment) settings.shortcutComment = "Mod+/";

  render();
}

function render() {
  document.getElementById("settings-root").innerHTML = `
    <div class="settings-layout">
      <div class="settings-tabs">
        ${tabBtn("general", "General", tabIcons.general)}
        ${tabBtn("editor", "Editor", tabIcons.editor)}
        ${tabBtn("shortcuts", "Shortcuts", tabIcons.shortcuts)}
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
      </div>
    </div>
  `;

  bindAll();
}

const tabIcons = {
  general: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`,
  editor: `<svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  shortcuts: `<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="8" x2="6" y2="8"/><line x1="10" y1="8" x2="10" y2="8"/><line x1="14" y1="8" x2="14" y2="8"/><line x1="18" y1="8" x2="18" y2="8"/><line x1="6" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="18" y2="12"/><line x1="8" y1="16" x2="16" y2="16"/></svg>`,
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
    "Gill Sans", "Helvetica", "Helvetica Neue", "Hoefler Text",
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
  bindSlider("setting-font-size", "fontSize", "px");
  bindSlider("setting-line-height", "lineHeight", "");

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
    const { emit } = await import("@tauri-apps/api/event");
    await emit("settings-updated", settings);
  } else {
    localStorage.setItem("hush_settings", JSON.stringify(settings));
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

init().catch(console.error);
