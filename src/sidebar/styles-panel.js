/**
 * Styles panel — create, edit, preview, and switch between named style presets.
 *
 * Editing uses a two-column modal: settings on the left, live preview on the
 * right.  Color overrides are split into Light / Dark tabs so every style can
 * carry both palettes.
 */

import { themeList, getThemeById } from "../themes.js";
import { parseShortcut } from "../shortcuts.js";

// ── helpers ────────────────────────────────────────────────────────────────────
function escAttr(str) {
  return (str || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/** Format a shortcut string for inline display (e.g. "Mod+1" → "⌘1"). */
function formatShortcutBadge(raw) {
  const p = parseShortcut(raw);
  if (!p) return "";
  const isMac = navigator.platform?.includes("Mac") || navigator.userAgent?.includes("Mac");
  const parts = [];
  if (p.mod) parts.push(isMac ? "\u2318" : "Ctrl+");
  if (p.shift) parts.push(isMac ? "\u21e7" : "Shift+");
  if (p.alt) parts.push(isMac ? "\u2325" : "Alt+");
  parts.push(p.key.length === 1 ? p.key.toUpperCase() : p.key);
  return parts.join("");
}

/** Migrate old single-mode styles to dual light/dark format. */
function migrateStyle(st) {
  if (!st._migrated && st.themeId && !st.lightThemeId && !st.darkThemeId) {
    const theme = getThemeById(st.themeId);
    if (theme) {
      if (theme.type === "dark") { st.darkThemeId = st.themeId; st.darkColors = st.colorOverrides || {}; }
      else { st.lightThemeId = st.themeId; st.lightColors = st.colorOverrides || {}; }
    }
    delete st.themeId;
    delete st.colorOverrides;
    st._migrated = true;
  }
  if (!st.lightThemeId) st.lightThemeId = "";
  if (!st.darkThemeId) st.darkThemeId = "";
  if (!st.lightColors) st.lightColors = {};
  if (!st.darkColors) st.darkColors = {};
  return st;
}

/** Get the appearance-appropriate theme/colors from a style. */
export function resolveStyleForAppearance(style, appearance) {
  const s = migrateStyle(style);
  let mode = appearance || "dark";
  if (mode === "auto") mode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return {
    themeId: mode === "dark" ? s.darkThemeId : s.lightThemeId,
    colors: mode === "dark" ? (s.darkColors || {}) : (s.lightColors || {}),
  };
}

// ── theme color maps ───────────────────────────────────────────────────────────
const themeBackgrounds = {
  dracula: "#2d2f3f", ayuLight: "#fcfcfc", clouds: "#ffffff",
  noctisLilac: "#f2f1f8", rosePineDawn: "#faf4ed", solarizedLight: "#fef7e5",
  smoothy: "#ffffff", amy: "#200020", barf: "#15191e", bespin: "#2e241d",
  birdsOfParadise: "#3b2627", boysAndGirls: "#000205", cobalt: "#00254b",
  coolGlow: "#060521", espresso: "#ffffff", tomorrow: "#ffffff",
};

const themeForegrounds = {
  dracula: "#f8f8f2", ayuLight: "#5c6166", clouds: "#000000",
  noctisLilac: "#4a4a6a", rosePineDawn: "#575279", solarizedLight: "#657b83",
  smoothy: "#333333", amy: "#d0d0ff", barf: "#d4d4d4", bespin: "#baae9e",
  birdsOfParadise: "#e6e1c4", boysAndGirls: "#e0e0e0", cobalt: "#e1efff",
  coolGlow: "#aebbc5", espresso: "#535353", tomorrow: "#4d4d4c",
};

// ── lorem ipsum preview text ───────────────────────────────────────────────────
const PREVIEW_MD = `# The Art of Writing

## Finding Your Voice

Every writer begins with a blank page and a spark of intention. The words that follow are shaped by years of reading, thinking, and living.

### On Simplicity

Good prose is like a window pane — clear, direct, and invisible. **Bold ideas** need not hide behind *ornate language*. Strip away the excess until only the essential remains.

> "Write drunk, edit sober." — Ernest Hemingway

The best sentences carry weight without effort, landing softly in the reader's mind. ~~Perfection~~ is not the goal — clarity is.`;

// ── sidebar list ───────────────────────────────────────────────────────────────
export function renderStylesPanel(state) {
  const styles = state.settings.styles || [];
  const activeId = state.settings.activeStyleId;
  const lockedId = getLockedStyleId(state);
  const isLocked = !!lockedId;

  let html = `<button class="new-style-sidebar-btn" id="new-style-btn">+ New Style</button>`;

  // Lock toggle — always visible, above the style list
  html += `<div class="style-lock-toggle">
    <label class="style-lock-label">
      <span class="style-lock-text">Lock Style to Document</span>
      <span class="style-lock-switch${isLocked ? ' active' : ''}" id="style-lock-switch">
        <span class="style-lock-knob"></span>
      </span>
    </label>
  </div>`;

  html += `<div class="style-list-sidebar">`;

  // Shortcut setting keys for style slots (Default + first 4 styles)
  const styleShortcutKeys = ["shortcutStyleDefault", "shortcutStyle1", "shortcutStyle2", "shortcutStyle3", "shortcutStyle4"];

  const isDefault = !activeId;
  const defaultBadge = formatShortcutBadge(state.settings[styleShortcutKeys[0]]);
  html += `<div class="style-sidebar-item${isDefault ? ' active' : ''}" data-style-id="">
    <span class="style-sidebar-name" style="font-size:14px;">Default</span>
    ${defaultBadge ? `<span class="style-shortcut-badge">${escHtml(defaultBadge)}</span>` : ""}
    <span class="style-sidebar-actions">
      <button data-action="edit" data-id="__default__" title="Edit">
        <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
    </span>
  </div>`;

  for (let i = 0; i < styles.length; i++) {
    const st = styles[i];
    migrateStyle(st);
    const isActive = activeId === st.id;
    const appearance = state.settings.appearance || "dark";
    const { themeId, colors } = resolveStyleForAppearance(st, appearance);
    const bg = colors.bg || themeBackgrounds[themeId] || (appearance === "light" ? "#fafafa" : "#1a1a1a");
    const fg = colors.fg || themeForegrounds[themeId] || (appearance === "light" ? "#1a1a1a" : "#e0e0e0");
    const fontSize = st.fontSize || state.settings.fontSize || 20;
    const badge = i < 4 ? formatShortcutBadge(state.settings[styleShortcutKeys[i + 1]]) : "";
    html += `<div class="style-sidebar-item${isActive ? ' active' : ''}" data-style-id="${st.id}"
      style="background:${bg}; color:${fg}; font-size:${Math.min(fontSize, 16)}px;${st.fontFamily ? ` font-family:'${st.fontFamily}';` : ''}">
      <span class="style-sidebar-name">${escHtml(st.name)}</span>
      ${badge ? `<span class="style-shortcut-badge">${escHtml(badge)}</span>` : ""}
      <span class="style-sidebar-actions">
        <button data-action="edit" data-id="${st.id}" title="Edit">
          <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button data-action="duplicate" data-id="${st.id}" title="Duplicate">
          <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button data-action="delete" data-id="${st.id}" title="Delete">
          <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </span>
    </div>`;
  }

  html += `</div>`;

  return html;
}

/** Check if the current document has a locked style. */
export function getLockedStyleId(state) {
  if (!state.currentFileId || !state.fileTree) return null;
  function search(nodes) {
    for (const n of nodes) {
      if (n.fileId === state.currentFileId) return n.lockedStyleId || null;
      if (n.children) { const r = search(n.children); if (r) return r; }
    }
    return null;
  }
  return search(state.fileTree);
}

/** Set or clear the locked style on the current document's tree node. */
async function setLockedStyleId(state, styleId) {
  if (!state.currentFileId || !state.fileTree) return;
  function search(nodes) {
    for (const n of nodes) {
      if (n.fileId === state.currentFileId) { n.lockedStyleId = styleId || undefined; return true; }
      if (n.children && search(n.children)) return true;
    }
    return false;
  }
  if (search(state.fileTree)) {
    await state.saveFileTree();
    state.emit("files-changed");
  }
}

export function bindStylesPanel(state, panel) {
  const newBtn = panel.querySelector("#new-style-btn");
  if (newBtn) {
    newBtn.addEventListener("click", () => openStyleModal(state, null, () => {
      panel.innerHTML = renderStylesPanel(state);
      bindStylesPanel(state, panel);
    }));
  }

  panel.querySelectorAll(".style-sidebar-item").forEach(el => {
    el.addEventListener("click", async (e) => {
      if (e.target.closest(".style-sidebar-actions")) return;
      const id = el.dataset.styleId;
      const lockedId = getLockedStyleId(state);
      if (lockedId) {
        // Lock is ON — change active style and update the lock to match
        state.updateSettings({ activeStyleId: id || null });
        await setLockedStyleId(state, id || null);
      } else {
        state.updateSettings({ activeStyleId: id || null, globalStyleId: id || null });
      }
      state.emit("style-changed");
      panel.innerHTML = renderStylesPanel(state);
      bindStylesPanel(state, panel);
    });

    el.addEventListener("mouseenter", () => {
      const id = el.dataset.styleId;
      if (!id) { state.emit("style-preview-end"); return; }
      const style = (state.settings.styles || []).find(s => s.id === id);
      if (style) {
        const { themeId, colors } = resolveStyleForAppearance(style, state.settings.appearance);
        state.emit("style-preview", { ...style, themeId, colorOverrides: colors });
      }
    });

    el.addEventListener("mouseleave", () => {
      state.emit("style-preview-end");
    });
  });

  // Lock toggle — always visible; toggles lock for the current document
  const lockSwitch = panel.querySelector("#style-lock-switch");
  if (lockSwitch) {
    lockSwitch.addEventListener("click", async () => {
      const lockedId = getLockedStyleId(state);
      if (lockedId) {
        // Turn OFF — clear the lock
        await setLockedStyleId(state, null);
      } else {
        // Turn ON — lock the currently active style (even if null/default)
        const activeId = state.settings.activeStyleId || null;
        await setLockedStyleId(state, activeId || "__default__");
      }
      panel.innerHTML = renderStylesPanel(state);
      bindStylesPanel(state, panel);
    });
  }

  panel.querySelectorAll(".style-sidebar-actions button").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const id = btn.dataset.id;

      if (action === "edit") {
        if (id === "__default__") {
          openStyleModal(state, "__default__", () => {
            panel.innerHTML = renderStylesPanel(state);
            bindStylesPanel(state, panel);
          });
          return;
        }
        const style = (state.settings.styles || []).find(s => s.id === id);
        if (style) openStyleModal(state, style, () => {
          panel.innerHTML = renderStylesPanel(state);
          bindStylesPanel(state, panel);
        });
      } else if (action === "duplicate") {
        const source = (state.settings.styles || []).find(s => s.id === id);
        if (source) {
          const newStyle = { ...JSON.parse(JSON.stringify(source)), id: "style_" + Date.now(), name: source.name + " copy" };
          const styles = [...(state.settings.styles || []), newStyle];
          state.updateSettings({ styles });
          panel.innerHTML = renderStylesPanel(state);
          bindStylesPanel(state, panel);
        }
      } else if (action === "delete") {
        const styles = (state.settings.styles || []).filter(s => s.id !== id);
        const updates = { styles };
        if (state.settings.activeStyleId === id) updates.activeStyleId = null;
        if (state.settings.globalStyleId === id) updates.globalStyleId = null;
        state.updateSettings(updates);
        state.emit("style-changed");
        panel.innerHTML = renderStylesPanel(state);
        bindStylesPanel(state, panel);
      }
    });
  });
}

