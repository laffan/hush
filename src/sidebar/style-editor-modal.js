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
import { fontFallback } from "./style-modal-preview.js";
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
          <button class="style-editor-rail-import" type="button">Import styles…</button>
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

    // The Default row has no stored style object — synthesize one from the
    // global settings so it gets the same font + light/dark swatch treatment
    // as every user style.
    const s = state.settings;
    const defaultStyle = {
      fontFamily: s.fontFamily || null,
      lightThemeId: s.lightTheme || "ayuLight",
      darkThemeId: s.darkTheme || "dracula",
      lightColors: s.defaultLightColors || {},
      darkColors: s.defaultDarkColors || {},
    };

    // A small "Aa" chip painted with one appearance's text-on-background, in
    // the style's own font — shown for both light and dark so the rail
    // previews each half at a glance.
    function swatch(style, mode, fontCss) {
      const resolved = resolveStyleForAppearance(style, mode);
      const bg = (resolved.colors && resolved.colors.bg) || themeBackgrounds[resolved.themeId] || (mode === "dark" ? "#2d2f3f" : "#ffffff");
      const fg = (resolved.colors && resolved.colors.fg) || themeForegrounds[resolved.themeId] || (mode === "dark" ? "#f8f8f2" : "#000000");
      return `<span class="style-editor-row-swatch" style="background:${bg};color:${fg};${fontCss}">Aa</span>`;
    }

    function rowHtml(id, name, isActive, style) {
      const safeName = escHtml(name);
      const fam = (style && style.fontFamily) || state.settings.fontFamily || "EB Garamond";
      const fontCss = `font-family:${fontFallback(fam)};`;
      const swatches = `<span class="style-editor-row-swatches">${swatch(style, "light", fontCss)}${swatch(style, "dark", fontCss)}</span>`;
      const actions = id === "__default__"
        ? ""
        : `<span class="style-editor-row-actions">
            <button data-action="duplicate" data-id="${escAttr(id)}" title="Duplicate">&plus;</button>
          </span>`;
      return `<div class="style-editor-row${isActive ? " active" : ""}" data-id="${escAttr(id)}">
        ${swatches}
        <span class="style-editor-row-name" style="${fontCss}">${safeName}</span>
        ${actions}
      </div>`;
    }

    rows.push(rowHtml("__default__", "Default", selectedId === "__default__", defaultStyle));
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
    }, { host: pane, onDelete: () => deleteStyleById(selectedId) });
  }

  /** Drop a style and reselect Default. Driven by the Delete button at the
   *  bottom of the settings pane (the confirmation lives there). */
  function deleteStyleById(id) {
    if (!id || id === "__default__") return;
    const styles = (state.settings.styles || []).filter((st) => st.id !== id);
    const updates = { styles };
    if (state.settings.activeStyleId === id) updates.activeStyleId = null;
    state.updateSettings(updates);
    if (selectedId === id) selectedId = "__default__";
    state.emit("style-changed");
    renderRail();
    mountEditor();
  }

  function close() {
    // The editor's own close() flushes pending edits AND tears down the
    // modal-scoped background / post-processing previews, re-applying the
    // active style so its effects return to the editor surface. A bare
    // flush() here used to strand those previews on a removed DOM node.
    if (activeHandle) activeHandle.close();
    activeHandle = null;
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

  // === Import styles from JSON ===
  const importInput = document.createElement("input");
  importInput.type = "file";
  importInput.accept = "application/json,.json";
  importInput.style.display = "none";
  backdrop.appendChild(importInput);

  function importStylesFromText(text) {
    let data;
    try { data = JSON.parse(text); } catch { window.alert("Import failed: not valid JSON."); return; }
    let incoming = [];
    if (Array.isArray(data)) incoming = data;
    else if (data && Array.isArray(data.styles)) incoming = data.styles;
    else if (data && data.style && typeof data.style === "object") incoming = [data.style];
    else if (data && typeof data === "object") incoming = [data];
    incoming = incoming.filter((s) => s && typeof s === "object");
    if (!incoming.length) { window.alert("Import failed: no styles found in file."); return; }

    const existing = state.settings.styles || [];
    const names = new Set(existing.map((s) => s.name));
    const added = [];
    for (const s of incoming) {
      const copy = { ...s, id: "style_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7) };
      let nm = copy.name || "Imported Style";
      let i = 2;
      while (names.has(nm)) nm = `${copy.name || "Imported Style"} (${i++})`;
      copy.name = nm;
      names.add(nm);
      added.push(copy);
    }
    state.updateSettings({ styles: [...existing, ...added] });
    selectedId = added[added.length - 1].id;
    renderRail();
    mountEditor();
  }

  importInput.addEventListener("change", () => {
    const file = importInput.files && importInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { importStylesFromText(String(reader.result || "")); importInput.value = ""; };
    reader.readAsText(file);
  });
  backdrop.querySelector(".style-editor-rail-import").addEventListener("click", () => importInput.click());

  renderRail();
  mountEditor();
}
