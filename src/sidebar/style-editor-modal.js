/**
 * Edit Styles modal — three columns. Left rail lists every style and
 * lets the user create / duplicate / delete; middle column is the
 * settings form; right column is the live preview. Selecting a row in
 * the left rail flushes any pending edit and remounts the editor for
 * the new target via `openStyleModal({ host })`.
 *
 * Split from style-modal.js so that file stays under the 700-line cap.
 */
import { openStyleModal } from "./style-modal.js";
import { escAttr, escHtml, themeBackgrounds, themeForegrounds } from "./styles-panel-shared.js";
import { resolveStyleForAppearance } from "./styles-panel.js";
import { applyAppearance } from "../settings/settings-ui.js";
import appearanceLightRaw from "./sidebar_icons/appearance-light.svg?raw";
import appearanceDarkRaw from "./sidebar_icons/appearance-dark.svg?raw";
import appearanceAutoRaw from "./sidebar_icons/appearance-auto.svg?raw";

const APPEARANCE_ICONS = {
  light: appearanceLightRaw,
  dark: appearanceDarkRaw,
  auto: appearanceAutoRaw,
};

export function openStyleEditorModal(state) {
  const backdrop = document.createElement("div");
  backdrop.className = "style-editor-backdrop";
  backdrop.innerHTML = `
    <div class="style-editor-modal">
      <button class="style-editor-close" aria-label="Close">&times;</button>
      <div class="style-editor-body">
        <div class="style-editor-rail">
          <div class="style-editor-rail-title">Styles</div>
          <div class="style-editor-rail-list"></div>
          <button class="style-editor-rail-new" type="button">+ New Style</button>
          <div class="style-editor-rail-appearance" role="group" aria-label="Appearance"></div>
        </div>
        <div class="style-editor-pane"></div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const pane = backdrop.querySelector(".style-editor-pane");
  let activeHandle = null;
  // Begin on the active style — Default if none. Resolved by id.
  let selectedId = state.settings.activeStyleId || "__default__";

  function targetFromId(id) {
    if (id === "__default__") return "__default__";
    const styles = state.settings.styles || [];
    return styles.find((s) => s.id === id) || "__default__";
  }

  function renderRail() {
    const listEl = backdrop.querySelector(".style-editor-rail-list");
    const styles = state.settings.styles || [];
    const appearance = state.settings.appearance || "auto";
    const rows = [];

    function rowHtml(id, name, isActive, style) {
      const safeName = escHtml(name);
      let bg = "transparent";
      let fg = "var(--fg)";
      if (style) {
        const resolved = resolveStyleForAppearance(style, appearance);
        bg = (resolved.colors && resolved.colors.bg) || themeBackgrounds[resolved.themeId] || "transparent";
        fg = (resolved.colors && resolved.colors.fg) || themeForegrounds[resolved.themeId] || "var(--fg)";
      }
      const actions = id === "__default__"
        ? ""
        : `<span class="style-editor-row-actions">
            <button data-action="duplicate" data-id="${escAttr(id)}" title="Duplicate">&plus;</button>
            <button data-action="delete" data-id="${escAttr(id)}" title="Delete">&times;</button>
          </span>`;
      return `<div class="style-editor-row${isActive ? " active" : ""}" data-id="${escAttr(id)}" style="background:${bg};color:${fg}">
        <span class="style-editor-row-name">${safeName}</span>
        ${actions}
      </div>`;
    }

    rows.push(rowHtml("__default__", "Default", selectedId === "__default__", null));
    for (const st of styles) {
      rows.push(rowHtml(st.id, st.name || "Untitled", selectedId === st.id, st));
    }
    listEl.innerHTML = rows.join("");

    const appEl = backdrop.querySelector(".style-editor-rail-appearance");
    appEl.innerHTML = ["light", "dark", "auto"].map((mode) => {
      const active = appearance === mode ? " active" : "";
      return `<button type="button" class="style-appearance-btn${active}" data-appearance="${mode}" aria-pressed="${appearance === mode}">${APPEARANCE_ICONS[mode]}</button>`;
    }).join("");
  }

  function mountEditor() {
    if (activeHandle) activeHandle.flush();
    pane.innerHTML = "";
    activeHandle = openStyleModal(state, targetFromId(selectedId), () => {
      // After a save commits, re-render the rail so style names + swatch
      // colours stay in lockstep with the edits.
      renderRail();
    }, { host: pane });
  }

  function close() {
    if (activeHandle) activeHandle.flush();
    document.removeEventListener("keydown", escHandler);
    backdrop.remove();
  }
  const escHandler = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", escHandler);

  backdrop.querySelector(".style-editor-close").addEventListener("click", close);
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });

  // Rail click handler — row selection + per-row actions.
  backdrop.querySelector(".style-editor-rail-list").addEventListener("click", (e) => {
    const actionBtn = e.target.closest("button[data-action]");
    if (actionBtn) {
      e.stopPropagation();
      const id = actionBtn.dataset.id;
      if (actionBtn.dataset.action === "duplicate") {
        const styles = state.settings.styles || [];
        const src = styles.find((s) => s.id === id);
        if (!src) return;
        const copy = { ...JSON.parse(JSON.stringify(src)), id: "style_" + Date.now(), name: src.name + " copy" };
        state.updateSettings({ styles: [...styles, copy] });
        selectedId = copy.id;
        renderRail();
        mountEditor();
      } else if (actionBtn.dataset.action === "delete") {
        if (!window.confirm("Delete this style?")) return;
        const styles = (state.settings.styles || []).filter((s) => s.id !== id);
        const updates = { styles };
        if (state.settings.activeStyleId === id) updates.activeStyleId = null;
        state.updateSettings(updates);
        if (selectedId === id) selectedId = "__default__";
        state.emit("style-changed");
        renderRail();
        mountEditor();
      }
      return;
    }
    const row = e.target.closest(".style-editor-row");
    if (!row) return;
    const id = row.dataset.id;
    if (id === selectedId) return;
    selectedId = id;
    const activeId = id === "__default__" ? null : id;
    state.setDeskGlobalStyleId(activeId);
    state.updateSettings({ activeStyleId: activeId });
    state.emit("style-changed");
    renderRail();
    mountEditor();
  });

  backdrop.querySelector(".style-editor-rail-new").addEventListener("click", () => {
    if (activeHandle) activeHandle.flush();
    pane.innerHTML = "";
    activeHandle = openStyleModal(state, null, () => {
      // After first edit, the new style materialises with a real id; pick
      // it up so the rail row matches.
      const styles = state.settings.styles || [];
      const created = styles[styles.length - 1];
      if (created) selectedId = created.id;
      renderRail();
    }, { host: pane });
    renderRail();
  });

  backdrop.querySelector(".style-editor-rail-appearance").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-appearance]");
    if (!btn) return;
    const mode = btn.dataset.appearance;
    if (state.settings.appearance === mode) return;
    state.updateSettings({ appearance: mode });
    applyAppearance(mode);
    state.emit("style-changed");
    state.emit("theme-changed");
    renderRail();
    mountEditor();
  });

  renderRail();
  mountEditor();
}