// ── two-column editor modal ────────────────────────────────────────────────────
const lightThemes = themeList.filter(t => t.type === "light");
const darkThemes = themeList.filter(t => t.type === "dark");
const builtInFonts = ["Source Sans Pro", "Source Serif Pro", "Libre Franklin", "Libre Baskerville", "Karla", "Lora", "EB Garamond", "Inter", "Fira Code", "iA Writer Duo", "iA Writer Mono", "iA Writer Quattro"];
const systemFonts = [
  "Arial", "Avenir", "Avenir Next", "Baskerville", "Courier New",
  "Futura", "Garamond", "Georgia", "Gill Sans", "Helvetica",
  "Helvetica Neue", "Lucida Grande", "Menlo", "Monaco", "Optima",
  "Palatino", "SF Mono", "SF Pro", "Times New Roman", "Verdana",
];
const colorKeys = [
  { key: "bg", label: "Background" },
  { key: "fg", label: "Text" },
  { key: "header", label: "Header" },
  { key: "cursor", label: "Cursor" },
  { key: "selection", label: "Selection" },
];

function fontFallback(family) {
  const map = {
    "Helvetica": "'Helvetica Neue', 'Helvetica', 'Arial', sans-serif",
    "EB Garamond": "'EB Garamond', 'Georgia', 'Times New Roman', serif",
    "Inter": "'Inter', system-ui, -apple-system, sans-serif",
    "Fira Code": "'Fira Code', 'Fira Mono', 'Consolas', monospace",
    "Source Sans Pro": "'Source Sans Pro', 'Helvetica Neue', 'Arial', sans-serif",
    "Source Serif Pro": "'Source Serif Pro', 'Georgia', 'Times New Roman', serif",
    "Libre Franklin": "'Libre Franklin', 'Helvetica Neue', 'Arial', sans-serif",
    "Libre Baskerville": "'Libre Baskerville', 'Georgia', 'Times New Roman', serif",
    "Karla": "'Karla', 'Helvetica Neue', 'Arial', sans-serif",
    "Lora": "'Lora', 'Georgia', 'Times New Roman', serif",
    "iA Writer Duo": "'iA Writer Duo', 'Menlo', 'Consolas', monospace",
    "iA Writer Mono": "'iA Writer Mono', 'Menlo', 'Consolas', monospace",
    "iA Writer Quattro": "'iA Writer Quattro', 'Helvetica Neue', 'Arial', sans-serif",
  };
  return map[family] || `'${family}', system-ui, sans-serif`;
}

