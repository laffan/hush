/**
 * Settings window — runs in a separate Tauri WebviewWindow.
 * Communicates with main window via Tauri events.
 * Tabbed layout: General, Editor, Styles, Shortcuts.
 */
import { themeList } from "./themes.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

let settings = {};
let activeTab = "general";
let editingStyle = null; // style id being edited, or "new" for new style

// All shortcut setting keys and their labels
const shortcutDefs = [
  { key: "shortcutOpenEditor", label: "Toggle editor" },
  { key: "shortcutOpenFullscreen", label: "Open fullscreen" },
  { key: "shortcutTogglePrivate", label: "Toggle private mode" },
  { key: "shortcutToggleSidebar", label: "Toggle sidebar" },
  { key: "shortcutSelectLine", label: "Extend selection by line" },
  { key: "shortcutTypewriter", label: "Toggle typewriter mode" },
  { key: "shortcutNewFile", label: "New file" },
  { key: "shortcutFind", label: "Find / replace" },
  { key: "shortcutFindAll", label: "Find across files" },
  { key: "shortcutSelectNext", label: "Select next instance" },
];

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
  if (!settings.shortcutToggleSidebar) settings.shortcutToggleSidebar = "Mod+/";
  if (!settings.shortcutSelectLine) settings.shortcutSelectLine = "Mod+L";
  if (!settings.shortcutTypewriter) settings.shortcutTypewriter = "Mod+T";
  if (!settings.shortcutNewFile) settings.shortcutNewFile = "Mod+N";
  if (!settings.shortcutFind) settings.shortcutFind = "Mod+F";
  if (!settings.shortcutFindAll) settings.shortcutFindAll = "Mod+Shift+F";
  if (!settings.shortcutSelectNext) settings.shortcutSelectNext = "Mod+D";

  render();
}

