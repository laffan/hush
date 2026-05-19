/**
 * Sidebar — left-edge panel hosting the file tree.
 *
 * The legacy icon column (#sidebar) is gone. #panel-overlay is the sidebar
 * itself, anchored at left:0. Styles, Versions, and Export are reachable
 * exclusively through the command palette; Settings is a fixed footer
 * button at the bottom of the panel. A circular floating toggle on the
 * left edge opens/closes the panel (also bound to Cmd+\).
 */
import { openSettingsWindow } from "../settings/settings-ui.js";
import { createFilesPanel, refreshFilesPanel } from "./files-panel.js";
import { cleanupVersionsPanel } from "./versions-panel.js";
import { showRatchetDropdownCentered } from "./ratchet-dropdown.js";
import { createPanelResizer, applyPanelWidth, positionPanelResizer } from "./panel-resizer.js";
import { mountDeskSwitcher } from "./desk-switcher.js";
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
      // Only one panel reaches the sidebar now, so the value is just a
      // boolean disguised as the legacy string for back-compat.
      sidebarOpenPanel: panelOpen ? "files" : null,
      sidebarPinned: panelPinned,
    }).catch((e) => console.warn("Save sidebar state failed:", e));
  }

  // Floating circular toggle — pinned to the left edge, rides the panel's
  // right edge when open. Click emits `toggle-left-panel`.
  const sidebarToggleBtn = document.createElement("button");
  sidebarToggleBtn.className = "sidebar-floating-toggle";
  sidebarToggleBtn.title = "Toggle files panel";
  sidebarToggleBtn.innerHTML = sidebarToggleSvg("expand");
  document.body.appendChild(sidebarToggleBtn);
  sidebarToggleBtn.addEventListener("click", () => {
    state.emit("toggle-left-panel");
  });

  // Dropbox sync indicator — 10px dot under the toggle, shown only when
  // sync is active; briefly pulses on every successful sync pass.
  const syncDot = document.createElement("div");
  syncDot.className = "sidebar-sync-dot";
  syncDot.setAttribute("aria-hidden", "true");
  document.body.appendChild(syncDot);
  function syncDotVisible() {
    return !!(state.settings.dropboxEnabled && state.settings.dropboxSyncPath);
  }
  function refreshSyncDot() {
    syncDot.classList.toggle("visible", syncDotVisible());
    syncDot.classList.toggle("panel-open", !panelOverlay.classList.contains("hidden"));
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
  new MutationObserver(refreshSyncDot).observe(panelOverlay, { attributes: true, attributeFilter: ["class"] });
  refreshSyncDot();

  function syncSidebarToggleIcon() {
    const isOpen = !panelOverlay.classList.contains("hidden");
    sidebarToggleBtn.innerHTML = sidebarToggleSvg(isOpen ? "collapse" : "expand");
    sidebarToggleBtn.title = isOpen ? "Close panel" : "Open files panel";
    sidebarToggleBtn.classList.toggle("panel-open", isOpen);
  }
  new MutationObserver(syncSidebarToggleIcon).observe(panelOverlay, {
    attributes: true, attributeFilter: ["class"],
  });
  syncSidebarToggleIcon();

  // Typing-fade — hide the floating toggle and the panel's new-item
  // buttons while the user is actively typing in the doc editor. Any
  // pointer activity (mousemove / tap) brings them back. Notebook mode
  // is exempt so Pencil-only users still have the controls reachable.
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

  /** Build the panel skeleton once. The header owns the desk switcher,
   *  the body hosts the Files panel, and the footer holds the Settings
   *  button (anchored to the bottom). */
  function buildPanelChrome() {
    panelOverlay.innerHTML = "";
    const header = document.createElement("div");
    header.className = "panel-overlay-header";

    const body = document.createElement("div");
    body.className = "panel-overlay-body";

    const footer = document.createElement("div");
    footer.className = "panel-overlay-footer";
    const settingsBtn = document.createElement("button");
    settingsBtn.className = "panel-footer-btn panel-footer-settings";
    settingsBtn.type = "button";
    settingsBtn.title = "Settings";
    settingsBtn.setAttribute("aria-label", "Settings");
    settingsBtn.innerHTML = `<span class="panel-footer-icon"><svg viewBox="0 0 24 24">${svgInner(settingsRaw)}</svg></span><span class="panel-footer-label">Settings</span>`;
    settingsBtn.addEventListener("click", () => openSettingsWindow(state));
    footer.appendChild(settingsBtn);

    panelOverlay.appendChild(header);
    panelOverlay.appendChild(body);
    panelOverlay.appendChild(footer);
    mountDeskSwitcher(header, state);
    return body;
  }

  const panelBody = buildPanelChrome();

  function openPanel() {
    if (panelOpen) return;
    panelOpen = true;
    panelBody.innerHTML = "";
    panelOverlay.classList.remove("hidden");
    createFilesPanel(panelBody, state, hidePanel);
    if (state.runtime.columnResizeHandler) state.runtime.columnResizeHandler();
    persistSidebarState();
  }

  function hidePanel() {
    if (!panelOpen) {
      // Make sure the overlay element is hidden even if our internal
      // flag was already false (defensive — the toggle click path can
      // call hide while the panel was never marked open).
      panelOverlay.classList.add("hidden");
      return;
    }
    panelOpen = false;
    // Versions used to live in the sidebar; now in a modal. Still call
    // cleanup defensively in case a snapshot preview overlay is up.
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
      !sidebarToggleBtn.contains(e.target) &&
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
    // Legacy event — styles live in the command palette now. Open the
    // style editor modal directly so any caller still emitting this
    // event lands somewhere sensible.
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

/** SVG for the floating sidebar toggle — guillemet that rotates with state. */
function sidebarToggleSvg(variant) {
  return variant === "collapse" ? "‹" : "›";
}