/** Build a Style-shaped draft from global AppSettings — used when editing the Default style. */
function buildDefaultDraftFromSettings(state) {
  const s = state.settings;
  return {
    id: "__default__",
    name: "Default",
    fontFamily: s.fontFamily || null,
    fontSize: s.fontSize || null,
    lineHeight: s.lineHeight || null,
    lightThemeId: s.lightTheme || "ayuLight",
    darkThemeId: s.darkTheme || "dracula",
    lightColors: s.defaultLightColors ? { ...s.defaultLightColors } : {},
    darkColors: s.defaultDarkColors ? { ...s.defaultDarkColors } : {},
    suppressHeaderSize: !!s.normalizeHeaders,
    suppressHeaderColor: !!s.normalizeHeaderColor,
    headerScale: s.headerScale != null ? s.headerScale : 1.0,
    blockCursor: !!s.blockCursor,
  };
}

/** Persist a Default-style draft back to global AppSettings. */
function saveDefaultDraftToSettings(state, draft) {
  state.updateSettings({
    fontFamily: draft.fontFamily || state.settings.fontFamily,
    fontSize: draft.fontSize || state.settings.fontSize,
    lineHeight: draft.lineHeight || state.settings.lineHeight,
    lightTheme: draft.lightThemeId || state.settings.lightTheme,
    darkTheme: draft.darkThemeId || state.settings.darkTheme,
    defaultLightColors: draft.lightColors || {},
    defaultDarkColors: draft.darkColors || {},
    normalizeHeaders: !!draft.suppressHeaderSize,
    normalizeHeaderColor: !!draft.suppressHeaderColor,
    headerScale: draft.headerScale != null ? draft.headerScale : 1.0,
    blockCursor: !!draft.blockCursor,
  });
}

