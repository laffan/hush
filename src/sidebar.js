/**
 * Sidebar UI — icons, panels, mode toggles (LEFT side)
 */
import { isIOS, openSettingsWindow } from "./settings-ui.js";
import { createFilesPanel, refreshFilesPanel } from "./files-panel.js";
import { findNode } from "./tree-helpers.js";
import { renderStylesPanel, bindStylesPanel } from "./styles-panel.js";
import { createVersionsPanel, cleanupVersionsPanel } from "./versions-panel.js";
import newFileRaw from "./sidebar_icons/newFile.svg?raw";
import filesRaw from "./sidebar_icons/files.svg?raw";
import ratchetRaw from "./sidebar_icons/ratchet.svg?raw";
import privateRaw from "./sidebar_icons/private.svg?raw";
import typewriterRaw from "./sidebar_icons/typewriter.svg?raw";
import dryRaw from "./sidebar_icons/dry.svg?raw";
import focusRaw from "./sidebar_icons/focus.svg?raw";
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
      ${btn("new-file", "New file", icons.newFile)}
      ${btn("files", "Files", icons.files)}
      ${btn("styles", "Styles", icons.styles)}
    </div>
    <div class="sidebar-group sidebar-middle">
      ${btn("ratchet", "Ratchet mode", icons.ratchet)}
      ${btn("private", "Private mode", icons.private)}
      ${btn("typewriter", "Typewriter mode", icons.typewriter)}
      ${btn("dry", "D.R.Y. highlighting", icons.dry)}
      ${btn("focus", "Focus mode", icons.focus)}
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

  // Pin toggle button — fixed position, shown when hovering panel zone in inset mode
  const pinBtn = document.createElement("button");
  pinBtn.className = "panel-pin-btn";
  pinBtn.innerHTML = `<svg viewBox="0 0 15 15" width="15" height="15"><circle cx="7.5" cy="7.5" r="6" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
  pinBtn.title = "Pin panel open";
  document.body.appendChild(pinBtn);

  function updatePinBtnVisibility() {
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
    if (panelPinned && panelOverlay.classList.contains("panel-inset")) return;
    if (activePanel === "versions") cleanupVersionsPanel();
    activePanel = null;
    panelOverlay.classList.add("hidden");
    container.classList.remove("visible", "pinned");
    // Recalculate column centering for inset mode
    if (state._columnResizeHandler) state._columnResizeHandler();
  }

  // Button click handlers
  container.querySelector('[data-action="new-file"]').addEventListener("click", () => {
    if (activePanel === "versions") cleanupVersionsPanel();
    state.newFile();
    hidePanel();
  });

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

  container.querySelector('[data-action="dry"]').addEventListener("click", () => {
    state.toggleDry();
    updateActiveStates();
  });

  container.querySelector('[data-action="focus"]').addEventListener("click", () => {
    state.toggleFocus();
    updateActiveStates();
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
    setActive("ratchet", state.ratchetMode);
    setActive("private", state.privateMode);
    setActive("typewriter", state.typewriterMode);
    setActive("dry", state.dryMode);
    setActive("focus", state.focusMode);
  }

  function setActive(action, isActive) {
    const el = container.querySelector(`[data-action="${action}"]`);
    if (el) el.classList.toggle("active", isActive);
  }

  // Map sidebar actions to their shortcut setting keys and base labels
  const shortcutMap = {
    "new-file":   { label: "New file",            key: "shortcutNewFile" },
    "files":      { label: "Files",               key: "shortcutToggleSidebar" },
    "private":    { label: "Private mode",         key: "shortcutTogglePrivate" },
    "typewriter": { label: "Typewriter mode",      key: "shortcutTypewriter" },
    "dry":        { label: "D.R.Y. highlighting",  key: "shortcutToggleDry" },
    "focus":      { label: "Focus mode",           key: "shortcutToggleFocus" },
  };

  function updateButtonTitles() {
    for (const [action, info] of Object.entries(shortcutMap)) {
      const el = container.querySelector(`[data-action="${action}"]`);
      if (!el) continue;
      const raw = state.settings[info.key];
      if (raw) {
        el.title = `${info.label}  (${formatShortcut(raw)})`;
      } else {
        el.title = info.label;
      }
    }
  }

  updateButtonTitles();
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

  // Close panel on click outside (unless pinned in inset mode)
  document.addEventListener("mousedown", (e) => {
    const pinActive = panelPinned && panelOverlay.classList.contains("panel-inset");
    // The version preview overlay is appended to document.body, not inside panelOverlay,
    // so check for it explicitly to avoid closing the panel when clicking restore.
    const versionOverlay = document.querySelector(".version-preview-overlay");
    if (activePanel && !pinActive && !panelOverlay.contains(e.target) && !container.contains(e.target) && !pinBtn.contains(e.target) && !(versionOverlay && versionOverlay.contains(e.target))) {
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

// Minimalist SVG icons (loaded from src/sidebar_icons/)
const icons = {
  newFile: svgInner(newFileRaw),
  files: svgInner(filesRaw),
  ratchet: svgInner(ratchetRaw),
  private: svgInner(privateRaw),
  typewriter: svgInner(typewriterRaw),
  dry: svgInner(dryRaw),
  focus: svgInner(focusRaw),
  versions: svgInner(versionsRaw),
  export: svgInner(exportRaw),
  settings: svgInner(settingsRaw),
  styles: svgInner(stylesRaw),
};

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

/** Format a shortcut string like "Mod+Shift+P" into "⌘⇧P" (Mac) or "Ctrl+Shift+P". */
function formatShortcut(raw) {
  const isMac = navigator.platform?.includes("Mac") || navigator.userAgent?.includes("Mac");
  let s = raw;
  if (isMac) {
    s = s.replace(/CmdOrCtrl\+/gi, "\u2318").replace(/Mod\+/gi, "\u2318")
         .replace(/Shift\+/gi, "\u21e7").replace(/Alt\+/gi, "\u2325")
         .replace(/ArrowUp/gi, "\u2191").replace(/ArrowDown/gi, "\u2193")
         .replace(/ArrowLeft/gi, "\u2190").replace(/ArrowRight/gi, "\u2192")
         .replace(/\\\\/g, "\\");
  } else {
    s = s.replace(/CmdOrCtrl\+/gi, "Ctrl+").replace(/Mod\+/gi, "Ctrl+")
         .replace(/ArrowUp/gi, "Up").replace(/ArrowDown/gi, "Down")
         .replace(/ArrowLeft/gi, "Left").replace(/ArrowRight/gi, "Right");
  }
  return s;
}
