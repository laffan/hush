/**
 * Pane Docking — pin a pane to one of four canvas edges (top / bottom /
 * left / right) so it fills the docked edge dimension and flexes with
 * window / sidebar resizes. The opposite edge stays user-resizable.
 *
 * Lifecycle:
 *   dockPane(pane, edge)    → snapshot current geometry, apply dock CSS
 *                             classes, fill the edge.
 *   undockPane(pane)        → restore pre-dock geometry.
 *   applyDockGeometry(pane) → re-flex docked dimensions (called on
 *                             window resize and sidebar inset changes).
 *
 * Drop-zone hit-testing + the dragging overlay live in `pane-drag.js`.
 * This module owns geometry only.
 */

import {
  panes,
  appState,
  containerEl,
  TITLEBAR_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
} from "./pane-state.js";

/** Pixels of canvas left visible past a docked pane (so the docked
 *  pane doesn't completely occlude the editor / other content). */
const DOCK_MIN_FREE = 200;

/** Default size for the user-controlled axis when a pane is first
 *  docked. Subsequent resizes overwrite this on the pane object. */
const DEFAULT_DOCK_HEIGHT = 240;
const DEFAULT_DOCK_WIDTH = 360;

export function isDocked(pane) {
  return !!(pane && pane.docked && pane.dockEdge);
}

export function dockPane(pane, edge) {
  if (!pane || !edge) return;
  if (!["top", "bottom", "left", "right"].includes(edge)) return;
  // Detach from any anchored / gutter mode — docking owns geometry.
  if (pane.attached) {
    pane.attached = false;
    const btn = pane.el?.querySelector(".fp-btn-attach");
    btn?.classList.remove("attach-active");
  }
  if (pane.gutter) {
    import("./pane-gutter.js").then(({ undoGutter }) => undoGutter(pane));
  }
  if (!pane._dockPrev) {
    pane._dockPrev = {
      x: pane.x, y: pane.y,
      width: pane.width, height: pane.height,
    };
  }
  pane.docked = true;
  pane.dockEdge = edge;
  // Pick a sensible initial user dimension if the user hasn't sized
  // this docked instance yet.
  if (edge === "top" || edge === "bottom") {
    pane.dockUserSize = pane.dockUserSize || pane.height || DEFAULT_DOCK_HEIGHT;
  } else {
    pane.dockUserSize = pane.dockUserSize || pane.width || DEFAULT_DOCK_WIDTH;
  }
  pane.el?.classList.add("docked", `docked-${edge}`);
  applyDockGeometry(pane);
}

export function undockPane(pane) {
  if (!pane || !pane.docked) return;
  pane.el?.classList.remove(
    "docked", "docked-top", "docked-bottom", "docked-left", "docked-right",
  );
  pane.docked = false;
  pane.dockEdge = null;
  pane.dockUserSize = null;
  if (pane._dockPrev) {
    pane.x = pane._dockPrev.x;
    pane.y = pane._dockPrev.y;
    pane.width = pane._dockPrev.width;
    pane.height = pane._dockPrev.height;
    pane._dockPrev = null;
  }
  if (pane.el) {
    Object.assign(pane.el.style, {
      left: pane.x + "px",
      top: pane.y + "px",
      width: pane.width + "px",
      height: pane.height + "px",
    });
  }
}

/** Recompute and apply geometry for a docked pane. Call after a window
 *  resize or sidebar inset shift. */