/** Resolve a specific color key against the given theme. Returns a hex
 * colour suitable for <input type="color"> — falls back to sensible
 * defaults for keys the theme doesn't define (selection in particular
 * isn't a solid colour in our themes, so we pick a neutral approximation).
 */
function themeColorFor(key, themeId, colorTab) {
  const theme = getThemeById(themeId);
  const bg = themeBackgrounds[themeId] || (colorTab === "light" ? "#fafafa" : "#1a1a1a");
  const fg = themeForegrounds[themeId] || (colorTab === "light" ? "#1a1a1a" : "#e0e0e0");
  switch (key) {
    case "bg": return bg;
    case "fg": return fg;
    case "header": return theme?.headingColor || fg;
    case "cursor": return fg;
    case "selection": return colorTab === "light" ? "#c8c8c8" : "#3a3a3a";
    default: return fg;
  }
}

/** Fill the color overrides for the given appearance with the theme's own
 * resolved colors (bg / fg / header / cursor / selection). Gives users a
 * starting point when they pick a theme — every swatch in the Colors
 * section reflects what the theme actually renders. */
function seedColorsFromTheme(draft, colorTab, themeId) {
  if (!themeId) return;
  const filled = {
    bg: themeColorFor("bg", themeId, colorTab),
    fg: themeColorFor("fg", themeId, colorTab),
    header: themeColorFor("header", themeId, colorTab),
    cursor: themeColorFor("cursor", themeId, colorTab),
    selection: themeColorFor("selection", themeId, colorTab),
  };
  if (colorTab === "light") draft.lightColors = filled;
  else draft.darkColors = filled;
}

