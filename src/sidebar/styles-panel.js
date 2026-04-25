/**
 * Styles panel — sidebar list of style presets, the lock toggle, and the
 * thin entry point into the style-edit modal (which lives in style-modal.js).
 *
 * Editing UI uses a two-column modal: settings on the left, live preview on
 * the right. Color overrides are split into Light / Dark tabs so every
 * style can carry both palettes.
 */

import { parseShortcut } from "../shortcuts.js";
import {
  escHtml,
  migrateStyle,
  themeBackgrounds,
  themeForegrounds,
} from "./styles-panel-shared.js";
import { openStyleModal } from "./style-modal.js";

/** Format a shortcut string for inline display (e.g. "Mod+1" → "⌘1"). */
function formatShortcutBadge(raw) {
  const p = parseShortcut(raw);
  if (!p) return "";
  const isMac = navigator.platform?.includes("Mac") || navigator.userAgent?.includes("Mac");
  const parts = [];
  if (p.mod) parts.push(isMac ? "⌘" : "Ctrl+");
  if (p.shift) parts.push(isMac ? "⇧" : "Shift+");
  if (p.alt) parts.push(isMac ? "⌥" : "Alt+");
  parts.push(p.key.length === 1 ? p.key.toUpperCase() : p.key);
  return parts.join("");
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
