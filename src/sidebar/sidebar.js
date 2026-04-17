/**
 * Sidebar UI — icons, panels, mode toggles (LEFT side)
 */
import { isIOS, openSettingsWindow } from "../settings/settings-ui.js";
import { createFilesPanel, refreshFilesPanel } from "./files-panel.js";
import { findNode } from "../state/tree-helpers.js";
import { renderStylesPanel, bindStylesPanel } from "./styles-panel.js";
import { createVersionsPanel, cleanupVersionsPanel } from "./versions-panel.js";
import filesRaw from "./sidebar_icons/files.svg?raw";
import versionsRaw from "./sidebar_icons/versions.svg?raw";
import exportRaw from "./sidebar_icons/export.svg?raw";
import settingsRaw from "./sidebar_icons/settings.svg?raw";
import stylesRaw from "./sidebar_icons/styles.svg?raw";

function svgInner(raw) {
  return raw.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "").trim();
}

export function createSidebar(container, state) {
  const settingsBtn = isIOS() ? btn("settings", "Settings", icons.settings) : "";
  container.innerHTML = `
    <div class="sidebar-group sidebar-top">
      ${btn("files", "Files", icons.files)}
      ${btn("styles", "Styles", icons.styles)}
    </div>
    <div class="sidebar-group sidebar-bottom">
      ${btn("versions", "Versions", icons.versions)}
      ${btn("export", "Export", icons.export)}
      ${settingsBtn}
    </div>
  `;

  const panelOverlay = document.getElementById("panel-overlay");
  let activePanel = null;
  let panelPinned = false;

  function isWideViewport() {
    return window.innerWidth > 600;
  }

  // Pin toggle button — fixed position, shown when hovering panel zone in inset mode.
  // Hidden entirely on wide viewports (>600px), where the sidebar is always open.
  const pinBtn = document.createElement("button");
  pinBtn.className = "panel-pin-btn";
  pinBtn.innerHTML = `<svg viewBox="0 0 15 15" width="15" height="15"><circle cx="7.5" cy="7.5" r="6" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
  pinBtn.title = "Pin panel open";
  document.body.appendChild(pinBtn);

  function updatePinBtnVisibility() {
    if (isWideViewport()) {
      pinBtn.classList.remove("pin-visible", "pin-active");
      return;
    }
    const isInset = panelOverlay.classList.contains("panel-inset");
    const isOpen = !panelOverlay.classList.contains("hidden");
    if (panelPinned && isInset && isOpen) {
      pinBtn.className = "panel-pin-btn pin-active";
    } else {
      pinBtn.classList.remove("pin-active", "pin-visible");
    }
  }

  // Show pin button when mouse is in the panel-overlay zone (x: 50-350) and panel is open in inset mode
  document.addEventListener("mousemove", (e) => {
    if (isWideViewport()) {
      pinBtn.classList.remove("pin-visible", "pin-active");
      return;
    }
    const isInset = panelOverlay.classList.contains("panel-inset");
    const isOpen = !panelOverlay.classList.contains("hidden");
    if (!isInset || !isOpen) {
      pinBtn.classList.remove("pin-visible");
      if (!panelPinned) pinBtn.classList.remove("pin-active");
      return;
    }
    if (panelPinned) return; // already showing via pin-active
    if (e.clientX >= 50 && e.clientX <= 350) {
      pinBtn.classList.add("pin-visible");
    } else {
      pinBtn.classList.remove("pin-visible");
    }
  });

  pinBtn.addEventListener("click", () => {
    if (isWideViewport()) return;
    panelPinned = !panelPinned;
    panelOverlay.classList.toggle("panel-pinned", panelPinned);
    pinBtn.title = panelPinned ? "Unpin panel" : "Pin panel open";
    updatePinBtnVisibility();
  });

  function showPanel(name, content) {
    if (activePanel === name) {
      hidePanel();
      return;
    }
    if (activePanel === "versions") cleanupVersionsPanel();
    activePanel = name;
    panelOverlay.innerHTML = content;
    panelOverlay.classList.remove("hidden");
    container.classList.add("visible");
    // Recalculate column centering for inset mode
    if (state._columnResizeHandler) state._columnResizeHandler();
  }

  function hidePanel() {
    if (activePanel === "versions") cleanupVersionsPanel();
    activePanel = null;
    panelOverlay.classList.add("hidden");
    container.classList.remove("visible", "pinned");
    // Recalculate column centering for inset mode
    if (state._columnResizeHandler) state._columnResizeHandler();
  }

  // Button click handlers
  container.querySelector('[data-action="files"]').addEventListener("click", () => {
    if (activePanel === "files") {
      hidePanel();
      return;
    }
    if (activePanel === "versions") cleanupVersionsPanel();
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

  container.querySelector('[data-action="versions"]').addEventListener("click", () => {
    if (activePanel === "versions") {
      cleanupVersionsPanel();
      hidePanel();
      return;
    }
    activePanel = "versions";
    panelOverlay.innerHTML = "";
    panelOverlay.classList.remove("hidden");
    container.classList.add("visible");
    createVersionsPanel(panelOverlay, state, hidePanel);
    if (state._columnResizeHandler) state._columnResizeHandler();
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
    // Mode-active states are no longer shown in the sidebar (moved to
    // command palette), but we keep the function for event compatibility.
  }

  // Map sidebar actions to their shortcut setting keys and base labels
  const shortcutMap = {
    "files":      { label: "Files",               key: "shortcutToggleSidebar" },
  };

  // Custom graphical tooltips
  let tooltipEl = null;
  let tooltipTimeout = null;

  function createTooltipEl() {
    if (tooltipEl) return;
    tooltipEl = document.createElement("div");
    tooltipEl.className = "sidebar-tooltip";
    tooltipEl.innerHTML = `<div class="sidebar-tooltip-name"></div><div class="sidebar-tooltip-shortcut"></div>`;
    document.body.appendChild(tooltipEl);
  }

  function showTooltip(btn, name, shortcutRaw) {
    if (state.settings.hideSidebarTooltips) return;
    createTooltipEl();
    clearTimeout(tooltipTimeout);
    tooltipEl.querySelector(".sidebar-tooltip-name").textContent = name;
    const shortcutLine = tooltipEl.querySelector(".sidebar-tooltip-shortcut");
    if (shortcutRaw) {
      shortcutLine.innerHTML = formatShortcutDiagram(shortcutRaw);
      shortcutLine.style.display = "";
    } else {
      shortcutLine.style.display = "none";
    }
    const rect = btn.getBoundingClientRect();
    tooltipEl.style.top = (rect.top + rect.height / 2) + "px";
    tooltipEl.style.left = (rect.right + 8) + "px";
    tooltipEl.classList.add("visible");
  }

  function hideTooltip() {
    if (!tooltipEl) return;
    tooltipEl.classList.remove("visible");
  }

  /** Render a shortcut as minimalist key caps. */
  function formatShortcutDiagram(raw) {
    const isMac = navigator.platform?.includes("Mac") || navigator.userAgent?.includes("Mac");
    const parts = raw.split("+");
    return parts.map(p => {
      let label = p;
      if (isMac) {
        if (/^(CmdOrCtrl|Mod)$/i.test(p)) label = "\u2318";
        else if (/^Shift$/i.test(p)) label = "\u21e7";
        else if (/^Alt$/i.test(p)) label = "\u2325";
        else if (/^ArrowUp$/i.test(p)) label = "\u2191";
        else if (/^ArrowDown$/i.test(p)) label = "\u2193";
        else if (/^ArrowLeft$/i.test(p)) label = "\u2190";
        else if (/^ArrowRight$/i.test(p)) label = "\u2192";
        else if (p === "\\\\") label = "\\";
        else label = p.length === 1 ? p.toUpperCase() : p;
      } else {
        if (/^(CmdOrCtrl|Mod)$/i.test(p)) label = "Ctrl";
        else if (/^ArrowUp$/i.test(p)) label = "\u2191";
        else if (/^ArrowDown$/i.test(p)) label = "\u2193";
        else if (/^ArrowLeft$/i.test(p)) label = "\u2190";
        else if (/^ArrowRight$/i.test(p)) label = "\u2192";
        else label = p.length === 1 ? p.toUpperCase() : p;
      }
      return `<kbd>${escHtml(label)}</kbd>`;
    }).join("");
  }

  function updateButtonTitles() {
    for (const [action, info] of Object.entries(shortcutMap)) {
      const el = container.querySelector(`[data-action="${action}"]`);
      if (!el) continue;
      // Store shortcut key for tooltip use but don't set title attr
      el.dataset.shortcutKey = info.key;
    }
  }

  // Attach tooltip hover handlers to all sidebar buttons
  function bindTooltips() {
    container.querySelectorAll(".sidebar-btn").forEach(btn => {
      btn.addEventListener("mouseenter", () => {
        const action = btn.dataset.action;
        const name = btn.dataset.tooltipName || "";
        const info = shortcutMap[action];
        const shortcutRaw = info ? state.settings[info.key] : null;
        tooltipTimeout = setTimeout(() => showTooltip(btn, name, shortcutRaw), 900);
      });
      btn.addEventListener("mouseleave", () => {
        clearTimeout(tooltipTimeout);
        hideTooltip();
      });
      btn.addEventListener("click", () => {
        clearTimeout(tooltipTimeout);
        hideTooltip();
      });
    });
  }

  updateButtonTitles();
  bindTooltips();
  state.on("mode-changed", updateActiveStates);
  state.on("fullscreen-changed", updateActiveStates);
  state.on("settings-changed", updateButtonTitles);

  // Hide pin button when panel mode changes (e.g. window narrows to overlay)
  function syncPinBtn() {
    const isInset = panelOverlay.classList.contains("panel-inset");
    const isOpen = !panelOverlay.classList.contains("hidden");
    if (!isInset || !isOpen) {
      pinBtn.classList.remove("pin-visible", "pin-active");
    } else if (panelPinned) {
      pinBtn.classList.add("pin-active");
    }
  }
  window.addEventListener("resize", syncPinBtn);
  state.on("settings-changed", syncPinBtn);

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

  state.on("dropbox-status-changed", () => {
    if (activePanel === "files") {
      refreshFilesPanel(state);
    }
  });

  // Cmd+\ toggle support — force-show files (not toggle)
  state.on("show-files-panel", () => {
    if (activePanel === "versions") cleanupVersionsPanel();
    activePanel = "files";
    panelOverlay.innerHTML = "";
    panelOverlay.classList.remove("hidden");
    container.classList.add("visible");
    createFilesPanel(panelOverlay, state, hidePanel);
    if (state._columnResizeHandler) state._columnResizeHandler();
  });

  // Cmd+\ hide support — reset internal state
  state.on("hide-panel", () => {
    if (activePanel === "versions") cleanupVersionsPanel();
    activePanel = null;
    panelPinned = false;
    panelOverlay.classList.remove("panel-pinned");
    pinBtn.classList.remove("pin-active", "pin-visible");
    panelOverlay.classList.add("hidden");
    container.classList.remove("visible", "pinned");
    if (state._columnResizeHandler) state._columnResizeHandler();
  });

  // Close panel on click outside — only when the panel is overlaying the
  // content. In inset mode the panel pushes the column over rather than
  // sitting on top of it, so it should stay put until the user explicitly
  // closes it via the keyboard shortcut or a sidebar button. Pinning in
  // overlay mode opts out of auto-hide.
  document.addEventListener("mousedown", (e) => {
    if (panelOverlay.classList.contains("panel-inset")) return;
    if (panelPinned) return;
    // The version preview overlay is appended to document.body, not inside panelOverlay,
    // so check for it explicitly to avoid closing the panel when clicking restore.
    const versionOverlay = document.querySelector(".version-preview-overlay");
    if (activePanel && !panelOverlay.contains(e.target) && !container.contains(e.target) && !pinBtn.contains(e.target) && !(versionOverlay && versionOverlay.contains(e.target))) {
      hidePanel();
    }
  });

  // --- Command palette events ---
  state.on("show-styles-panel", () => {
    showPanel("styles", renderStylesPanel(state));
    bindStylesPanel(state, panelOverlay);
    container.classList.add("visible");
  });

  state.on("show-ratchet-dropdown", () => {
    if (state.ratchetMode) {
      state.stopRatchet();
      updateActiveStates();
      return;
    }
    showRatchetDropdownCentered(state, () => updateActiveStates());
  });

  state.on("show-versions-panel", () => {
    if (activePanel === "versions") {
      cleanupVersionsPanel();
      hidePanel();
      return;
    }
    activePanel = "versions";
    panelOverlay.innerHTML = "";
    panelOverlay.classList.remove("hidden");
    container.classList.add("visible");
    createVersionsPanel(panelOverlay, state, hidePanel);
    if (state._columnResizeHandler) state._columnResizeHandler();
  });

  state.on("export-current-file", () => {
    hidePanel();
    exportCurrentFile(state);
  });

  updateActiveStates();
}

function btn(action, title, svgContent) {
  return `<button class="sidebar-btn" data-action="${action}" data-tooltip-name="${title}">
    <svg viewBox="0 0 24 24">${svgContent}</svg>
  </button>`;
}

// Minimalist SVG icons (loaded from src/sidebar_icons/)
const icons = {
  files: svgInner(filesRaw),
  versions: svgInner(versionsRaw),
  export: svgInner(exportRaw),
  settings: svgInner(settingsRaw),
  styles: svgInner(stylesRaw),
};

/** Ratchet dropdown positioned center-screen (used by command palette). */
function showRatchetDropdownCentered(state, onStart) {
  document.querySelectorAll(".ratchet-dropdown").forEach((el) => el.remove());

  const dropdown = document.createElement("div");
  dropdown.className = "ratchet-dropdown ratchet-dropdown-centered";

  // Options section (checkboxes)
  const optionsSection = document.createElement("div");
  optionsSection.className = "ratchet-options-section";

  const encourageLabel = document.createElement("label");
  encourageLabel.className = "ratchet-checkbox-label";
  const encourageCheckbox = document.createElement("input");
  encourageCheckbox.type = "checkbox";
  encourageCheckbox.checked = !!state.settings.ratchetEncourageTyping;
  encourageCheckbox.addEventListener("change", () => {
    state.updateSettings({ ratchetEncourageTyping: encourageCheckbox.checked });
  });
  encourageLabel.appendChild(encourageCheckbox);
  encourageLabel.appendChild(document.createTextNode(" Encourage typing"));
  optionsSection.appendChild(encourageLabel);
  dropdown.appendChild(optionsSection);

  const grid = document.createElement("div");
  grid.className = "ratchet-duration-grid";
  const durations = [5, 10, 15, 20, 25, 30, 45, 60];
  durations.forEach((min) => {
    const opt = document.createElement("div");
    opt.className = "ratchet-option";
    opt.textContent = min === 60 ? "1 hr" : `${min} min`;
    opt.addEventListener("click", () => {
      state.startRatchet(min);
      dropdown.remove();
      onStart();
    });
    grid.appendChild(opt);
  });
  dropdown.appendChild(grid);
  document.body.appendChild(dropdown);

  setTimeout(() => {
    document.addEventListener("mousedown", function handler(e) {
      if (!dropdown.contains(e.target)) {
        dropdown.remove();
        document.removeEventListener("mousedown", handler);
      }
    });
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
    ? (findNode(state.fileTree, state.currentProjectId)?.name || "project-export")
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
