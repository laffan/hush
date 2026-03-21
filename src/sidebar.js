/**
 * Sidebar UI — icons, panels, mode toggles (LEFT side)
 */
import { isIOS, openSettingsWindow } from "./settings-ui.js";
import { createFilesPanel, refreshFilesPanel } from "./files-panel.js";
import { renderStylesPanel, bindStylesPanel } from "./styles-panel.js";

export function createSidebar(container, state) {
  const settingsBtn = isIOS() ? btn("settings", "Settings", icons.settings) : "";
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
      ${settingsBtn}
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
    // Recalculate column centering for inset mode
    if (state._columnResizeHandler) state._columnResizeHandler();
  }

  function hidePanel() {
    activePanel = null;
    panelOverlay.classList.add("hidden");
    container.classList.remove("visible");
    // Recalculate column centering for inset mode
    if (state._columnResizeHandler) state._columnResizeHandler();
  }

  // Button click handlers
  container.querySelector('[data-action="new-file"]').addEventListener("click", () => {
    state.newFile();
    hidePanel();
  });

  container.querySelector('[data-action="files"]').addEventListener("click", () => {
    if (activePanel === "files") {
      hidePanel();
      return;
    }
    activePanel = "files";
    panelOverlay.innerHTML = "";
    panelOverlay.classList.remove("hidden");
    container.classList.add("visible");
    createFilesPanel(panelOverlay, state, hidePanel);
    if (state._columnResizeHandler) state._columnResizeHandler();
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

  // Settings button (iOS only)
  const settingsBtnEl = container.querySelector('[data-action="settings"]');
  if (settingsBtnEl) {
    settingsBtnEl.addEventListener("click", () => {
      hidePanel();
      openSettingsWindow(state);
    });
  }

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
      refreshFilesPanel(state);
    }
  });

  state.on("file-opened", () => {
    if (activePanel === "files") {
      refreshFilesPanel(state);
    }
  });

  // Cmd+\ toggle support — force-show files (not toggle)
  state.on("show-files-panel", () => {
    activePanel = "files";
    panelOverlay.innerHTML = "";
    panelOverlay.classList.remove("hidden");
    container.classList.add("visible");
    createFilesPanel(panelOverlay, state, hidePanel);
    if (state._columnResizeHandler) state._columnResizeHandler();
  });

  // Cmd+\ hide support — reset internal state
  state.on("hide-panel", () => {
    activePanel = null;
    panelOverlay.classList.add("hidden");
    container.classList.remove("visible", "pinned");
    if (state._columnResizeHandler) state._columnResizeHandler();
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

  settings: `<circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>`,

  styles: `<polygon points="2,6 11,12 2,18"/>
    <polygon points="22,6 13,12 22,18"/>
    <rect x="10.5" y="9.5" width="3" height="5" rx="1" fill="currentColor" stroke="none"/>
    <line x1="12" y1="9.5" x2="12" y2="7" stroke-width="1.2" stroke-linecap="round"/>
    <line x1="12" y1="14.5" x2="12" y2="17" stroke-width="1.2" stroke-linecap="round"/>`,

};

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
  let content = state.editor.getContent();
  // For project view, strip separator markers for clean export
  if (state.currentProjectId) {
    content = content.replace(/\n\n---hush-separator---\n\n/g, "\n\n");
  }
  const name = state.currentProjectId
    ? (state._findNode(state.fileTree, state.currentProjectId)?.name || "project-export")
    : (state._deriveName(content) || "hush-export");

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
