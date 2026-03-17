/**
 * Sidebar UI — icons, panels, mode toggles (LEFT side)
 */
export function createSidebar(container, state) {
  container.innerHTML = `
    <div class="sidebar-group sidebar-top">
      ${btn("new-file", "New file", icons.newFile)}
      ${btn("files", "Files", icons.files)}
    </div>
    <div class="sidebar-group sidebar-middle">
      ${btn("ratchet", "Ratchet mode", icons.ratchet, { viewBox: "0 0 300 300", fill: true })}
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

  // Close panel on click outside
  document.addEventListener("mousedown", (e) => {
    if (activePanel && !panelOverlay.contains(e.target) && !container.contains(e.target)) {
      hidePanel();
    }
  });

  updateActiveStates();
}

function btn(action, title, svgContent, options = {}) {
  const viewBox = options.viewBox || "0 0 24 24";
  const cls = options.fill ? "sidebar-btn fill-icon" : "sidebar-btn";
  return `<button class="${cls}" data-action="${action}" title="${title}">
    <svg viewBox="${viewBox}">${svgContent}</svg>
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

  ratchet: `<path d="M241.3,1.3H58.7C27,1.3,1.3,27,1.3,58.7v182.7c0,31.7,25.7,57.4,57.4,57.4h182.7c31.7,0,57.4-25.7,57.4-57.4V58.7c0-31.7-25.7-57.4-57.4-57.4ZM55.4,65.8h75.8v39.2H55.4v-39.2ZM55.4,130.7h91.7v39.2H55.4v-39.2ZM225,234.2H55.4v-39.2h169.6v39.2ZM240.5,169.9h-75.8v-39.2h75.8v39.2ZM244.6,105h-97.4v-39.2h97.4v39.2Z"/>`,

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

};

function renderFilesPanel(state) {
  const files = state.files;
  let html = `<div class="panel-title">Files</div><ul class="file-list">`;
  for (const f of files) {
    const date = new Date(f.modified * 1000).toLocaleDateString();
    const active = f.id === state.currentFileId ? " active" : "";
    html += `<li class="${active}" data-id="${f.id}">
      ${escHtml(f.name)}
      <span class="file-date">${date}</span>
    </li>`;
  }
  html += `</ul>`;
  return html;
}

function bindFilesPanel(state, panel, hidePanel) {
  panel.querySelectorAll(".file-list li").forEach((li) => {
    li.addEventListener("click", () => {
      state.openFile(li.dataset.id);
      hidePanel();
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