export function applyDockGeometry(pane) {
  if (!pane || !pane.docked || !pane.el || !containerEl) return;
  const cr = containerEl.getBoundingClientRect();
  const leftInset = getLeftInset();
  const winW = cr.width;
  const winH = cr.height;

  switch (pane.dockEdge) {
    case "top": {
      const h = Math.max(MIN_HEIGHT, Math.min(winH - DOCK_MIN_FREE, pane.dockUserSize || DEFAULT_DOCK_HEIGHT));
      pane.dockUserSize = h;
      pane.x = leftInset;
      pane.y = 0;
      pane.width = Math.max(MIN_WIDTH, winW - leftInset);
      pane.height = h;
      break;
    }
    case "bottom": {
      const h = Math.max(MIN_HEIGHT, Math.min(winH - DOCK_MIN_FREE, pane.dockUserSize || DEFAULT_DOCK_HEIGHT));
      pane.dockUserSize = h;
      pane.x = leftInset;
      pane.y = winH - h;
      pane.width = Math.max(MIN_WIDTH, winW - leftInset);
      pane.height = h;
      break;
    }
    case "left": {
      const w = Math.max(MIN_WIDTH, Math.min(winW - DOCK_MIN_FREE, pane.dockUserSize || DEFAULT_DOCK_WIDTH));
      pane.dockUserSize = w;
      pane.x = leftInset;
      pane.y = 0;
      pane.width = w;
      pane.height = winH;
      break;
    }
    case "right": {
      const w = Math.max(MIN_WIDTH, Math.min(winW - DOCK_MIN_FREE, pane.dockUserSize || DEFAULT_DOCK_WIDTH));
      pane.dockUserSize = w;
      pane.x = winW - w;
      pane.y = 0;
      pane.width = w;
      pane.height = winH;
      break;
    }
  }
  Object.assign(pane.el.style, {
    left: pane.x + "px",
    top: pane.y + "px",
    width: pane.width + "px",
    height: pane.height + "px",
  });
}

/** Track the sidebar / panel-overlay inset so docked panes start past it. */
function getLeftInset() {
  const overlay = document.getElementById("panel-overlay");
  if (!overlay) return 0;
  if (overlay.classList.contains("hidden")) {
    const grip = overlay.querySelector(".sidebar-grip");
    return grip ? grip.getBoundingClientRect().width : 0;
  }
  return overlay.getBoundingClientRect().width;
}

/** Iterate every docked pane and re-apply geometry. Called from the
 *  window resize handler and from sidebar open/close listeners. */
export function reflowAllDockedPanes() {
  for (const [, p] of panes) {
    if (p.docked) applyDockGeometry(p);
  }
}

/** Install window resize + sidebar observers so docked panes re-flex
 *  automatically. Returns a cleanup function. */
export function installDockReflowListeners() {
  const onResize = () => reflowAllDockedPanes();
  window.addEventListener("resize", onResize);
  let mo = null;
  const overlay = document.getElementById("panel-overlay");
  if (overlay) {
    mo = new MutationObserver(() => reflowAllDockedPanes());
    mo.observe(overlay, { attributes: true, attributeFilter: ["class", "style"] });
  }
  // Sidebar resize fires a custom event via the resizer module — observe
  // appState for the synthesized "settings-changed" trigger.
  let stop = null;
  if (appState && appState.on) {
    const handler = () => reflowAllDockedPanes();
    appState.on("settings-changed", handler);
    stop = () => appState.off("settings-changed", handler);
  }
  return () => {
    window.removeEventListener("resize", onResize);
    if (mo) mo.disconnect();
    if (stop) stop();
  };
}

/** Hit-test client coords against a docked-zone overlay. Returns the
 *  edge name or null. Drop zone = anything within `100px` of the named
 *  edge. */
export function dropZoneAt(clientX, clientY) {
  if (!containerEl) return null;
  const r = containerEl.getBoundingClientRect();
  const leftInset = getLeftInset();
  const ZONE = 100;
  // Only consider points inside the container's bounds.
  if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
  const dx = clientX - r.left;
  const dy = clientY - r.top;
  // Corner priority: prefer top/bottom over left/right when both apply
  // (rare, but matters at the corners).
  if (dy < ZONE + TITLEBAR_HEIGHT) return "top";
  if (dy > r.height - ZONE) return "bottom";
  if (dx < leftInset + ZONE) return "left";
  if (dx > r.width - ZONE) return "right";
  return null;
}
