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
import { cleanupVersionsPanel } from "./versions-panel.js";
import { showRatchetDropdownCentered } from "./ratchet-dropdown.js";
import { createPanelResizer, applyPanelWidth, positionPanelResizer } from "./panel-resizer.js";
import { mountDeskSwitcher } from "./desk-switcher.js";
import { mountAddPopup } from "./add-popup.js";
import settingsRaw from "./sidebar_icons/settings.svg?raw";

function svgInner(raw) {
  return raw.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "").trim();
}

export function createSidebar(state) {
  const panelOverlay = document.getElementById("panel-overlay");
  let panelOpen = false;
  let panelPinned = false;

  let _suppressStatePersist = true;
  function persistSidebarState() {
    if (_suppressStatePersist) return;
    state.updateSettings({
      sidebarOpenPanel: panelOpen ? "files" : null,
      sidebarPinned: panelPinned,
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

  bodyStack.appendChild(header);
  bodyStack.appendChild(body);
  bodyStack.appendChild(footer);

  // Full-height grip on the right edge — flips the panel open / closed.
  // Border fades in only on hover (CSS handles the transition).
  const grip = document.createElement("button");
  grip.className = "sidebar-grip";
  grip.type = "button";
  grip.setAttribute("aria-label", "Toggle files panel");
  grip.title = "Toggle files panel";
  grip.innerHTML = `<span class="sidebar-grip-chevron">›</span>`;
  grip.addEventListener("click", (e) => {
    e.stopPropagation();
    state.emit("toggle-left-panel");
  });

  panelOverlay.appendChild(bodyStack);
  panelOverlay.appendChild(grip);
  mountDeskSwitcher(header, state);

  // Sync the chevron direction with the panel's hidden / open state.
  function syncGripGlyph() {
    const isOpen = !panelOverlay.classList.contains("hidden");
    grip.querySelector(".sidebar-grip-chevron").textContent = isOpen ? "‹" : "›";
    grip.title = isOpen ? "Close panel" : "Open files panel";
  }
  new MutationObserver(syncGripGlyph).observe(panelOverlay, { attributes: true, attributeFilter: ["class"] });
  syncGripGlyph();

  // Dropbox sync indicator — small dot inside the grip, pulses on each
  // successful sync. Hidden unless sync is configured.
  const syncDot = document.createElement("div");
  syncDot.className = "sidebar-sync-dot";
  syncDot.setAttribute("aria-hidden", "true");
  grip.appendChild(syncDot);
  function syncDotVisible() {
    return !!(state.settings.dropboxEnabled && state.settings.dropboxSyncPath);
  }
  function refreshSyncDot() {
    syncDot.classList.toggle("visible", syncDotVisible());
  }
  let _syncPulseTimer = null;
  function pulseSyncDot() {
    if (!syncDotVisible()) return;
    syncDot.classList.remove("pulse");
    void syncDot.offsetWidth;
    syncDot.classList.add("pulse");
    if (_syncPulseTimer) clearTimeout(_syncPulseTimer);
    _syncPulseTimer = setTimeout(() => syncDot.classList.remove("pulse"), 900);
  }
  state.on("settings-changed", refreshSyncDot);
  state.on("dropbox-sync-success", pulseSyncDot);
  refreshSyncDot();

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

  // Set up panel-width CSS var from persisted setting, then install the
  // invisible-until-hover right-edge resizer.
  applyPanelWidth(state.settings.sidebarPanelWidth || 300);
  const panelResizer = createPanelResizer(state, panelOverlay);
  document.body.appendChild(panelResizer);
  positionPanelResizer(panelResizer, panelOverlay);

  function isWideViewport() {
    return window.innerWidth > 700;
  }

  function openPanel() {
    if (panelOpen) return;
    panelOpen = true;
    body.innerHTML = "";
    panelOverlay.classList.remove("hidden");
    createFilesPanel(body, state, hidePanel);
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
      !panelResizer.contains(e.target) &&
      !(versionOverlay && versionOverlay.contains(e.target))
    ) {
      hidePanel();
    }
  });

  // --- Cross-module events ---
  state.on("show-files-panel", () => { openPanel(); });
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
  state.on("show-ratchet-dropdown", () => {
    if (state.ratchetMode) { state.stopRatchet(); return; }
    showRatchetDropdownCentered(state, () => {});
  });
  state.on("export-current-file", async () => {
    if (state.currentNotebookFileId) {
      const { openNotebookExportModal } = await import("./notebook-export-modal.js");
      await openNotebookExportModal(state);
      return;
    }
    const { openDocExportModal } = await import("./doc-export-modal.js");
    await openDocExportModal(state);
  });

  state.on("files-changed", () => { if (panelOpen) refreshFilesPanel(state); });
  state.on("multi-select-changed", () => {
    if (!panelOpen) return;
    const selected = new Set(state.selectedDocIds || []);
    panelOverlay.querySelectorAll(".sl-item[data-file-id]").forEach((li) => {
      li.classList.toggle("multi-selected", selected.has(li.dataset.fileId));
    });
  });
  state.on("active-desk-changed", () => { if (panelOpen) refreshFilesPanel(state); });
  state.on("desks-changed", () => { if (panelOpen) refreshFilesPanel(state); });

  let _lastLocalSyncSerialised = JSON.stringify(state.settings.localSyncFolders || []);
  let _lastGoogleLinksSerialised = JSON.stringify(state.settings.googleDocLinks || {});
  state.on("settings-changed", () => {
    const next = JSON.stringify(state.settings.localSyncFolders || []);
    if (next !== _lastLocalSyncSerialised) {
      _lastLocalSyncSerialised = next;
      refreshFilesPanel(state);
    }
    const nextGdoc = JSON.stringify(state.settings.googleDocLinks || {});
    if (nextGdoc !== _lastGoogleLinksSerialised) {
      _lastGoogleLinksSerialised = nextGdoc;
      refreshFilesPanel(state);
    }
  });
  state.on("local-sync-changed", () => refreshFilesPanel(state));
  state.on("file-opened", () => { if (panelOpen) refreshFilesPanel(state); });
  state.on("notebook-open", () => { if (panelOpen) refreshFilesPanel(state); });
  state.on("panes-changed", () => { if (panelOpen) refreshFilesPanel(state); });
  state.on("panes-hidden-changed", () => { if (panelOpen) refreshFilesPanel(state); });
  state.on("dropbox-status-changed", () => { if (panelOpen) refreshFilesPanel(state); });
  state.on("windows-changed", () => { if (panelOpen) refreshFilesPanel(state); });

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
