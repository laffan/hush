/**
 * Right sidebar (Overview) setup — extracted from main.js.
 * Handles inset/overlay mode, show/hide triggers, and refresh.
 */
import { createOverview } from "../overview/overview.js";
import { attachSidePanelResize, sidePanelWidthPx } from "./side-panel-resizer.js";

export function setupRightPanel(state) {
  const rightPanelOverlay = document.getElementById("right-panel-overlay");
  let overviewInstance = null;

  // Drag the Overview's inboard edge to widen it. The strip sits at the
  // panel's left edge — everything to its right is the dock footprint
  // plus the panel itself.
  attachSidePanelResize(state, rightPanelOverlay, {
    cssVar: "--right-panel-width",
    settingKey: "overviewPanelWidth",
    defaultWidth: 200,
    min: 140,
    rightOffset: "calc(var(--pane-dock-right-width, 0px) + var(--right-panel-width, 200px))",
  });

  // Desks own the Overview (right-sidebar) toggle state: record open /
  // closed against the active desk so switching back restores it. Stored
  // alongside the left-panel state under `settings.deskSidebars[deskId]`.
  function saveDeskOverview(open) {
    const deskId = state.settings?.activeDeskId;
    if (!deskId) return;
    const deskSidebars = { ...(state.settings?.deskSidebars || {}) };
    deskSidebars[deskId] = { ...(deskSidebars[deskId] || {}), right: open };
    state.updateSettings({ deskSidebars }).catch((e) => console.warn("Save Overview state failed:", e));
  }

  // Right panel inset mode — mirror left panel logic
  function updateRightPanelMode() {
    const w = window.innerWidth;
    const colW = state.settings.columnWidth || 800;
    const rightPad = Math.max(50, Math.floor((w - colW) / 2));
    // Inset only while the gutter beside the text column is at least as
    // wide as the panel itself — which is now the user's width, not a
    // fixed 200.
    if (rightPad >= sidePanelWidthPx("--right-panel-width", 200)) {
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

  // Show/hide the Overview
  state.on("show-overview", () => {
    // Don't show the Overview when a notebook is active
    if (state.currentNotebookFileId) return;
    rightPanelOverlay.classList.remove("hidden");
    rightTrigger.classList.add("is-hidden");
    if (!overviewInstance) {
      overviewInstance = createOverview(rightPanelOverlay, state);
    }
    overviewInstance.render();
    if (state.runtime.columnResizeHandler) state.runtime.columnResizeHandler();
    saveDeskOverview(true);
  });

  state.on("hide-overview", () => {
    rightPanelOverlay.classList.add("hidden");
    rightTrigger.classList.remove("is-hidden");
    if (state.runtime.columnResizeHandler) state.runtime.columnResizeHandler();
    saveDeskOverview(false);
  });

  // Restore this desk's saved Overview state once the desk's last file has
  // opened (main.js emits this after `openLastFileForDesk` resolves, so
  // the notebook guard in show-overview sees the correct surface).
  state.on("desk-overview-restore", (deskId) => {
    const id = deskId || state.settings?.activeDeskId;
    const saved = id ? (state.settings?.deskSidebars || {})[id] : null;
    if (!saved || typeof saved.right !== "boolean") return;
    state.emit(saved.right ? "show-overview" : "hide-overview");
  });

  // Close right panel on click outside — only when overlaying the
  // content. Inset mode stays put until the user closes it explicitly
  // via keyboard shortcut or button.
  document.addEventListener("mousedown", (e) => {
    if (rightPanelOverlay.classList.contains("panel-inset")) return;
    if (!rightPanelOverlay.classList.contains("hidden") &&
        !rightPanelOverlay.contains(e.target)) {
      state.emit("hide-overview");
    }
  });

  // Right sidebar trigger — a hover-revealed arrow icon on the right edge.
  // The Overview no longer auto-opens on hover; the arrow just signals
  // that a panel is there. Opening happens via click or keyboard shortcut
  // (Cmd+Shift+\ by default).
  const rightTrigger = document.createElement("button");
  rightTrigger.className = "right-panel-trigger";
  rightTrigger.type = "button";
  rightTrigger.setAttribute("aria-label", "Open Overview");
  rightTrigger.textContent = "‹";
  document.getElementById("app").appendChild(rightTrigger);
  rightTrigger.addEventListener("click", () => {
    if (rightPanelOverlay.classList.contains("hidden")) {
      state.emit("show-overview");
    }
  });

  // Refresh the Overview on file open
  state.on("file-opened", () => {
    if (overviewInstance && !rightPanelOverlay.classList.contains("hidden")) {
      overviewInstance.render();
    }
  });
}
