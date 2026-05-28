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
  if (!["left", "right"].includes(edge)) return;
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
  // Default to half the visible canvas width if the user hasn't sized
  // this dock yet — keeps the editor + a docked reference roughly
  // balanced rather than the docked pane crowding everything out.
  if (!pane.dockUserSize) {
    const visW = computeVisibleWidth();
    pane.dockUserSize = Math.max(MIN_WIDTH, Math.min(visW * 0.5, visW - DOCK_MIN_FREE));
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
  const rightInset = getRightInset();
  const winW = cr.width;
  const winH = cr.height;
  const visW = Math.max(0, winW - leftInset - rightInset);

  switch (pane.dockEdge) {
    case "left": {
      const w = Math.max(MIN_WIDTH, Math.min(visW - DOCK_MIN_FREE, pane.dockUserSize || (visW * 0.5)));
      pane.dockUserSize = w;
      pane.x = leftInset;
      pane.y = 0;
      pane.width = w;
      pane.height = winH;
      break;
    }
    case "right": {
      const w = Math.max(MIN_WIDTH, Math.min(visW - DOCK_MIN_FREE, pane.dockUserSize || (visW * 0.5)));
      pane.dockUserSize = w;
      pane.x = winW - w - rightInset;
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

/** Track the left sidebar (file panel) so docked panes start past it. */
export function getLeftInset() {
  const overlay = document.getElementById("panel-overlay");
  if (!overlay) return 0;
  if (overlay.classList.contains("hidden")) {
    const grip = overlay.querySelector(".sidebar-grip");
    return grip ? grip.getBoundingClientRect().width : 0;
  }
  return overlay.getBoundingClientRect().width;
}

/** Track the right-side chrome (shelf / outline / annotation panel) so
 *  docked panes don't end up underneath them. Walks every known
 *  right-edge element and takes the largest footprint — at most one is
 *  ever visible at a time today, so a max() is sufficient. */
export function getRightInset() {
  let inset = 0;
  const shelf = document.querySelector(".notebook-shelf");
  if (shelf) {
    const isOpen = shelf.__isShelfOpen ? shelf.__isShelfOpen() : false;
    if (isOpen && shelf.__getShelfWidth) inset = Math.max(inset, shelf.__getShelfWidth());
    else inset = Math.max(inset, shelf.getBoundingClientRect().width); // closed grip strip
  }
  const longview = document.getElementById("right-panel-overlay");
  if (longview && !longview.classList.contains("hidden")) {
    inset = Math.max(inset, longview.getBoundingClientRect().width);
  }
  const pdfShelf = document.querySelector(".pdf-annot-shelf.open");
  if (pdfShelf) inset = Math.max(inset, pdfShelf.getBoundingClientRect().width);
  return inset;
}

function computeVisibleWidth() {
  const cr = containerEl?.getBoundingClientRect();
  if (!cr) return 800;
  return Math.max(200, cr.width - getLeftInset() - getRightInset());
}

/** Iterate every docked pane and re-apply geometry. Called from the
 *  window resize handler and from sidebar open/close listeners. */
export function reflowAllDockedPanes() {
  for (const [, p] of panes) {
    if (p.docked) applyDockGeometry(p);
  }
}

/** Install window resize + chrome observers so docked panes re-flex
 *  automatically. Watches the left sidebar plus every known right-edge
 *  panel; only the active context's chrome will actually be in the DOM
 *  at any one moment. Returns a cleanup function. */
export function installDockReflowListeners() {
  const onResize = () => reflowAllDockedPanes();
  window.addEventListener("resize", onResize);
  const observers = [];
  function watch(el) {
    if (!el) return;
    const mo = new MutationObserver(() => reflowAllDockedPanes());
    mo.observe(el, { attributes: true, attributeFilter: ["class", "style"] });
    observers.push(mo);
  }
  watch(document.getElementById("panel-overlay"));
  watch(document.getElementById("right-panel-overlay"));
  // The shelf is mounted dynamically inside the notebook container.
  // A MutationObserver on the body catches its mount and we then
  // observe the shelf node directly so width changes flow through.
  const bodyObs = new MutationObserver(() => {
    const shelf = document.querySelector(".notebook-shelf");
    if (shelf && !shelf.__dockObserved) {
      shelf.__dockObserved = true;
      watch(shelf);
      reflowAllDockedPanes();
    }
    const pdfShelf = document.querySelector(".pdf-annot-shelf");
    if (pdfShelf && !pdfShelf.__dockObserved) {
      pdfShelf.__dockObserved = true;
      watch(pdfShelf);
      reflowAllDockedPanes();
    }
  });
  bodyObs.observe(document.body, { childList: true, subtree: true });
  observers.push(bodyObs);

  let stopAppSettings = null;
  if (appState && appState.on) {
    const handler = () => reflowAllDockedPanes();
    appState.on("settings-changed", handler);
    stopAppSettings = () => appState.off("settings-changed", handler);
  }
  return () => {
    window.removeEventListener("resize", onResize);
    for (const m of observers) m.disconnect();
    if (stopAppSettings) stopAppSettings();
  };
}

/** Hit-test client coords against a docked-zone overlay. Returns the
 *  edge name or null. Only left/right docking is supported now —
 *  top/bottom zones were dropped per design feedback. */
export function dropZoneAt(clientX, clientY) {
  if (!containerEl) return null;
  const r = containerEl.getBoundingClientRect();
  const leftInset = getLeftInset();
  const rightInset = getRightInset();
  const ZONE = 100;
  if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
  const dx = clientX - r.left;
  if (dx < leftInset + ZONE) return "left";
  if (dx > r.width - rightInset - ZONE) return "right";
  return null;
}
