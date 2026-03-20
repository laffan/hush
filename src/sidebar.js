/**
 * Sidebar UI — icons, panels, mode toggles (LEFT side)
 */
import { themeList } from "./themes.js";

export function createSidebar(container, state) {
  container.innerHTML = `
    <div class="sidebar-group sidebar-top">
      ${btn("new-file", "New file", icons.newFile)}
      ${btn("files", "Files", icons.files)}
      ${btn("styles", "Styles", icons.styles)}
    </div>
    <div class="sidebar-group sidebar-middle">
      ${btn("ratchet", "Ratchet mode", icons.ratchet)}
      ${btn("private", "Private mode", icons.private)}
      ${btn("typewriter", "Typewriter mode", icons.typewriter)}
    </div>
    <div class="sidebar-group sidebar-bottom">
      ${btn("autosave", "Save location", icons.folder)}
      ${btn("export", "Export", icons.export)}
    </div>
  `;

  const panelOverlay = document.getElementById("panel-overlay");
  let activePanel = null;

  function showPanel(name, content) {
    if (activePanel === name) {
      hidePanel();
      return;
    }
    activePanel = name;
    panelOverlay.innerHTML = content;
    panelOverlay.classList.remove("hidden");
    container.classList.add("visible");
  }

  function hidePanel() {
    activePanel = null;
    panelOverlay.classList.add("hidden");
    container.classList.remove("visible");
  }

  // Button click handlers
  container.querySelector('[data-action="new-file"]').addEventListener("click", () => {
    state.newFile();
    hidePanel();
  });

  container.querySelector('[data-action="files"]').addEventListener("click", () => {
    showPanel("files", renderFilesPanel(state));
    bindFilesPanel(state, panelOverlay, hidePanel);
  });

  container.querySelector('[data-action="styles"]').addEventListener("click", () => {
    showPanel("styles", renderStylesPanel(state));
    bindStylesPanel(state, panelOverlay);
  });

  container.querySelector('[data-action="ratchet"]').addEventListener("click", (e) => {
    if (state.ratchetMode) {
      state.stopRatchet();
      updateActiveStates();
      return;
    }
    showRatchetDropdown(e.target.closest(".sidebar-btn"), state, () => {
      updateActiveStates();
    });
  });

  container.querySelector('[data-action="private"]').addEventListener("click", () => {
    state.togglePrivate();
    updateActiveStates();
  });

  container.querySelector('[data-action="typewriter"]').addEventListener("click", () => {
    state.toggleTypewriter();
    updateActiveStates();
  });

  container.querySelector('[data-action="autosave"]').addEventListener("click", () => {
    showPanel("autosave", renderAutosavePanel(state));
    bindAutosavePanel(state, panelOverlay);
  });

  container.querySelector('[data-action="export"]').addEventListener("click", async () => {
    hidePanel();
    await exportCurrentFile(state);
  });

  function updateActiveStates() {
    setActive("ratchet", state.ratchetMode);
    setActive("private", state.privateMode);
    setActive("typewriter", state.typewriterMode);
  }

  function setActive(action, isActive) {
    const el = container.querySelector(`[data-action="${action}"]`);
    if (el) el.classList.toggle("active", isActive);
  }

  state.on("mode-changed", updateActiveStates);
  state.on("fullscreen-changed", updateActiveStates);

  state.on("files-changed", () => {
    if (activePanel === "files") {
      panelOverlay.innerHTML = renderFilesPanel(state);
      bindFilesPanel(state, panelOverlay, hidePanel);
    }
  });

  // Cmd+/ toggle support
  state.on("toggle-files-panel", () => {
    showPanel("files", renderFilesPanel(state));
    bindFilesPanel(state, panelOverlay, hidePanel);
  });

  // Close panel on click outside
  document.addEventListener("mousedown", (e) => {
    if (activePanel && !panelOverlay.contains(e.target) && !container.contains(e.target)) {
      hidePanel();
    }
  });

  updateActiveStates();
}

function btn(action, title, svgContent) {
  return `<button class="sidebar-btn" data-action="${action}" title="${title}">
    <svg viewBox="0 0 24 24">${svgContent}</svg>
  </button>`;
}