function openStyleModal(state, existingStyle, onDone) {
  // existingStyle === null → create a new user style
  // existingStyle === "__default__" → edit the Default (global settings)
  const isDefault = existingStyle === "__default__";
  const isNew = !existingStyle;
  const draft = isDefault
    ? buildDefaultDraftFromSettings(state)
    : existingStyle
      ? JSON.parse(JSON.stringify(migrateStyle(existingStyle)))
      : {
          id: "", name: "", fontFamily: null, fontSize: null, lineHeight: null,
          lightThemeId: state.settings.lightTheme || "ayuLight",
          darkThemeId: state.settings.darkTheme || "dracula",
          lightColors: {}, darkColors: {},
        };

  let colorTab = "light"; // which tab is shown in the color section

  // ── build the backdrop ───────────────────────────────────────────────────
  const backdrop = document.createElement("div");
  backdrop.className = "style-modal-backdrop";
  document.body.appendChild(backdrop);

  function close() { backdrop.remove(); }

  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

  function render() {
    const selectedFont = draft.fontFamily || "";
    const selectedFontLabel = selectedFont || `Default (${state.settings.fontFamily || "EB Garamond"})`;
    const ltId = draft.lightThemeId || "";
    const dtId = draft.darkThemeId || "";
    const ltObj = getThemeById(ltId);
    const dtObj = getThemeById(dtId);
    const ltLabel = ltObj ? ltObj.name : "Select theme";
    const dtLabel = dtObj ? dtObj.name : "Select theme";

    const activeColors = colorTab === "light" ? (draft.lightColors || {}) : (draft.darkColors || {});

    const headerScale = draft.headerScale != null ? draft.headerScale : 1.0;
    const title = isDefault ? "Edit Default Style" : isNew ? "New Style" : "Edit Style";

    // Name field is hidden for the Default style (name is fixed)
    const nameSection = isDefault ? "" : `
      <div class="style-modal-section">
        <h3 class="style-modal-section-title">Name</h3>
        <div class="style-editor-row">
          <input type="text" id="style-name" value="${escAttr(draft.name)}" placeholder="Style name" />
        </div>
      </div>`;

    backdrop.innerHTML = `
      <div class="style-modal">
        <button class="style-modal-close">&times;</button>
        <div class="style-modal-body">

          <!-- LEFT: settings column -->
          <div class="style-modal-settings">
            <h2 class="style-modal-title">${title}</h2>

            ${nameSection}

            <div class="style-modal-section">
              <h3 class="style-modal-section-title">Editing</h3>
              <div class="style-editor-row">
                <label>Font</label>
                <div class="custom-dropdown" id="style-font-dropdown" data-value="${escAttr(selectedFont)}">
                  <div class="custom-dropdown-selected" style="font-family: ${fontFallback(selectedFont || state.settings.fontFamily || "EB Garamond")};">${escHtml(selectedFontLabel)}</div>
                  <div class="custom-dropdown-options">
                    <div class="custom-dropdown-option${!selectedFont ? ' selected' : ''}" data-value="" style="font-family: ${fontFallback(state.settings.fontFamily || "EB Garamond")};">Default (${escHtml(state.settings.fontFamily || "EB Garamond")})</div>
                    <div class="custom-dropdown-group-label">Built-in</div>
                    ${builtInFonts.map(f => `<div class="custom-dropdown-option${draft.fontFamily === f ? ' selected' : ''}" data-value="${f}" style="font-family: ${fontFallback(f)};">${escHtml(f)}</div>`).join('')}
                    <div class="custom-dropdown-group-label">System</div>
                    ${systemFonts.map(f => `<div class="custom-dropdown-option${draft.fontFamily === f ? ' selected' : ''}" data-value="${f}" style="font-family: ${fontFallback(f)};">${escHtml(f)}</div>`).join('')}
                  </div>
                </div>
              </div>
              <div class="style-editor-row">
                <label>Size</label>
                <div class="style-slider-group">
                  <input type="range" id="style-font-size" min="12" max="36" step="1" value="${draft.fontSize || state.settings.fontSize || 20}" />
                  <span class="style-slider-value">${draft.fontSize || state.settings.fontSize || 20}px</span>
                </div>
              </div>
              <div class="style-editor-row">
                <label>Line height</label>
                <div class="style-slider-group">
                  <input type="range" id="style-line-height" min="1.0" max="2.5" step="0.1" value="${draft.lineHeight || state.settings.lineHeight || 1.6}" />
                  <span class="style-slider-value">${draft.lineHeight || state.settings.lineHeight || 1.6}</span>
                </div>
              </div>
              <div class="style-editor-row">
                <label>Cursor</label>
                <div class="style-checkbox-group">
                  <input type="checkbox" id="style-block-cursor" ${(draft.blockCursor != null ? draft.blockCursor : !!state.settings.blockCursor) ? 'checked' : ''} />
                  <span class="style-checkbox-label">Block</span>
                </div>
              </div>
            </div>

            <div class="style-modal-section">
              <h3 class="style-modal-section-title">Headers</h3>
              <div class="style-editor-row">
                <label>Suppress color</label>
                <div class="style-checkbox-group">
                  <input type="checkbox" id="style-suppress-header-color" ${draft.suppressHeaderColor ? 'checked' : ''} />
                </div>
              </div>
              <div class="style-editor-row">
                <label>Suppress size</label>
                <div class="style-checkbox-group">
                  <input type="checkbox" id="style-suppress-header-size" ${draft.suppressHeaderSize ? 'checked' : ''} />
                </div>
              </div>
              <div class="style-editor-row${draft.suppressHeaderSize ? ' style-row-hidden' : ''}" id="header-scale-row">
                <label>Size</label>
                <div class="style-slider-group">
                  <input type="range" id="style-header-scale" min="0.8" max="2.0" step="0.05" value="${headerScale}" />
                  <span class="style-slider-value">${headerScale.toFixed(2)}x</span>
                </div>
              </div>
            </div>

            <div class="style-modal-section">
              <h3 class="style-modal-section-title">Colors</h3>
              <div class="style-color-tabs">
                <button class="style-color-tab${colorTab === 'light' ? ' active' : ''}" data-mode="light">Light</button>
                <button class="style-color-tab${colorTab === 'dark' ? ' active' : ''}" data-mode="dark">Dark</button>
              </div>
              <div class="style-editor-row">
                <label>Theme</label>
                <div class="custom-dropdown" id="style-theme-dropdown" data-value="${escAttr(colorTab === 'light' ? ltId : dtId)}">
                  <div class="custom-dropdown-selected">${escHtml(colorTab === 'light' ? ltLabel : dtLabel)}</div>
                  <div class="custom-dropdown-options">
                    ${(colorTab === 'light' ? lightThemes : darkThemes).map(t => {
                      const selId = colorTab === 'light' ? ltId : dtId;
                      return `<div class="custom-dropdown-option${t.id === selId ? ' selected' : ''}" data-value="${t.id}">${escHtml(t.name)}</div>`;
                    }).join('')}
                  </div>
                </div>
              </div>
              ${colorKeys.map(ck => {
                const overrideVal = activeColors[ck.key];
                const themeId = colorTab === 'light' ? ltId : dtId;
                // Show the active theme's color in unset swatches so the
                // user sees what the theme renders before touching anything.
                const val = overrideVal || themeColorFor(ck.key, themeId, colorTab);
                return `<div class="style-editor-color-row">
                  <label>${ck.label}</label>
                  <div class="style-color-group">
                    <input type="color" data-color-key="${ck.key}" value="${val}" />
                    ${overrideVal ? `<button class="style-reset-color" data-color-key="${ck.key}" title="Reset">&times;</button>` : ''}
                  </div>
                </div>`;
              }).join("")}
            </div>

            <div class="style-editor-btns">
              <button id="style-cancel">Cancel</button>
              <button id="style-save" class="style-save-btn">${isNew ? "Create" : "Save"}</button>
            </div>
          </div>

          <!-- RIGHT: preview pane -->
          <div class="style-modal-preview" id="style-preview-pane">
            <div class="style-preview-content">${formatPreviewHtml(PREVIEW_MD)}</div>
            <div class="style-preview-cursor-demo">
              <span class="preview-selected">clarity</span><span class="preview-cursor"></span> is.
            </div>
          </div>

        </div>
      </div>`;
    bind();
    updatePreview();
  }

  // ── preview rendering ────────────────────────────────────────────────────
  function updatePreview() {
    const pane = backdrop.querySelector("#style-preview-pane");
    if (!pane) return;

    // Determine which theme/colors to show based on the active color tab
    const themeId = colorTab === "light" ? draft.lightThemeId : draft.darkThemeId;
    const colors = colorTab === "light" ? (draft.lightColors || {}) : (draft.darkColors || {});

    const bg = colors.bg || themeBackgrounds[themeId] || (colorTab === "light" ? "#fafafa" : "#1a1a1a");
    const fg = colors.fg || themeForegrounds[themeId] || (colorTab === "light" ? "#1a1a1a" : "#e0e0e0");
    const cursor = colors.cursor || fg;
    const selection = colors.selection || "rgba(128, 128, 128, 0.3)";
    const font = draft.fontFamily ? fontFallback(draft.fontFamily) : fontFallback(state.settings.fontFamily || "EB Garamond");
    const size = (draft.fontSize || state.settings.fontSize || 20) + "px";
    const lh = draft.lineHeight || state.settings.lineHeight || 1.6;
    const isBlock = draft.blockCursor != null ? draft.blockCursor : !!state.settings.blockCursor;

    pane.style.background = bg;
    pane.style.color = fg;
    pane.style.fontFamily = font;
    pane.style.fontSize = size;
    pane.style.lineHeight = lh;

    // Cursor demo
    const cursorEl = pane.querySelector(".preview-cursor");
    if (cursorEl) {
      const themeObj = getThemeById(themeId);
      const blockColor = (themeObj && themeObj.headingColor) || cursor;
      if (isBlock) {
        cursorEl.style.borderLeft = "none";
        cursorEl.style.background = blockColor;
        cursorEl.style.opacity = "0.55";
        cursorEl.style.width = "0.6em";
      } else {
        cursorEl.style.borderLeft = `2px solid ${cursor}`;
        cursorEl.style.background = "none";
        cursorEl.style.opacity = "1";
        cursorEl.style.width = "0";
      }
    }

    // Selection demo
    const selEl = pane.querySelector(".preview-selected");
    if (selEl) {
      selEl.style.background = selection;
    }

    // Give headings the theme heading color if available (or override)
    const theme = getThemeById(themeId);
    const headingColor = colors.header
      || (draft.suppressHeaderColor ? fg : (theme ? theme.headingColor : fg));
    const scale = draft.headerScale != null ? draft.headerScale : 1.0;
    const baseSize = draft.fontSize || state.settings.fontSize || 20;
    const suppressSize = !!draft.suppressHeaderSize;
    const scales = { h1: 1.8, h2: 1.5, h3: 1.3 };
    pane.querySelectorAll(".preview-h1, .preview-h2, .preview-h3").forEach(el => {
      el.style.color = headingColor;
      if (suppressSize) {
        el.style.fontSize = baseSize + "px";
      } else {
        const tag = el.classList.contains("preview-h1") ? "h1"
          : el.classList.contains("preview-h2") ? "h2" : "h3";
        el.style.fontSize = (baseSize * scales[tag] * scale) + "px";
      }
    });
  }

  // ── event bindings ───────────────────────────────────────────────────────
  function bind() {
    // Close button
    backdrop.querySelector(".style-modal-close").addEventListener("click", close);

    // Color mode tabs
    backdrop.querySelectorAll(".style-color-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        colorTab = btn.dataset.mode;
        render();
      });
    });

    // Font dropdown
    bindCustomDropdown(backdrop.querySelector("#style-font-dropdown"), (val) => {
      draft.fontFamily = val || null;
      updatePreview();
    });

    // Theme dropdown — selecting a theme seeds the color overrides with
    // that theme's resolved colors so the user has a starting point to
    // tweak. Every subsequent theme change re-seeds the overrides.
    bindCustomDropdown(backdrop.querySelector("#style-theme-dropdown"), (val) => {
      if (colorTab === "light") draft.lightThemeId = val;
      else draft.darkThemeId = val;
      seedColorsFromTheme(draft, colorTab, val);
      render();
    });

    // Sliders
    const fsEl = backdrop.querySelector("#style-font-size");
    if (fsEl) fsEl.addEventListener("input", () => {
      fsEl.nextElementSibling.textContent = fsEl.value + "px";
      draft.fontSize = parseFloat(fsEl.value);
      updatePreview();
    });
    const lhEl = backdrop.querySelector("#style-line-height");
    if (lhEl) lhEl.addEventListener("input", () => {
      lhEl.nextElementSibling.textContent = lhEl.value;
      draft.lineHeight = parseFloat(lhEl.value);
      updatePreview();
    });

    // Name — update the draft live so tab switches don't wipe the typed value
    const nameEl = backdrop.querySelector("#style-name");
    if (nameEl) nameEl.addEventListener("input", () => {
      draft.name = nameEl.value;
    });

    // Suppress header overrides
    const shsEl = backdrop.querySelector("#style-suppress-header-size");
    if (shsEl) shsEl.addEventListener("change", () => {
      draft.suppressHeaderSize = shsEl.checked;
      // Show/hide the size slider row
      const row = backdrop.querySelector("#header-scale-row");
      if (row) row.classList.toggle("style-row-hidden", shsEl.checked);
      updatePreview();
    });
    const shcEl = backdrop.querySelector("#style-suppress-header-color");
    if (shcEl) shcEl.addEventListener("change", () => {
      draft.suppressHeaderColor = shcEl.checked;
      updatePreview();
    });

    // Header scale slider
    const hsEl = backdrop.querySelector("#style-header-scale");
    if (hsEl) hsEl.addEventListener("input", () => {
      const v = parseFloat(hsEl.value);
      hsEl.nextElementSibling.textContent = v.toFixed(2) + "x";
      draft.headerScale = v;
      updatePreview();
    });

    // Block cursor
    const bcEl = backdrop.querySelector("#style-block-cursor");
    if (bcEl) bcEl.addEventListener("change", () => {
      draft.blockCursor = bcEl.checked;
      updatePreview();
    });

    // Color pickers
    backdrop.querySelectorAll(".style-editor-color-row input[type='color']").forEach(input => {
      input.addEventListener("input", () => {
        const key = input.dataset.colorKey;
        const target = colorTab === "light" ? draft.lightColors : draft.darkColors;
        target[key] = input.value;
        updatePreview();
      });
    });
    backdrop.querySelectorAll(".style-reset-color").forEach(btn => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.colorKey;
        const target = colorTab === "light" ? draft.lightColors : draft.darkColors;
        delete target[key];
        render(); // re-render to remove the reset button
      });
    });

    // Cancel / Save
    backdrop.querySelector("#style-cancel").addEventListener("click", close);
    backdrop.querySelector("#style-save").addEventListener("click", () => {
      if (isDefault) {
        saveDefaultDraftToSettings(state, draft);
        state.emit("style-changed");
        close();
        if (onDone) onDone();
        return;
      }
      const name = backdrop.querySelector("#style-name")?.value?.trim() || draft.name?.trim();
      if (!name) return;
      draft.name = name;
      // Clean up internal migration flag
      delete draft._migrated;

      if (!state.settings.styles) state.settings.styles = [];
      if (isNew) {
        draft.id = "style_" + Date.now();
        state.settings.styles.push(draft);
      } else {
        const idx = state.settings.styles.findIndex(s => s.id === draft.id);
        if (idx >= 0) state.settings.styles[idx] = draft;
      }
      state.updateSettings({ styles: state.settings.styles });
      state.emit("style-changed");
      close();
      if (onDone) onDone();
    });
  }

  render();
}

