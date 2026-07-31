/**
 * Sidebar — left-edge panel hosting the file tree.
 *
 * The legacy icon column (#sidebar) is gone. #panel-overlay is the sidebar
 * itself, anchored at left:0. Styles, Versions, and Export are reachable
 * exclusively through the command palette; the footer holds Settings and
 * an Add (+) button (popup over Doc / Notebook / Folder / Project). A
 * full-height grip on the right edge toggles the panel open/closed.
 */
import { openSettingsWindow } from "../settings/settings-ui.js";
import { createFilesPanel, refreshFilesPanel } from "./files-panel.js";
import { createFindPanel, closeFindPanel } from "./find-panel.js";
import { cleanupVersionsPanel } from "./versions-panel.js";
import { showRatchetDropdownCentered } from "./ratchet-dropdown.js";
import { attachGripResize, applyPanelWidth } from "./panel-resizer.js";
import { mountDeskSwitcher } from "./desk-switcher.js";
import { mountAddPopup } from "./add-popup.js";
import { mountProgressCenter } from "./sidebar-progress.js";
import { createRecentFilesPanel } from "./recent-files-panel.js";
import settingsRaw from "./sidebar_icons/settings.svg?raw";

function svgInner(raw) {
  return raw.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "").trim();
}

export function createSidebar(state) {
  const panelOverlay = document.getElementById("panel-overlay");
  let panelOpen = false;
  let panelPinned = false;
  // "files" (default) or "find" — the body content swaps wholesale when
  // the Find panel takes over the sidebar.
  let panelMode = "files";
  let findPanelHandle = null;

  let _suppressStatePersist = true;
  function persistSidebarState() {
    if (_suppressStatePersist) return;
    // Desks own the left-panel toggle state: record it against the active
    // desk so switching back restores this layout. `right` is owned by the
    // outline panel (right-panel-setup.js) — preserve whatever it stored.
    const deskId = state.settings?.activeDeskId;
    const deskSidebars = { ...(state.settings?.deskSidebars || {}) };
    if (deskId) {
      deskSidebars[deskId] = {
        ...(deskSidebars[deskId] || {}),
        left: panelOpen,
        leftPinned: panelPinned,
      };
    }
    state.updateSettings({
      sidebarOpenPanel: panelOpen ? "files" : null,
      sidebarPinned: panelPinned,
      deskSidebars,
    }).catch((e) => console.warn("Save sidebar state failed:", e));
  }

  // Build the panel skeleton: a flex row of body-stack + grip. The grip
  // sits flush against the right edge so it stays visible even when the
  // body-stack collapses to width:0. Header / body / footer all live
  // inside the body-stack so a single class flip can hide them as a unit.
  panelOverlay.innerHTML = "";
  const bodyStack = document.createElement("div");
  bodyStack.className = "panel-overlay-body-stack";

  const header = document.createElement("div");
  header.className = "panel-overlay-header";

  const body = document.createElement("div");
  body.className = "panel-overlay-body";

  const footer = document.createElement("div");
  footer.className = "panel-overlay-footer";

  const addBtn = document.createElement("button");
  addBtn.className = "panel-footer-btn panel-footer-add";
  addBtn.type = "button";
  addBtn.title = "Add";
  addBtn.setAttribute("aria-label", "Add");
  addBtn.innerHTML = `<span class="panel-footer-icon" aria-hidden="true">+</span><span class="panel-footer-label">Add</span>`;
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    mountAddPopup(state, addBtn);
  });

  const settingsBtn = document.createElement("button");
  settingsBtn.className = "panel-footer-btn panel-footer-settings";
  settingsBtn.type = "button";
  settingsBtn.title = "Settings";
  settingsBtn.setAttribute("aria-label", "Settings");
  settingsBtn.innerHTML = `<span class="panel-footer-icon"><svg viewBox="0 0 24 24">${svgInner(settingsRaw)}</svg></span><span class="panel-footer-label">Settings</span>`;
  settingsBtn.addEventListener("click", () => openSettingsWindow(state));

  footer.appendChild(addBtn);
  footer.appendChild(settingsBtn);

  // Right-aligned sync/progress group
  const syncGroup = document.createElement("div");
  syncGroup.className = "sidebar-sync-group";
  footer.appendChild(syncGroup);

  bodyStack.appendChild(header);
  bodyStack.appendChild(body);
  bodyStack.appendChild(footer);

  // Recent Files panel sits between the body (file tree / find) and the
  // footer (Add / Settings). Inserted lazily based on settings.
  let recentPanel = null;
  function syncRecentPanel() {
    const want = !!state.settings.showRecentFiles;
    if (want && !recentPanel) {
      recentPanel = createRecentFilesPanel(state);
      bodyStack.insertBefore(recentPanel, footer);
    } else if (!want && recentPanel) {
      if (recentPanel._destroy) recentPanel._destroy();
      recentPanel.remove();
      recentPanel = null;
    }
  }
  syncRecentPanel();
  state.on("settings-changed", syncRecentPanel);

  // Full-height grip on the right edge. The grip carries two children:
  // a wide click-to-toggle button on the left, and a narrow drag-to-
  // resize strip flush against the panel's outer edge. Border on the
  // toggle's inner edge fades in only on hover.
  const grip = document.createElement("div");
  grip.className = "sidebar-grip";

  const gripToggle = document.createElement("button");
  gripToggle.className = "sidebar-grip-toggle";
  gripToggle.type = "button";
  gripToggle.innerHTML = `<span class="sidebar-grip-chevron">›</span>`;
  gripToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    state.emit("toggle-left-panel");
  });

  const gripResize = document.createElement("div");
  gripResize.className = "sidebar-grip-resize";

  grip.appendChild(gripToggle);
  grip.appendChild(gripResize);

  panelOverlay.appendChild(bodyStack);
  panelOverlay.appendChild(grip);
  mountDeskSwitcher(header, state);

  // Sync the chevron direction with the panel's hidden / open state.
  function syncGripGlyph() {
    const isOpen = !panelOverlay.classList.contains("hidden");
    gripToggle.querySelector(".sidebar-grip-chevron").textContent = isOpen ? "‹" : "›";
  }
  new MutationObserver(syncGripGlyph).observe(panelOverlay, { attributes: true, attributeFilter: ["class"] });
  syncGripGlyph();

  // Zotero progress center — background-task ring in the footer's
  // sync group.
  mountProgressCenter(syncGroup, state);

  // Typing-fade — hide the create / add affordances while the user is
  // actively typing in the doc editor. Pointer activity (mousemove /
  // tap) brings them back. Notebook mode is exempt so Pencil-only users
  // still have the controls reachable. The grip stays visible — it's
  // the only affordance for opening / closing the panel.
  function endTypingFade() {
    if (document.body.classList.contains("typing-fade")) {
      document.body.classList.remove("typing-fade");
    }
  }
  document.addEventListener("keydown", (e) => {
    if (document.body.classList.contains("notebook-mode")) return;
    if (e.key === "Shift" || e.key === "Control" || e.key === "Meta" ||
        e.key === "Alt" || e.key === "Escape") return;
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
  new MutationObserver(() => {
    if (!panelOverlay.classList.contains("hidden")) endTypingFade();
  }).observe(panelOverlay, { attributes: true, attributeFilter: ["class"] });

  // Set up panel-width CSS var from persisted setting, then wire the
  // grip's narrow right-edge strip up as the drag-to-resize handle.
  applyPanelWidth(state.settings.sidebarPanelWidth || 300);
  attachGripResize(state, gripResize, panelOverlay);

  function isWideViewport() {
    return window.innerWidth > 700;
  }

  function mountFilesBody() {
    panelMode = "files";
    panelOverlay.classList.remove("panel-find-mode");
    if (findPanelHandle) findPanelHandle = null;
    body.innerHTML = "";
    createFilesPanel(body, state, hidePanel);
  }

  function mountFindBody(opts = {}) {
    panelMode = "find";
    panelOverlay.classList.add("panel-find-mode");
    body.innerHTML = "";
    findPanelHandle = createFindPanel(body, state, () => {
      // Find panel closed — swap back to the files list. Sidebar stays open.
      findPanelHandle = null;
      mountFilesBody();
    }, opts);
  }

  function openPanel() {
    if (panelOpen) return;
    panelOpen = true;
    panelOverlay.classList.remove("hidden");
    mountFilesBody();
    if (state.runtime.columnResizeHandler) state.runtime.columnResizeHandler();
    persistSidebarState();
  }

  function hidePanel() {
    if (!panelOpen) {
      panelOverlay.classList.add("hidden");
      return;
    }
    panelOpen = false;
    cleanupVersionsPanel();
    if (panelMode === "find") {
      closeFindPanel();
      panelMode = "files";
      panelOverlay.classList.remove("panel-find-mode");
    }
    panelOverlay.classList.add("hidden");
    if (state.runtime.columnResizeHandler) state.runtime.columnResizeHandler();
    persistSidebarState();
  }

  // Close panel on click outside — only in overlay (non-inset) mode.
  document.addEventListener("mousedown", (e) => {
    if (panelOverlay.classList.contains("panel-inset")) return;
    if (panelPinned) return;
    const versionOverlay = document.querySelector(".version-preview-overlay");
    if (
      panelOpen &&
      !panelOverlay.contains(e.target) &&
      !(versionOverlay && versionOverlay.contains(e.target))
    ) {
      hidePanel();
    }
  });

  // --- Cross-module events ---
  state.on("show-files-panel", () => {
    if (!panelOpen) { openPanel(); return; }
    if (panelMode === "find") {
      closeFindPanel();
      mountFilesBody();
    }
  });
  state.on("show-find-panel", (opts) => {
    // Sidebar opens (if not already) and switches to Find. The Files panel
    // is restored when the find panel closes (either via × or Esc).
    if (!panelOpen) {
      panelOpen = true;
      panelOverlay.classList.remove("hidden");
      persistSidebarState();
      if (state.runtime.columnResizeHandler) state.runtime.columnResizeHandler();
    }
    mountFindBody(opts || {});
  });
  state.on("hide-panel", () => {
    panelPinned = false;
    panelOverlay.classList.remove("panel-pinned");
    hidePanel();
  });
  state.on("show-styles-panel", async () => {
    const { openStyleEditorModal } = await import("./style-modal.js");
    openStyleEditorModal(state);
  });
  state.on("show-versions-panel", async () => {
    const { openVersionsModal } = await import("./versions-modal.js");
    openVersionsModal(state);
  });
  state.on("show-history-panel", async () => {
    const { toggleHistoryPanel } = await import("./history-panel.js");
    toggleHistoryPanel(state);
  });
  state.on("show-ratchet-dropdown", () => {
    if (state.ratchetMode) { state.stopRatchet(); return; }
    showRatchetDropdownCentered(state, () => {});
  });
  state.on("export-current-file", async () => {
    if (state.currentStackFileId) {
      const { exportCurrentStack } = await import("./stack-export.js");
      await exportCurrentStack(state);
      return;
    }
    if (state.currentNotebookFileId) {
      const { openNotebookExportModal } = await import("./notebook-export-modal.js");
      await openNotebookExportModal(state);
      return;
    }
    const { openDocExportModal } = await import("./doc-export-modal.js");
    await openDocExportModal(state);
  });

  state.on("files-changed", () => { if (panelOpen && panelMode === "files") refreshFilesPanel(state); });
  state.on("multi-select-changed", () => {
    if (!panelOpen) return;
    const selected = new Set(state.selectedDocIds || []);
    panelOverlay.querySelectorAll(".sl-item[data-file-id]").forEach((li) => {
      li.classList.toggle("multi-selected", selected.has(li.dataset.fileId));
    });
  });
  state.on("active-desk-changed", (deskId) => {
    // Restore this desk's saved left-panel layout (desks own the toggle
    // state). Only act when the desk has a recorded preference so a
    // first-ever switch leaves the current layout untouched.
    const id = deskId || state.settings?.activeDeskId;
    const saved = id ? (state.settings?.deskSidebars || {})[id] : null;
    if (saved && typeof saved.left === "boolean") {
      if (saved.leftPinned && !isWideViewport()) {
        panelPinned = true;
        panelOverlay.classList.add("panel-pinned");
      } else if (panelPinned) {
        panelPinned = false;
        panelOverlay.classList.remove("panel-pinned");
      }
      if (saved.left) openPanel(); else hidePanel();
    }
    if (panelOpen && panelMode === "files") refreshFilesPanel(state);
  });
  state.on("desks-changed", () => { if (panelOpen && panelMode === "files") refreshFilesPanel(state); });

  let _lastLocalSyncSerialised = JSON.stringify(state.settings.localSyncFolders || []);
  let _lastGoogleLinksSerialised = JSON.stringify(state.settings.googleDocLinks || {});
  let _lastDeskDisplayMode = state.settings.deskDisplayMode || "single";
  let _lastShowHeadings = !!state.settings.showProjectHeadings;
  state.on("settings-changed", () => {
    const next = JSON.stringify(state.settings.localSyncFolders || []);
    if (next !== _lastLocalSyncSerialised) {
      _lastLocalSyncSerialised = next;
      if (panelMode === "files") refreshFilesPanel(state);
    }
    const nextGdoc = JSON.stringify(state.settings.googleDocLinks || {});
    if (nextGdoc !== _lastGoogleLinksSerialised) {
      _lastGoogleLinksSerialised = nextGdoc;
      if (panelMode === "files") refreshFilesPanel(state);
    }
    // Switching between "single desk" and "all desks" reshapes the whole
    // tree (desks become top-level rows or fold away), so repaint.
    const nextMode = state.settings.deskDisplayMode || "single";
    if (nextMode !== _lastDeskDisplayMode) {
      _lastDeskDisplayMode = nextMode;
      if (panelMode === "files") refreshFilesPanel(state);
    }
    // Toggling the per-doc heading rows adds / removes synthetic children
    // across the whole tree, so repaint on change.
    const nextHeadings = !!state.settings.showProjectHeadings;
    if (nextHeadings !== _lastShowHeadings) {
      _lastShowHeadings = nextHeadings;
      if (panelMode === "files") refreshFilesPanel(state);
    }
  });
  state.on("local-sync-changed", () => { if (panelMode === "files") refreshFilesPanel(state); });
  state.on("file-opened", () => { if (panelOpen && panelMode === "files") refreshFilesPanel(state); });
  state.on("notebook-open", () => { if (panelOpen && panelMode === "files") refreshFilesPanel(state); });
  state.on("stack-open", () => { if (panelOpen && panelMode === "files") refreshFilesPanel(state); });
  state.on("pdf-open", () => { if (panelOpen && panelMode === "files") refreshFilesPanel(state); });
  state.on("panes-changed", () => { if (panelOpen && panelMode === "files") refreshFilesPanel(state); });
  state.on("panes-hidden-changed", () => { if (panelOpen && panelMode === "files") refreshFilesPanel(state); });
  state.on("stickies-changed", () => { if (panelOpen && panelMode === "files") refreshFilesPanel(state); });
  state.on("you-are-here-changed", () => { if (panelOpen && panelMode === "files") refreshFilesPanel(state); });
  // Cross-window settings merge — a sibling's sticky / pane / marker
  // writes landed in state.settings; repaint the indicator squares.
  state.on("remote-settings-merged", () => { if (panelOpen && panelMode === "files") refreshFilesPanel(state); });
  state.on("windows-changed", () => { if (panelOpen && panelMode === "files") refreshFilesPanel(state); });

  // Replay persisted open state. Any truthy value reopens the Files
  // panel since that's the only panel that lives in the sidebar now.
  if (state.settings?.sidebarOpenPanel) {
    openPanel();
  }
  if (state.settings?.sidebarPinned && !isWideViewport()) {
    panelPinned = true;
    panelOverlay.classList.add("panel-pinned");
  }
  _suppressStatePersist = false;
}