// Minimalist SVG icons
const icons = {
  newFile: `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="12" y1="18" x2="12" y2="12"/>
    <line x1="9" y1="15" x2="15" y2="15"/>`,

  files: `<line x1="10" y1="7" x2="20" y2="7"/>
    <line x1="10" y1="12" x2="20" y2="12"/>
    <line x1="10" y1="17" x2="20" y2="17"/>
    <circle cx="5" cy="7" r="1.5" fill="currentColor" stroke="none"/>
    <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/>
    <circle cx="5" cy="17" r="1.5" fill="currentColor" stroke="none"/>`,

  ratchet: `<circle cx="12" cy="12" r="10"/>
    <polyline points="12 6 12 12 16 14"/>`,

  private: `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
    <line x1="1" y1="1" x2="23" y2="23"/>`,

  typewriter: `<line x1="4" y1="9" x2="20" y2="9"/>
    <line x1="4" y1="15" x2="20" y2="15"/>
    <line x1="12" y1="3" x2="12" y2="21"/>`,

  folder: `<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>`,

  export: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>`,

  styles: `<polygon points="2,6 11,12 2,18"/>
    <polygon points="22,6 13,12 22,18"/>
    <rect x="10.5" y="9.5" width="3" height="5" rx="1" fill="currentColor" stroke="none"/>
    <line x1="12" y1="9.5" x2="12" y2="7" stroke-width="1.2" stroke-linecap="round"/>
    <line x1="12" y1="14.5" x2="12" y2="17" stroke-width="1.2" stroke-linecap="round"/>`,

};

function renderFilesPanel(state) {
  const files = state.files;
  let html = `<div class="panel-title">Files</div><ul class="file-list">`;
  for (const f of files) {
    const date = new Date(f.modified * 1000).toLocaleDateString();
    const active = f.id === state.currentFileId ? " active" : "";
    html += `<li class="${active}" data-id="${f.id}">
      <span class="file-name-text">${escHtml(f.name)}</span>
      <span class="file-date">${date}</span>
      <span class="file-actions">
        <button data-file-action="rename" data-id="${f.id}" title="Rename">
          <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button data-file-action="duplicate" data-id="${f.id}" title="Duplicate">
          <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button data-file-action="delete" data-id="${f.id}" title="Delete">
          <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </span>
    </li>`;
  }
  html += `</ul>`;
  return html;
}

function bindFilesPanel(state, panel, hidePanel) {
  panel.querySelectorAll(".file-list li").forEach((li) => {
    li.addEventListener("click", (e) => {
      // Don't navigate if clicking an action button
      if (e.target.closest(".file-actions")) return;
      state.openFile(li.dataset.id);
      // Keep panel open in inset mode (wide window)
      if (!panel.classList.contains("panel-inset")) {
        hidePanel();
      }
    });
  });

  // File action buttons
  panel.querySelectorAll("[data-file-action]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const action = btn.dataset.fileAction;
      const fileId = btn.dataset.id;

      if (action === "rename") {
        const li = btn.closest("li");
        const nameEl = li.querySelector(".file-name-text");
        const currentName = nameEl.textContent;
        nameEl.innerHTML = `<input class="file-rename-input" type="text" value="${currentName}" />`;
        const input = nameEl.querySelector("input");
        input.focus();
        input.select();

        function finishRename() {
          const newName = input.value.trim();
          if (newName && newName !== currentName) {
            state.renameFile(fileId, newName);
          } else {
            nameEl.textContent = currentName;
          }
        }

        input.addEventListener("blur", finishRename, { once: true });
        input.addEventListener("keydown", (e2) => {
          if (e2.key === "Enter") { e2.preventDefault(); input.blur(); }
          if (e2.key === "Escape") { input.value = currentName; input.blur(); }
        });
      } else if (action === "duplicate") {
        await state.duplicateFile(fileId);
      } else if (action === "delete") {
        await state.deleteFile(fileId);
      }
    });
  });
}

function renderAutosavePanel(state) {
  const folder = state.settings.autosaveFolder;
  const hasFolder = !!folder;
  return `<div class="autosave-panel">
    <div class="panel-title">Save Location</div>
    ${hasFolder ? `<div class="current-path">${escHtml(folder)}</div>` : `<div class="current-path">App data (default)</div>`}
    <button id="choose-folder">Choose Folder</button>
    ${hasFolder ? `<button id="reset-folder">Reset to Default</button>` : ""}
    ${hasFolder ? `<label>
      <input type="checkbox" id="obsidian-toggle" ${state.settings.obsidianIntegration ? "checked" : ""} />
      Integrate with Obsidian
    </label>` : ""}
  </div>`;
}

function bindAutosavePanel(state, panel) {
  const chooseBtn = panel.querySelector("#choose-folder");
  if (chooseBtn) {
    chooseBtn.addEventListener("click", async () => {
      const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
      if (IS_TAURI) {
        try {
          const { open } = await import("@tauri-apps/plugin-dialog");
          const selected = await open({ directory: true, multiple: false });
          if (selected) {
            await state.updateSettings({ autosaveFolder: selected });
            const { invoke } = await import("@tauri-apps/api/core");
            const isVault = await invoke("check_obsidian_vault", { path: selected });
            if (!isVault) {
              await state.updateSettings({ obsidianIntegration: false });
            }
            panel.innerHTML = renderAutosavePanel(state);
            bindAutosavePanel(state, panel);
          }
        } catch (e) {
          console.error("Folder selection failed:", e);
        }
      } else {
        alert("Folder selection requires the desktop app.");
      }
    });
  }

  const resetBtn = panel.querySelector("#reset-folder");
  if (resetBtn) {
    resetBtn.addEventListener("click", async () => {
      await state.updateSettings({ autosaveFolder: null, obsidianIntegration: false });
      panel.innerHTML = renderAutosavePanel(state);
      bindAutosavePanel(state, panel);
    });
  }

  const obsidianToggle = panel.querySelector("#obsidian-toggle");
  if (obsidianToggle) {
    obsidianToggle.addEventListener("change", async () => {
      await state.updateSettings({ obsidianIntegration: obsidianToggle.checked });
    });
  }
}

// ===== Styles Panel =====
let editingStyleId = null; // null = list view, "new" = new style form, or style id

function renderStylesPanel(state) {
  const styles = state.settings.styles || [];
  const activeId = state.settings.activeStyleId;

  let html = `<div class="panel-title">Styles</div>`;
  html += `<button class="new-style-sidebar-btn" id="new-style-btn">+ New Style</button>`;

  // New style editor accordion (at top)
  if (editingStyleId === "new") {
    html += renderStyleEditorInline(state);
  }

  html += `<div class="style-list-sidebar">`;

  // Default style (always first, cannot be deleted)
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
    // Inline editor accordion for this style
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

  const builtInFonts = ["EB Garamond", "Inter", "Fira Code"];
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
  ];

  let fontOptions = `<option value="">Default (${state.settings.fontFamily || "EB Garamond"})</option>`;
  fontOptions += `<optgroup label="Built-in">`;
  for (const f of builtInFonts) {
    fontOptions += `<option value="${f}" ${style.fontFamily === f ? "selected" : ""}>${f}</option>`;
  }
  fontOptions += `</optgroup><optgroup label="System">`;
  for (const f of systemFonts) {
    fontOptions += `<option value="${f}" ${style.fontFamily === f ? "selected" : ""}>${f}</option>`;
  }
  fontOptions += `</optgroup>`;

  let themeOptions = `<optgroup label="Light">`;
  for (const t of lightThemes) {
    themeOptions += `<option value="${t.id}" ${style.themeId === t.id ? "selected" : ""}>${t.name}</option>`;
  }
  themeOptions += `</optgroup><optgroup label="Dark">`;
  for (const t of darkThemes) {
    themeOptions += `<option value="${t.id}" ${style.themeId === t.id ? "selected" : ""}>${t.name}</option>`;
  }
  themeOptions += `</optgroup>`;

  return `
    <div class="style-editor-sidebar style-editor-accordion">
      <div class="style-editor-row">
        <label>Name</label>
        <input type="text" id="style-name" value="${escAttr(style.name)}" placeholder="Style name" />
      </div>
      <div class="style-editor-row">
        <label>Theme</label>
        <select id="style-theme">${themeOptions}</select>
      </div>
      <div class="style-editor-row">
        <label>Font</label>
        <select id="style-font">${fontOptions}</select>
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

function bindStylesPanel(state, panel) {
  // Bind inline editor if one is open
  if (editingStyleId !== null) {
    bindStyleEditor(state, panel);
  }

  // New style button
  const newBtn = panel.querySelector("#new-style-btn");
  if (newBtn) {
    newBtn.addEventListener("click", () => {
      editingStyleId = "new";
      panel.innerHTML = renderStylesPanel(state);
      bindStylesPanel(state, panel);
    });
  }

  // Click to activate style, hover to preview
  panel.querySelectorAll(".style-sidebar-item").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".style-sidebar-actions")) return;
      const id = el.dataset.styleId;
      state.updateSettings({ activeStyleId: id || null });
      state.emit("style-changed");
      panel.innerHTML = renderStylesPanel(state);
      bindStylesPanel(state, panel);
    });

    // Hover preview
    el.addEventListener("mouseenter", () => {
      const id = el.dataset.styleId;
      if (!id) {
        // Default style — restore
        state.emit("style-preview-end");
        return;
      }
      const style = (state.settings.styles || []).find(s => s.id === id);
      if (style) state.emit("style-preview", style);
    });

    el.addEventListener("mouseleave", () => {
      state.emit("style-preview-end");
    });
  });

  // Action buttons
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
          const newStyle = {
            ...JSON.parse(JSON.stringify(source)),
            id: "style_" + Date.now(),
            name: source.name + " copy",
          };
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

  // Helper: gather current form values as a style object for preview
  function getFormStyle() {
    const themeId = panel.querySelector("#style-theme")?.value;
    const fontFamily = panel.querySelector("#style-font")?.value || null;
    const fontSize = parseFloat(panel.querySelector("#style-font-size")?.value) || null;
    const lineHeight = parseFloat(panel.querySelector("#style-line-height")?.value) || null;
    const colorOverrides = {};
    panel.querySelectorAll(".style-editor-color-row input[type='color']").forEach(input => {
      const key = input.dataset.colorKey;
      if (input.value !== "#888888") colorOverrides[key] = input.value;
    });
    return { themeId, fontFamily, fontSize, lineHeight, colorOverrides };
  }

  function emitLivePreview() {
    state.emit("style-preview", getFormStyle());
  }

  // Apply initial preview when editor opens
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
      if (style) {
        Object.assign(style, { name, themeId, fontFamily, fontSize, lineHeight, colorOverrides });
      }
    }

    state.emit("style-preview-end");
    state.updateSettings({ styles: state.settings.styles });
    state.emit("style-changed");
    editingStyleId = null;
    panel.innerHTML = renderStylesPanel(state);
    bindStylesPanel(state, panel);
  });

  // Live preview on all input changes
  panel.querySelector("#style-theme")?.addEventListener("change", emitLivePreview);
  panel.querySelector("#style-font")?.addEventListener("change", emitLivePreview);

  // Slider live updates + preview
  const fsEl = panel.querySelector("#style-font-size");
  if (fsEl) {
    fsEl.addEventListener("input", () => {
      fsEl.nextElementSibling.textContent = fsEl.value + "px";
      emitLivePreview();
    });
  }
  const lhEl = panel.querySelector("#style-line-height");
  if (lhEl) {
    lhEl.addEventListener("input", () => {
      lhEl.nextElementSibling.textContent = lhEl.value;
      emitLivePreview();
    });
  }

  // Color inputs + preview
  panel.querySelectorAll(".style-editor-color-row input[type='color']").forEach(input => {
    input.addEventListener("input", emitLivePreview);
  });

  // Color reset buttons
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

