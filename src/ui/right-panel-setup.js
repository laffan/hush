/**
 * Right sidebar (Outline View) setup — extracted from main.js.
 * Handles inset/overlay mode, show/hide triggers, and refresh.
 */
import { createLongView } from "../longview/longview.js";

export function setupRightPanel(state) {
  const rightPanelOverlay = document.getElementById("right-panel-overlay");
  let longViewInstance = null;

  // Desks own the outline (right-sidebar) toggle state: record open /
  // closed against the active desk so switching back restores it. Stored
  // alongside the left-panel state under `settings.deskSidebars[deskId]`.
  function saveDeskOutline(open) {
    const deskId = state.settings?.activeDeskId;
    if (!deskId) return;
    const deskSidebars = { ...(state.settings?.deskSidebars || {}) };
    deskSidebars[deskId] = { ...(deskSidebars[deskId] || {}), right: open };
    state.updateSettings({ deskSidebars }).catch((e) => console.warn("Save outline state failed:", e));
  }

  // Right panel inset mode — mirror left panel logic
  function updateRightPanelMode() {
    const w = window.innerWidth;
    const colW = state.settings.columnWidth || 800;
    const rightPad = Math.max(50, Math.floor((w - colW) / 2));
    if (rightPad >= 200) {
      rightPanelOverlay.classList.add("panel-inset");
      rightPanelOverlay.classList.remove("panel-overlay-mode");
    } else {
      rightPanelOverlay.classList.remove("panel-inset");
      rightPanelOverlay.classList.add("panel-overlay-mode");
    }
  }
  updateRightPanelMode();
  window.addEventListener("resize", updateRightPanelMode);
  state.on("settings-changed", updateRightPanelMode);

  // Show/hide Outline View
  state.on("show-outline", () => {
    // Don't show outline when a notebook is active
    if (state.currentNotebookFileId) return;
    rightPanelOverlay.classList.remove("hidden");
    rightTrigger.classList.add("is-hidden");
    if (!longViewInstance) {
      longViewInstance = createLongView(rightPanelOverlay, state);
    }
    longViewInstance.render();
    if (state.runtime.columnResizeHandler) state.runtime.columnResizeHandler();
    saveDeskOutline(true);
  });

  state.on("hide-outline", () => {
    rightPanelOverlay.classList.add("hidden");
    rightTrigger.classList.remove("is-hidden");
    if (state.runtime.columnResizeHandler) state.runtime.columnResizeHandler();
    saveDeskOutline(false);
  });

  // Restore this desk's saved outline state once the desk's last file has
  // opened (main.js emits this after `openLastFileForDesk` resolves, so
  // the notebook guard in show-outline sees the correct surface).
  state.on("desk-outline-restore", (deskId) => {
    const id = deskId || state.settings?.activeDeskId;
    const saved = id ? (state.settings?.deskSidebars || {})[id] : null;
    if (!saved || typeof saved.right !== "boolean") return;
    state.emit(saved.right ? "show-outline" : "hide-outline");
  });

  // Close right panel on click outside — only when overlaying the
  // content. Inset mode stays put until the user closes it explicitly
  // via keyboard shortcut or button.
  document.addEventListener("mousedown", (e) => {
    if (rightPanelOverlay.classList.contains("panel-inset")) return;
    if (!rightPanelOverlay.classList.contains("hidden") &&
        !rightPanelOverlay.contains(e.target)) {
      state.emit("hide-outline");
    }
  });

  // Right sidebar trigger — a hover-revealed arrow icon on the right edge.
  // The outline no longer auto-opens on hover; the arrow just signals
  // that a panel is there. Opening happens via click or keyboard shortcut
  // (Cmd+Shift+\ by default).
  const rightTrigger = document.createElement("button");
  rightTrigger.className = "right-panel-trigger";
  rightTrigger.type = "button";
  rightTrigger.setAttribute("aria-label", "Open outline");
  rightTrigger.textContent = "‹";
  document.getElementById("app").appendChild(rightTrigger);
  rightTrigger.addEventListener("click", () => {
    if (rightPanelOverlay.classList.contains("hidden")) {
      state.emit("show-outline");
    }
  });

  // Refresh Outline View on file open
  state.on("file-opened", () => {
    if (longViewInstance && !rightPanelOverlay.classList.contains("hidden")) {
      longViewInstance.render();
    }
  });
}
