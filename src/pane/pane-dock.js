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
  // Shift the editor column (doc text, notebook canvas, etc.) to make
  // room for the freshly-docked pane right away — without this the
  // host content stays put until the user resizes the pane, which is
  // what trips `applyDockGeometry` for the second time. Lazy-loaded to
  // dodge the pane-dock ↔ pane-manager circular import.
  import("./pane-manager.js").then(({ refreshPaneLayoutMetrics }) => {
    refreshPaneLayoutMetrics();
  });
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
  publishDockCssVars();
  // Undock also needs to flow the column back to where it was — same
  // story as `dockPane`. Lazy-loaded for the same circular-import reason.
  import("./pane-manager.js").then(({ refreshPaneLayoutMetrics }) => {
    refreshPaneLayoutMetrics();
  });
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
  publishDockCssVars();
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

/** Right inset for dock POSITIONING — docked panes sit flush against
 *  the absolute right edge of the container, with the editor's own
 *  right-side chrome (shelf, outline, annotation shelf) sliding left
 *  to stay associated with the editor. So this is always 0 (or just
 *  the safe-area). Kept as a function rather than a constant so future
 *  edges (notch / sidebar overlap) can opt in. */
export function getRightInset() {
  return 0;
}

/** Width of the editor's right-side chrome (notebook shelf, doc
 *  outline, PDF annotation shelf). Used only for computing a sensible
 *  default size when a pane is freshly docked — the dock itself
 *  occupies space carved out of the editor, not the chrome. */
function getEditorChromeRightWidth() {
  let inset = 0;
  const shelf = document.querySelector(".notebook-shelf");
  if (shelf) {
    const isOpen = shelf.__isShelfOpen ? shelf.__isShelfOpen() : false;
    if (isOpen && shelf.__getShelfWidth) inset = Math.max(inset, shelf.__getShelfWidth());
    else inset = Math.max(inset, shelf.getBoundingClientRect().width);
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
  // Default-size calculation: visible space the user sees BETWEEN
  // sidebar + chrome (where the editor sits). Half of that becomes
  // the dock's default width so the editor and dock split the space.
  return Math.max(200, cr.width - getLeftInset() - getEditorChromeRightWidth());
}

/** Publish the docked footprints as CSS custom properties so chrome
 *  elements (shelf, outline, bg-button) can shift away from a dock
 *  via plain CSS. Called from applyDockGeometry + undockPane +
 *  closePane (so a closed dock pane fully clears the var). */
export function publishDockCssVars() {
  let leftW = 0, rightW = 0;
  let leftEdge = 0, rightEdge = 0;
  for (const [, p] of panes) {
    if (!p.docked) continue;
    if (p.el?.style.display === "none") continue;
    if (p.dockEdge === "left") {
      leftW = Math.max(leftW, p.width || 0);
      // Absolute viewport x where the left dock ends (pane.x already
      // sits past the sidebar). Used by containers that need to clear
      // sidebar+dock, e.g. #stack-container and #pdf-container.
      leftEdge = Math.max(leftEdge, (p.x || 0) + (p.width || 0));
    }
    if (p.dockEdge === "right") {
      rightW = Math.max(rightW, p.width || 0);
      rightEdge = Math.max(rightEdge, p.width || 0);
    }
  }
  const root = document.documentElement;
  root.style.setProperty("--pane-dock-left-width", leftW + "px");
  root.style.setProperty("--pane-dock-right-width", rightW + "px");
  root.style.setProperty("--pane-dock-left-edge", leftEdge + "px");
  root.style.setProperty("--pane-dock-right-edge", rightEdge + "px");
  document.dispatchEvent(new CustomEvent("pane-dock-changed", {
    detail: { leftWidth: leftW, rightWidth: rightW, leftEdge, rightEdge },
  }));
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
  function watchAttrs(el) {
    if (!el) return;
    const mo = new MutationObserver(() => reflowAllDockedPanes());
    mo.observe(el, { attributes: true, attributeFilter: ["class", "style"] });
    observers.push(mo);
  }
  function watchSize(el) {
    if (!el || typeof ResizeObserver === "undefined") return;
    // Sidebar width rides a CSS custom property on documentElement, so
    // the panel's inline `style` attribute never changes during a drag-
    // resize. A ResizeObserver catches the actual layout-width change
    // and fires on every frame the user keeps dragging.
    const ro = new ResizeObserver(() => reflowAllDockedPanes());
    ro.observe(el);
    observers.push(ro);
  }
  const sidebar = document.getElementById("panel-overlay");
  watchAttrs(sidebar);
  watchSize(sidebar);
  watchAttrs(document.getElementById("right-panel-overlay"));
  watchSize(document.getElementById("right-panel-overlay"));
  // The shelf is mounted dynamically inside the notebook container.
  // A MutationObserver on the body catches its mount and we then
  // observe the shelf node directly so width changes flow through.
  const bodyObs = new MutationObserver(() => {
    const shelf = document.querySelector(".notebook-shelf");
    if (shelf && !shelf.__dockObserved) {
      shelf.__dockObserved = true;
      watchAttrs(shelf);
      watchSize(shelf);
      reflowAllDockedPanes();
    }
    const pdfShelf = document.querySelector(".pdf-annot-shelf");
    if (pdfShelf && !pdfShelf.__dockObserved) {
      pdfShelf.__dockObserved = true;
      watchAttrs(pdfShelf);
      watchSize(pdfShelf);
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
  const ZONE = 50;
  if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
  const dx = clientX - r.left;
  if (dx < leftInset + ZONE) return "left";
  if (dx > r.width - rightInset - ZONE) return "right";
  return null;
}
