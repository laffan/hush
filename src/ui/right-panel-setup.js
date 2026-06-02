/**
 * Right sidebar (Outline View) setup — extracted from main.js.
 * Handles inset/overlay mode, show/hide triggers, and refresh.
 */
import { createLongView } from "../longview/longview.js";

export function setupRightPanel(state) {
  const rightPanelOverlay = document.getElementById("right-panel-overlay");
  let longViewInstance = null;

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
  });

  state.on("hide-outline", () => {
    rightPanelOverlay.classList.add("hidden");
    rightTrigger.classList.remove("is-hidden");
    if (state.runtime.columnResizeHandler) state.runtime.columnResizeHandler();
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