// ── simple markdown→HTML for the preview pane ──────────────────────────────────
function formatPreviewHtml(md) {
  return md.split("\n").map(line => {
    if (line.startsWith("### ")) return `<div class="preview-h3">${fmtInline(line.slice(4))}</div>`;
    if (line.startsWith("## ")) return `<div class="preview-h2">${fmtInline(line.slice(3))}</div>`;
    if (line.startsWith("# ")) return `<div class="preview-h1">${fmtInline(line.slice(2))}</div>`;
    if (line.startsWith("> ")) return `<div class="preview-bq">${fmtInline(line.slice(2))}</div>`;
    if (line.trim() === "") return `<div class="preview-blank">&nbsp;</div>`;
    return `<div>${fmtInline(line)}</div>`;
  }).join("");
}

function fmtInline(text) {
  return escHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>');
}

// ── shared custom dropdown ─────────────────────────────────────────────────────
function bindCustomDropdown(dropdown, onSelect) {
  if (!dropdown) return;
  const selected = dropdown.querySelector(".custom-dropdown-selected");
  const optionsList = dropdown.querySelector(".custom-dropdown-options");

  selected.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = dropdown.classList.contains("open");
    document.querySelectorAll(".custom-dropdown.open").forEach(d => d.classList.remove("open"));
    if (!isOpen) {
      dropdown.classList.add("open");
      setTimeout(() => {
        document.addEventListener("mousedown", function handler(e2) {
          if (!dropdown.contains(e2.target)) { dropdown.classList.remove("open"); document.removeEventListener("mousedown", handler); }
        });
      }, 0);
    }
  });

  optionsList.querySelectorAll(".custom-dropdown-option").forEach(opt => {
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      const value = opt.dataset.value;
      dropdown.dataset.value = value;
      selected.textContent = opt.textContent;
      // Carry the option's inline font-family over to the selected display
      // so the font dropdown keeps rendering each name in its own face.
      // No-op for dropdowns where options don't set a font-family.
      const optFont = opt.style.fontFamily;
      if (optFont) selected.style.fontFamily = optFont;
      optionsList.querySelectorAll(".custom-dropdown-option").forEach(o => o.classList.remove("selected"));
      opt.classList.add("selected");
      dropdown.classList.remove("open");
      if (onSelect) onSelect(value);
    });
  });
}