function escAttr(str) {
  return (str || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function showRatchetDropdown(anchor, state, onStart) {
  document.querySelectorAll(".ratchet-dropdown").forEach((el) => el.remove());

  const dropdown = document.createElement("div");
  dropdown.className = "ratchet-dropdown";
  const rect = anchor.getBoundingClientRect();
  // Position to the RIGHT of the left sidebar
  dropdown.style.left = "60px";
  dropdown.style.top = rect.top + "px";

  const durations = [5, 10, 15, 20, 25, 30];
  durations.forEach((min) => {
    const opt = document.createElement("div");
    opt.className = "ratchet-option";
    opt.textContent = `${min} min`;
    opt.addEventListener("click", () => {
      state.startRatchet(min);
      dropdown.remove();
      onStart();
    });
    dropdown.appendChild(opt);
  });

  document.body.appendChild(dropdown);

  setTimeout(() => {
    document.addEventListener(
      "mousedown",
      function handler(e) {
        if (!dropdown.contains(e.target)) {
          dropdown.remove();
          document.removeEventListener("mousedown", handler);
        }
      }
    );
  }, 0);
}

async function exportCurrentFile(state) {
  if (!state.editor) return;
  const content = state.editor.getContent();
  const name = state._deriveName(content) || "hush-export";

  const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
  if (IS_TAURI) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const filePath = await save({
        defaultPath: `${name}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (filePath) {
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        await writeTextFile(filePath, content);
      }
    } catch (e) {
      console.error("Export failed:", e);
    }
  } else {
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
