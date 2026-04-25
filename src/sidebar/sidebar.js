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

  // Floating circular sidebar-toggle button. Lives above every other
  // chrome element so keyboard-free users (iPad, Pencil) have a
  // persistent way to open the left panel — desktop users reach the
  // same action via Cmd+\. Emits `toggle-left-panel`, which the main
  // handler either force-opens the files panel on or hides-all-panels.
  const sidebarToggleBtn = document.createElement("button");
  sidebarToggleBtn.className = "sidebar-floating-toggle";
  sidebarToggleBtn.title = "Toggle files panel";
  sidebarToggleBtn.innerHTML = sidebarToggleSvg("expand");
  document.body.appendChild(sidebarToggleBtn);
  sidebarToggleBtn.addEventListener("click", () => {
    state.emit("toggle-left-panel");
  });
  function syncSidebarToggleIcon() {
    const isOpen = !panelOverlay.classList.contains("hidden");
    sidebarToggleBtn.innerHTML = sidebarToggleSvg(isOpen ? "collapse" : "expand");
    sidebarToggleBtn.title = isOpen ? "Close panel" : "Open files panel";
    // CSS positions the button relative to the panel's right edge when
    // this class is set — keeps the gap constant as the panel opens,
    // closes, or is resized.
    sidebarToggleBtn.classList.toggle("panel-open", isOpen);
  }
  // MutationObserver: the panel's visibility is driven by class-flipping
  // on #panel-overlay (panel-inset, hidden, panel-pinned) rather than a
  // state event, so watch DOM classes to keep the icon in sync.
  new MutationObserver(syncSidebarToggleIcon).observe(panelOverlay, {
    attributes: true, attributeFilter: ["class"],
  });
  syncSidebarToggleIcon();

  // Typing-fade. In the markdown editor the floating toggle, the
  // sidebar's icon column, and the files panel's "new item" buttons all
  // hover over the writing column; fading them out while the user types
  // keeps the page clean. Any pointer activity (mousemove / tap) brings
  // them back immediately. Notebook mode is exempt — typing there is
  // rare and the buttons need to stay reachable for Pencil-only users.
  // The class lives on <body> so a single CSS rule can target every
  // affected icon group.
  function endTypingFade() {
    if (document.body.classList.contains("typing-fade")) {
      document.body.classList.remove("typing-fade");
    }
  }
  document.addEventListener("keydown", (e) => {
    if (document.body.classList.contains("notebook-mode")) return;
    // Ignore modifier-only taps (Shift/Cmd/Ctrl/Alt) — those aren't
    // "the user is actively writing prose" and shouldn't hide the UI.
    if (e.key === "Shift" || e.key === "Control" || e.key === "Meta" ||
        e.key === "Alt" || e.key === "Escape") return;
    // And ignore any keystroke that's part of a shortcut combination —
    // Cmd+\ to open the panel, Cmd+S, navigation chords, etc. — so
    // reaching for the sidebar via keyboard doesn't paradoxically hide
    // it the moment it opens.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    const isEditable =
      (t && t.closest && t.closest(".cm-content")) ||
      (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable));
    if (!isEditable) return;
    document.body.classList.add("typing-fade");
  });
  document.addEventListener("pointermove", endTypingFade);
  document.addEventListener("pointerdown", endTypingFade);
  // Whenever a panel is opened (toggle button, command palette, file
  // picker, …) we want the icons fully visible again — even if the
  // user reached us by keyboard. Listening on the panel-overlay's
  // class flips covers all those open-paths uniformly.
  new MutationObserver(() => {
    if (!panelOverlay.classList.contains("hidden")) endTypingFade();
  }).observe(panelOverlay, { attributes: true, attributeFilter: ["class"] });

  // Set up panel-width CSS var from persisted setting, then install the
  // invisible-until-hover right-edge resizer.
  applyPanelWidth(state.settings.sidebarPanelWidth || 300);
  const panelResizer = createPanelResizer(state, panelOverlay);
  document.body.appendChild(panelResizer);
  positionPanelResizer(panelResizer, panelOverlay);

  function isWideViewport() {
    return window.innerWidth > 700;
  }

  // Pin toggle button — fixed position, shown when hovering panel zone in inset mode.
  // Hidden entirely on wide viewports (>700px), where the sidebar is always open.
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
    const panelW = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--panel-width"), 10) || 300;
    if (e.clientX >= 50 && e.clientX <= 50 + panelW) {
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
    if (state.currentNotebookFileId) {
      const { openNotebookExportModal } = await import("./notebook-export-modal.js");
      await openNotebookExportModal(state);
      return;
    }
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

  // The Local Sync list lives in settings.localSyncFolders — when the
  // settings window adds or removes one, re-render the files panel so
  // the sidebar reflects the change. We always call refreshFilesPanel:
  // if the panel isn't currently open, the refresh is effectively a
  // no-op (the render functions guard against missing containers), and
  // the user still gets a fresh fetch next time they open the panel.
  let _lastLocalSyncSerialised = JSON.stringify(state.settings.localSyncFolders || []);
  state.on("settings-changed", () => {
    const next = JSON.stringify(state.settings.localSyncFolders || []);
    if (next !== _lastLocalSyncSerialised) {
      _lastLocalSyncSerialised = next;
      refreshFilesPanel(state);
    }
  });
  // Dedicated event — the settings window emits this after add/remove
  // so the refresh path doesn't depend on the generic settings-updated
  // round-trip (which can be delayed by other settings work).
  state.on("local-sync-changed", () => refreshFilesPanel(state));

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
    // The panel resizer sits OUTSIDE the panel (anchored to its right
    // edge) so it also needs an explicit allowlist entry — otherwise
    // mousedown on the resizer triggers the click-outside close.
    if (
      activePanel &&
      !panelOverlay.contains(e.target) &&
      !container.contains(e.target) &&
      !pinBtn.contains(e.target) &&
      !panelResizer.contains(e.target) &&
      !(versionOverlay && versionOverlay.contains(e.target))
    ) {
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

  state.on("export-current-file", async () => {
    hidePanel();
    if (state.currentNotebookFileId) {
      const { openNotebookExportModal } = await import("./notebook-export-modal.js");
      await openNotebookExportModal(state);
      return;
    }
    exportCurrentFile(state);
  });

  updateActiveStates();
}

function btn(action, title, svgContent) {
  return `<button class="sidebar-btn" data-action="${action}" data-tooltip-name="${title}">
    <svg viewBox="0 0 24 24">${svgContent}</svg>
  </button>`;
}

/** SVG for the floating sidebar toggle — expand/collapse variants
 *  pulled from temp-icons with stroke="currentColor" for theme inheritance. */
function sidebarToggleSvg(variant) {
  // Match the notebook shelf's grip — a single guillemet that rotates
  // direction with the panel state. The sidebar lives on the left, so
  // the directions are mirrored from the shelf (which lives on the
  // right). Closed → "›" (open this way); open → "‹" (close this way).
  return variant === "collapse" ? "‹" : "›";
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

  const { collectImageRefs } = await import("../state/state-images.js");
  const images = collectImageRefs(state, content);

  const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
  if (IS_TAURI) {
    try {
      if (images.length === 0) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const filePath = await save({
          defaultPath: `${name}.md`,
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });
        if (filePath) {
          const { writeTextFile } = await import("@tauri-apps/plugin-fs");
          await writeTextFile(filePath, content);
        }
        return;
      }
      // Has images — export as a folder containing text.md + images/
      const { save } = await import("@tauri-apps/plugin-dialog");
      const target = await save({ defaultPath: name });
      if (!target) return;
      const markdown = rewriteImageRefsForExport(content, images);
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("export_with_images", {
        folder: target,
        markdown,
        images,
      });
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

/**
 * Rewrite doc markdown so each local image ref gets a relative
 * `images/<filename>` URL. External URLs pass through untouched. Quoted
 * URLs are handled by the shared markdown regex.
 */
function rewriteImageRefsForExport(content, images) {
  const tracked = new Set(images);
  return content.replace(
    /!\[([^\]]*)\]\(\s*(?:"([^"]+)"|([^()\s"]+))(?:\s+"[^"]*")?\s*\)/g,
    (match, alt, quotedUrl, bareUrl) => {
      const raw = quotedUrl != null ? quotedUrl : bareUrl;
      const bare = raw.replace(/^images\//, "");
      if (!tracked.has(bare)) return match;
      const next = `images/${bare}`;
      const wrapped = /[\s()]/.test(next) ? `"${next}"` : next;
      return `![${alt}](${wrapped})`;
    }
  );
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Sidebar panel width ────────────────────────────────────────────────

const PANEL_WIDTH_MIN = 220;
const PANEL_WIDTH_MAX_FRAC = 0.5; // never take more than half the viewport

function applyPanelWidth(px) {
  const clamped = Math.max(PANEL_WIDTH_MIN, Math.min(window.innerWidth * PANEL_WIDTH_MAX_FRAC, px));
  document.documentElement.style.setProperty("--panel-width", clamped + "px");
}

function positionPanelResizer(el, panelOverlay) {
  const isOpen = !panelOverlay.classList.contains("hidden");
  if (!isOpen) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const rect = panelOverlay.getBoundingClientRect();
  // Center the 40-px hit zone on the panel's right edge.
  el.style.left = rect.right + "px";
}

function createPanelResizer(state, panelOverlay) {
  const el = document.createElement("div");
  el.className = "sidebar-panel-resizer hidden";

  let hideTimeout = null;
  const show = () => { clearTimeout(hideTimeout); el.classList.add("hover"); };
  const hide = () => {
    hideTimeout = setTimeout(() => el.classList.remove("hover"), 200);
  };
  el.addEventListener("mouseenter", show);
  el.addEventListener("mouseleave", hide);

  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelOverlay.getBoundingClientRect().width;
    el.classList.add("dragging");
    show();

    const onMove = (me) => {
      const next = startWidth + (me.clientX - startX);
      applyPanelWidth(next);
      positionPanelResizer(el, panelOverlay);
      // Editor column layout re-centers when the panel is inset
      if (state._columnResizeHandler) state._columnResizeHandler();
    };
    const onUp = () => {
      el.classList.remove("dragging");
      hide();
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      // Persist the final width (read back from the CSS var — clamped)
      const computed = getComputedStyle(document.documentElement).getPropertyValue("--panel-width").trim();
      const n = parseInt(computed, 10);
      if (Number.isFinite(n) && n > 0) state.updateSettings({ sidebarPanelWidth: n });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // Keep the resizer glued to the panel's right edge when the panel opens,
  // closes, or the viewport resizes.
  const sync = () => positionPanelResizer(el, panelOverlay);
  new MutationObserver(sync).observe(panelOverlay, { attributes: true, attributeFilter: ["class", "style"] });
  window.addEventListener("resize", () => {
    // Re-clamp against new viewport width
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--panel-width"), 10) || 300;
    applyPanelWidth(current);
    sync();
  });

  return el;
}