function render() {
  document.getElementById("settings-root").innerHTML = `
    <div class="settings-layout">
      <div class="settings-tabs">
        ${tabBtn("general", "General", tabIcons.general)}
        ${tabBtn("editor", "Editor", tabIcons.editor)}
        ${tabBtn("styles", "Styles", tabIcons.styles)}
        ${tabBtn("shortcuts", "Shortcuts", tabIcons.shortcuts)}
      </div>
      <div class="settings-content">
        <div class="settings-panel${activeTab === 'general' ? ' active' : ''}" id="panel-general">
          ${renderGeneralTab()}
        </div>
        <div class="settings-panel${activeTab === 'editor' ? ' active' : ''}" id="panel-editor">
          ${renderEditorTab()}
        </div>
        <div class="settings-panel${activeTab === 'styles' ? ' active' : ''}" id="panel-styles">
          ${renderStylesTab()}
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
  styles: `<svg viewBox="0 0 24 24"><circle cx="13.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="10.5" r="2.5"/><circle cx="8.5" cy="7.5" r="2.5"/><circle cx="6.5" cy="12" r="2.5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>`,
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

// ===== Styles Tab =====
function renderStylesTab() {
  const styles = settings.styles || [];
  const activeId = settings.activeStyleId;

  let html = `<button class="new-style-btn" id="new-style-btn">+ New Style</button>`;
  html += `<div class="style-list">`;

  // Default style (always first, cannot be deleted)
  const isDefault = !activeId;
  html += `<div class="style-item${isDefault ? ' active' : ''}" data-style-id="" style="background: var(--bg); color: var(--fg); font-size: 14px;">
    <span class="style-name">Default</span>
  </div>`;

  for (const st of styles) {
    const isActive = activeId === st.id;
    const bg = st.colorOverrides?.bg || getThemeColor(st.themeId, "bg") || "#1a1a1a";
    const fg = st.colorOverrides?.fg || getThemeColor(st.themeId, "fg") || "#e0e0e0";
    const fontSize = st.fontSize || settings.fontSize || 20;
    html += `<div class="style-item${isActive ? ' active' : ''}" data-style-id="${st.id}" style="background: ${bg}; color: ${fg}; font-size: ${Math.min(fontSize, 18)}px;${st.fontFamily ? ` font-family: '${st.fontFamily}';` : ''}">
      <span class="style-name">${escHtml(st.name)}</span>
      <span class="style-actions">
        <button data-action="edit" title="Edit">&#9998;</button>
        <button data-action="duplicate" title="Duplicate">&#10697;</button>
        <button data-action="delete" title="Delete">&times;</button>
      </span>
    </div>`;
  }

  html += `</div>`;

  // Style editor form
  if (editingStyle !== null) {
    html += renderStyleEditor();
  }

  return html;
}

function getThemeColor(themeId, colorKey) {
  // Map known themes to their bg/fg colors
  const themeColors = {
    dracula: { bg: "#282a36", fg: "#f8f8f2" },
    ayuLight: { bg: "#fafafa", fg: "#575f66" },
    clouds: { bg: "#ffffff", fg: "#000000" },
    noctisLilac: { bg: "#f2f1f8", fg: "#0c006b" },
    rosePineDawn: { bg: "#faf4ed", fg: "#575279" },
    solarizedLight: { bg: "#fdf6e3", fg: "#657b83" },
    smoothy: { bg: "#f4e8e1", fg: "#393e46" },
    amy: { bg: "#200020", fg: "#d0d0ff" },
    barf: { bg: "#1a2b34", fg: "#cdd3de" },
    bespin: { bg: "#28211c", fg: "#9d9b97" },
    birdsOfParadise: { bg: "#3b2627", fg: "#e6e1c4" },
    boysAndGirls: { bg: "#1c1d21", fg: "#e3ceab" },
    cobalt: { bg: "#002240", fg: "#ffffff" },
    coolGlow: { bg: "#060521", fg: "#aaaaaa" },
    espresso: { bg: "#2a211c", fg: "#bdae9d" },
    tomorrow: { bg: "#1d1f21", fg: "#c5c8c6" },
  };
  const colors = themeColors[themeId];
  return colors ? colors[colorKey] : null;
}

function renderStyleEditor() {
  const isNew = editingStyle === "new";
  const style = isNew
    ? { id: "", name: "", themeId: settings.darkTheme || "dracula", fontFamily: null, fontSize: null, lineHeight: null, colorOverrides: {} }
    : settings.styles.find(s => s.id === editingStyle) || {};

  const lightThemes = themeList.filter((t) => t.type === "light");
  const darkThemes = themeList.filter((t) => t.type === "dark");

  const colorKeys = [
    { key: "bg", label: "Background" },
    { key: "fg", label: "Text" },
    { key: "cursor", label: "Cursor" },
  ];

  return `
    <div class="style-editor" id="style-editor">
      <h3>${isNew ? "New Style" : "Edit Style"}</h3>
      <div class="settings-row">
        <label>Name</label>
        <input type="text" id="style-name" value="${escAttr(style.name)}" placeholder="Style name" />
      </div>
      <div class="settings-row">
        <label>Base theme</label>
        <select id="style-theme">
          <optgroup label="Light">
            ${lightThemes.map(t => `<option value="${t.id}" ${style.themeId === t.id ? "selected" : ""}>${t.name}</option>`).join("")}
          </optgroup>
          <optgroup label="Dark">
            ${darkThemes.map(t => `<option value="${t.id}" ${style.themeId === t.id ? "selected" : ""}>${t.name}</option>`).join("")}
          </optgroup>
        </select>
      </div>
      <div class="settings-row">
        <label>Font</label>
        <select id="style-font">
          <option value="">Default (${settings.fontFamily || "EB Garamond"})</option>
          ${renderFontOptions(style.fontFamily || "")}
        </select>
      </div>
      <div class="settings-slider-row">
        <label>Font size</label>
        <div class="slider-group">
          <input type="range" id="style-font-size" min="12" max="36" step="1" value="${style.fontSize || settings.fontSize || 20}" />
          <span class="slider-value">${style.fontSize || settings.fontSize || 20}px</span>
        </div>
      </div>
      <div class="settings-slider-row">
        <label>Line height</label>
        <div class="slider-group">
          <input type="range" id="style-line-height" min="1.0" max="2.5" step="0.1" value="${style.lineHeight || settings.lineHeight || 1.6}" />
          <span class="slider-value">${style.lineHeight || settings.lineHeight || 1.6}</span>
        </div>
      </div>

      <h3>Color Overrides</h3>
      ${colorKeys.map(ck => {
        const overrideVal = (style.colorOverrides || {})[ck.key];
        const themeDefault = getThemeColor(style.themeId, ck.key) || "#888888";
        const val = overrideVal || themeDefault;
        return `<div class="color-override-row">
          <label>${ck.label}</label>
          <div class="color-group">
            <input type="color" data-color-key="${ck.key}" value="${val}" />
            ${overrideVal ? `<button class="reset-color" data-color-key="${ck.key}" title="Reset to theme default">&times;</button>` : ''}
          </div>
        </div>`;
      }).join("")}

      <div class="style-editor-actions">
        <button id="style-cancel">Cancel</button>
        <button id="style-save" class="primary">${isNew ? "Create" : "Save"}</button>
      </div>
    </div>
  `;
}

// ===== Shortcuts Tab =====
function renderShortcutsTab() {
  let html = `<div class="settings-section"><h2>Keyboard Shortcuts</h2>`;
  for (const def of shortcutDefs) {
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
      editingStyle = null;
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

  // Styles tab
  bindStylesTab();
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

function bindStylesTab() {
  // New style button
  const newBtn = document.getElementById("new-style-btn");
  if (newBtn) {
    newBtn.addEventListener("click", () => {
      editingStyle = "new";
      render();
    });
  }

  // Style item clicks (activate style)
  document.querySelectorAll(".style-item").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".style-actions")) return;
      const id = el.dataset.styleId;
      saveSetting("activeStyleId", id || null);
      render();
    });
  });

  // Style action buttons
  document.querySelectorAll(".style-actions button").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = btn.closest(".style-item");
      const id = item.dataset.styleId;
      const action = btn.dataset.action;
      if (action === "edit") {
        editingStyle = id;
        render();
      } else if (action === "duplicate") {
        duplicateStyle(id);
      } else if (action === "delete") {
        deleteStyle(id);
      }
    });
  });

  // Style editor bindings
  bindStyleEditor();
}

function bindStyleEditor() {
  const cancelBtn = document.getElementById("style-cancel");
  const saveBtn = document.getElementById("style-save");
  if (!cancelBtn) return;

  cancelBtn.addEventListener("click", () => {
    editingStyle = null;
    render();
  });

  saveBtn.addEventListener("click", () => {
    saveStyle();
  });

  // Font size slider in style editor
  const fsEl = document.getElementById("style-font-size");
  if (fsEl) {
    fsEl.addEventListener("input", () => {
      fsEl.nextElementSibling.textContent = fsEl.value + "px";
    });
  }
  const lhEl = document.getElementById("style-line-height");
  if (lhEl) {
    lhEl.addEventListener("input", () => {
      lhEl.nextElementSibling.textContent = lhEl.value;
    });
  }

  // Color reset buttons
  document.querySelectorAll(".reset-color").forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.colorKey;
      const style = settings.styles.find(s => s.id === editingStyle);
      if (style && style.colorOverrides) {
        delete style.colorOverrides[key];
        render();
      }
    });
  });
}

function saveStyle() {
  const name = document.getElementById("style-name")?.value?.trim();
  if (!name) return;

  const themeId = document.getElementById("style-theme")?.value;
  const fontFamily = document.getElementById("style-font")?.value || null;
  const fontSize = parseFloat(document.getElementById("style-font-size")?.value) || null;
  const lineHeight = parseFloat(document.getElementById("style-line-height")?.value) || null;

  // Gather color overrides
  const colorOverrides = {};
  document.querySelectorAll(".color-override-row input[type='color']").forEach(input => {
    const key = input.dataset.colorKey;
    const themeDefault = getThemeColor(themeId, key);
    if (input.value !== themeDefault) {
      colorOverrides[key] = input.value;
    }
  });

  if (!settings.styles) settings.styles = [];

  if (editingStyle === "new") {
    const id = "style_" + Date.now();
    settings.styles.push({ id, name, themeId, fontFamily, fontSize, lineHeight, colorOverrides });
  } else {
    const style = settings.styles.find(s => s.id === editingStyle);
    if (style) {
      Object.assign(style, { name, themeId, fontFamily, fontSize, lineHeight, colorOverrides });
    }
  }

  editingStyle = null;
  saveSetting("styles", settings.styles);
  render();
}

function duplicateStyle(id) {
  const source = settings.styles.find(s => s.id === id);
  if (!source) return;
  const newStyle = {
    ...JSON.parse(JSON.stringify(source)),
    id: "style_" + Date.now(),
    name: source.name + " copy",
  };
  settings.styles.push(newStyle);
  saveSetting("styles", settings.styles);
  render();
}

function deleteStyle(id) {
  settings.styles = settings.styles.filter(s => s.id !== id);
  if (settings.activeStyleId === id) {
    settings.activeStyleId = null;
    saveSetting("activeStyleId", null);
  }
  saveSetting("styles", settings.styles);
  render();
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
