/**
 * Styles panel — create, edit, preview, and switch between named style presets
 */

import { themeList } from "../themes.js";

let editingStyleId = null; // null = list view, "new" = new style form, or style id

export function renderStylesPanel(state) {
  const styles = state.settings.styles || [];
  const activeId = state.settings.activeStyleId;

  let html = `<button class="new-style-sidebar-btn" id="new-style-btn">+ New Style</button>`;

  if (editingStyleId === "new") {
    html += renderStyleEditorInline(state);
  }

  html += `<div class="style-list-sidebar">`;

  const isDefault = !activeId;
  html += `<div class="style-sidebar-item${isDefault ? ' active' : ''}" data-style-id="">
    <span class="style-sidebar-name" style="font-size:14px;">Default</span>
  </div>`;

  for (const st of styles) {
    const isActive = activeId === st.id;
    const isEditing = editingStyleId === st.id;
    const bg = (st.colorOverrides && st.colorOverrides.bg) || "#1a1a1a";
    const fg = (st.colorOverrides && st.colorOverrides.fg) || "#e0e0e0";
    const fontSize = st.fontSize || state.settings.fontSize || 20;
    html += `<div class="style-sidebar-item${isActive ? ' active' : ''}${isEditing ? ' editing' : ''}" data-style-id="${st.id}"
      style="background:${bg}; color:${fg}; font-size:${Math.min(fontSize, 16)}px;${st.fontFamily ? ` font-family:'${st.fontFamily}';` : ''}">
      <span class="style-sidebar-name">${escHtml(st.name)}</span>
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
    if (isEditing) {
      html += renderStyleEditorInline(state);
    }
  }

  html += `</div>`;
  return html;
}

function renderStyleEditorInline(state) {
  const isNew = editingStyleId === "new";
  const style = isNew
    ? { id: "", name: "", themeId: state.settings.darkTheme || "dracula", fontFamily: null, fontSize: null, lineHeight: null, colorOverrides: {} }
    : (state.settings.styles || []).find(s => s.id === editingStyleId) || {};

  const lightThemes = themeList.filter(t => t.type === "light");
  const darkThemes = themeList.filter(t => t.type === "dark");
  const builtInFonts = ["Source Sans Pro", "Source Serif Pro", "Libre Franklin", "Libre Baskerville", "Karla", "Lora", "EB Garamond", "Inter", "Fira Code"];
  const systemFonts = [
    "Arial", "Avenir", "Avenir Next", "Baskerville", "Courier New",
    "Futura", "Garamond", "Georgia", "Gill Sans", "Helvetica",
    "Helvetica Neue", "Lucida Grande", "Menlo", "Monaco", "Optima",
    "Palatino", "SF Mono", "SF Pro", "Times New Roman", "Verdana",
  ];
  const colorKeys = [
    { key: "bg", label: "Background" },
    { key: "fg", label: "Text" },
    { key: "cursor", label: "Cursor" },
    { key: "selection", label: "Selection" },
  ];

  const selectedFont = style.fontFamily || "";
  const selectedFontLabel = selectedFont || `Default (${state.settings.fontFamily || "EB Garamond"})`;
  const selectedTheme = style.themeId || "";
  const selectedThemeObj = themeList.find(t => t.id === selectedTheme);
  const selectedThemeLabel = selectedThemeObj ? selectedThemeObj.name : (selectedTheme || "Select theme");

  return `
    <div class="style-editor-sidebar style-editor-accordion">
      <div class="style-editor-row">
        <label>Name</label>
        <input type="text" id="style-name" value="${escAttr(style.name)}" placeholder="Style name" />
      </div>
      <div class="style-editor-row">
        <label>Theme</label>
        <div class="custom-dropdown" id="style-theme-dropdown" data-value="${escAttr(selectedTheme)}">
          <div class="custom-dropdown-selected">${escHtml(selectedThemeLabel)}</div>
          <div class="custom-dropdown-options">
            <div class="custom-dropdown-group-label">Light</div>
            ${lightThemes.map(t => `<div class="custom-dropdown-option${t.id === selectedTheme ? ' selected' : ''}" data-value="${t.id}">${escHtml(t.name)}</div>`).join('')}
            <div class="custom-dropdown-group-label">Dark</div>
            ${darkThemes.map(t => `<div class="custom-dropdown-option${t.id === selectedTheme ? ' selected' : ''}" data-value="${t.id}">${escHtml(t.name)}</div>`).join('')}
          </div>
        </div>
      </div>
      <div class="style-editor-row">
        <label>Font</label>
        <div class="custom-dropdown" id="style-font-dropdown" data-value="${escAttr(selectedFont)}">
          <div class="custom-dropdown-selected">${escHtml(selectedFontLabel)}</div>
          <div class="custom-dropdown-options">
            <div class="custom-dropdown-option${!selectedFont ? ' selected' : ''}" data-value="">Default (${escHtml(state.settings.fontFamily || "EB Garamond")})</div>
            <div class="custom-dropdown-group-label">Built-in</div>
            ${builtInFonts.map(f => `<div class="custom-dropdown-option${style.fontFamily === f ? ' selected' : ''}" data-value="${f}">${escHtml(f)}</div>`).join('')}
            <div class="custom-dropdown-group-label">System</div>
            ${systemFonts.map(f => `<div class="custom-dropdown-option${style.fontFamily === f ? ' selected' : ''}" data-value="${f}">${escHtml(f)}</div>`).join('')}
          </div>
        </div>
      </div>
      <div class="style-editor-row">
        <label>Size</label>
        <div class="style-slider-group">
          <input type="range" id="style-font-size" min="12" max="36" step="1" value="${style.fontSize || state.settings.fontSize || 20}" />
          <span class="style-slider-value">${style.fontSize || state.settings.fontSize || 20}px</span>
        </div>
      </div>
      <div class="style-editor-row">
        <label>Height</label>
        <div class="style-slider-group">
          <input type="range" id="style-line-height" min="1.0" max="2.5" step="0.1" value="${style.lineHeight || state.settings.lineHeight || 1.6}" />
          <span class="style-slider-value">${style.lineHeight || state.settings.lineHeight || 1.6}</span>
        </div>
      </div>
      <div class="style-editor-colors-title">Color Overrides</div>
      ${colorKeys.map(ck => {
        const overrideVal = (style.colorOverrides || {})[ck.key];
        const val = overrideVal || "#888888";
        return `<div class="style-editor-color-row">
          <label>${ck.label}</label>
          <div class="style-color-group">
            <input type="color" data-color-key="${ck.key}" value="${val}" />
            ${overrideVal ? `<button class="style-reset-color" data-color-key="${ck.key}" title="Reset">&times;</button>` : ''}
          </div>
        </div>`;
      }).join("")}
      <div class="style-editor-btns">
        <button id="style-cancel">Cancel</button>
        <button id="style-save" class="style-save-btn">${isNew ? "Create" : "Save"}</button>
      </div>
    </div>
  `;
}

export function bindStylesPanel(state, panel) {
  if (editingStyleId !== null) {
    bindStyleEditor(state, panel);
  }

  const newBtn = panel.querySelector("#new-style-btn");
  if (newBtn) {
    newBtn.addEventListener("click", () => {
      editingStyleId = "new";
      panel.innerHTML = renderStylesPanel(state);
      bindStylesPanel(state, panel);
    });
  }

  panel.querySelectorAll(".style-sidebar-item").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".style-sidebar-actions")) return;
      const id = el.dataset.styleId;
      state.updateSettings({ activeStyleId: id || null });
      state.emit("style-changed");
      panel.innerHTML = renderStylesPanel(state);
      bindStylesPanel(state, panel);
    });

    el.addEventListener("mouseenter", () => {
      const id = el.dataset.styleId;
      if (!id) { state.emit("style-preview-end"); return; }
      const style = (state.settings.styles || []).find(s => s.id === id);
      if (style) state.emit("style-preview", style);
    });

    el.addEventListener("mouseleave", () => {
      state.emit("style-preview-end");
    });
  });

  panel.querySelectorAll(".style-sidebar-actions button").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const id = btn.dataset.id;

      if (action === "edit") {
        editingStyleId = id;
        panel.innerHTML = renderStylesPanel(state);
        bindStylesPanel(state, panel);
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
        state.updateSettings(updates);
        state.emit("style-changed");
        panel.innerHTML = renderStylesPanel(state);
        bindStylesPanel(state, panel);
      }
    });
  });
}

function bindStyleEditor(state, panel) {
  const cancelBtn = panel.querySelector("#style-cancel");
  const saveBtn = panel.querySelector("#style-save");

  function getFormStyle() {
    const themeId = panel.querySelector("#style-theme-dropdown")?.dataset.value || "";
    const fontFamily = panel.querySelector("#style-font-dropdown")?.dataset.value || null;
    const fontSize = parseFloat(panel.querySelector("#style-font-size")?.value) || null;
    const lineHeight = parseFloat(panel.querySelector("#style-line-height")?.value) || null;
    const colorOverrides = {};
    panel.querySelectorAll(".style-editor-color-row input[type='color']").forEach(input => {
      const key = input.dataset.colorKey;
      if (input.value !== "#888888") colorOverrides[key] = input.value;
    });
    return { themeId, fontFamily, fontSize, lineHeight, colorOverrides };
  }

  function emitLivePreview() { state.emit("style-preview", getFormStyle()); }
  emitLivePreview();

  cancelBtn.addEventListener("click", () => {
    state.emit("style-preview-end");
    editingStyleId = null;
    panel.innerHTML = renderStylesPanel(state);
    bindStylesPanel(state, panel);
  });

  saveBtn.addEventListener("click", () => {
    const name = panel.querySelector("#style-name")?.value?.trim();
    if (!name) return;
    const { themeId, fontFamily, fontSize, lineHeight, colorOverrides } = getFormStyle();
    if (!state.settings.styles) state.settings.styles = [];
    if (editingStyleId === "new") {
      const id = "style_" + Date.now();
      state.settings.styles.push({ id, name, themeId, fontFamily, fontSize, lineHeight, colorOverrides });
    } else {
      const style = state.settings.styles.find(s => s.id === editingStyleId);
      if (style) Object.assign(style, { name, themeId, fontFamily, fontSize, lineHeight, colorOverrides });
    }
    state.emit("style-preview-end");
    state.updateSettings({ styles: state.settings.styles });
    state.emit("style-changed");
    editingStyleId = null;
    panel.innerHTML = renderStylesPanel(state);
    bindStylesPanel(state, panel);
  });

  bindCustomDropdown(panel.querySelector("#style-theme-dropdown"), () => emitLivePreview(),
    (value) => { const fs = getFormStyle(); fs.themeId = value; state.emit("style-preview", fs); },
    () => emitLivePreview());

  bindCustomDropdown(panel.querySelector("#style-font-dropdown"), () => emitLivePreview(),
    (value) => { const fs = getFormStyle(); fs.fontFamily = value || null; state.emit("style-preview", fs); },
    () => emitLivePreview());

  const fsEl = panel.querySelector("#style-font-size");
  if (fsEl) fsEl.addEventListener("input", () => { fsEl.nextElementSibling.textContent = fsEl.value + "px"; emitLivePreview(); });
  const lhEl = panel.querySelector("#style-line-height");
  if (lhEl) lhEl.addEventListener("input", () => { lhEl.nextElementSibling.textContent = lhEl.value; emitLivePreview(); });

  panel.querySelectorAll(".style-editor-color-row input[type='color']").forEach(input => {
    input.addEventListener("input", emitLivePreview);
  });
  panel.querySelectorAll(".style-reset-color").forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.colorKey;
      const input = panel.querySelector(`input[type='color'][data-color-key='${key}']`);
      if (input) input.value = "#888888";
      btn.remove();
      emitLivePreview();
    });
  });
}

function bindCustomDropdown(dropdown, onSelect, onHover, onLeave) {
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
      optionsList.querySelectorAll(".custom-dropdown-option").forEach(o => o.classList.remove("selected"));
      opt.classList.add("selected");
      dropdown.classList.remove("open");
      if (onSelect) onSelect(value);
    });
    opt.addEventListener("mouseenter", () => { if (onHover) onHover(opt.dataset.value); });
  });
  optionsList.addEventListener("mouseleave", () => { if (onLeave) onLeave(); });
}

function escAttr(str) {
  return (str || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
