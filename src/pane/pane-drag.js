/**
 * Pane drag (titlebar) and resize (edge / corner handles). Both wire
 * pointer-down/move/up sequences with PointerCapture so the gesture
 * survives leaving the pane bounds. Notebook-attached panes translate
 * screen deltas into world coords via the camera zoom.
 *
 * Drag also drives the dock workflow — while the user drags the title
 * bar, four highlighted drop zones paint inside the canvas. Releasing
 * inside a zone calls `dockPane(pane, edge)`; releasing outside leaves
 * the pane wherever the drag ended. Dragging the title of an already
 * docked pane undocks it first.
 */
import {
  appState,
  notebookBridge,
  panes,
  containerEl,
  zForPane,
  TITLEBAR_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
} from "./pane-state.js";
import {
  dockPane,
  undockPane,
  dropZoneAt,
  isDocked,
  applyDockGeometry,
  getLeftInset,
  getRightInset,
} from "./pane-dock.js";

let _dockOverlay = null;

function ensureDockOverlay() {
  if (_dockOverlay) return _dockOverlay;
  const root = document.createElement("div");
  root.className = "pane-dock-overlay";
  for (const edge of ["left", "right"]) {
    const z = document.createElement("div");
    z.className = `pane-dock-zone pane-dock-zone-${edge}`;
    z.dataset.edge = edge;
    root.appendChild(z);
  }
  document.body.appendChild(root);
  _dockOverlay = root;
  return root;
}

function showDockOverlay(show) {
  const overlay = ensureDockOverlay();
  overlay.classList.toggle("visible", show);
  if (show) positionDockZones();
}

function positionDockZones() {
  if (!_dockOverlay || !containerEl) return;
  const r = containerEl.getBoundingClientRect();
  const overlay = _dockOverlay;
  Object.assign(overlay.style, {
    position: "fixed",
    left: r.left + "px", top: r.top + "px",
    width: r.width + "px", height: r.height + "px",
    pointerEvents: "none",
    zIndex: "9999",
  });
  const ZONE = 50;
  const leftInset = getLeftInset();
  const rightInset = getRightInset();
  const left = overlay.querySelector(".pane-dock-zone-left");
  const right = overlay.querySelector(".pane-dock-zone-right");
  if (left) Object.assign(left.style, { left: leftInset + "px", top: "0px", width: ZONE + "px", height: r.height + "px" });
  if (right) Object.assign(right.style, { left: (r.width - rightInset - ZONE) + "px", top: "0px", width: ZONE + "px", height: r.height + "px" });
}

function highlightDockZone(edge) {
  if (!_dockOverlay) return;
  for (const z of _dockOverlay.querySelectorAll(".pane-dock-zone")) {
    z.classList.toggle("active", z.dataset.edge === edge);
  }
}

export function setupPaneDrag(pane, deps) {
  const { createPane, getCurrentContext, schedulePersist } = deps;
  let startX, startY, startLeft, startTop, startCanvasX, startCanvasY;

  pane._titlebar.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".floating-pane-btn, .fp-title-link")) return;
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    startY = e.clientY;
    // Dragging a docked pane undocks it first — keep its current screen
    // size, recenter on the cursor so the drag feels natural.
    if (isDocked(pane)) {
      const beforeRect = pane.el.getBoundingClientRect();
      const cur = { x: pane.x, y: pane.y, w: pane.width, h: pane.height };
      undockPane(pane);
      // After undock the pane snaps to the pre-dock pos/size. Override
      // to the cursor-centered position so the drag continues smoothly.
      pane.width = cur.w;
      pane.height = Math.min(cur.h, 360); // cap the snapped height
      pane.x = e.clientX - pane.width / 2 - beforeRect.left + cur.x;
      pane.y = e.clientY - TITLEBAR_HEIGHT / 2;
      Object.assign(pane.el.style, {
        left: pane.x + "px", top: pane.y + "px",
        width: pane.width + "px", height: pane.height + "px",
      });
    }
    startLeft = pane.el.offsetLeft;
    startTop = pane.el.offsetTop;
    if (e.altKey) {
      createPane(pane.fileId, pane.fileName, pane.fileType,
        startLeft + pane.width / 2, startTop + TITLEBAR_HEIGHT / 2,
        { allowDuplicate: true, ownerContext: getCurrentContext(), skipFocus: true });
      pane.el.style.zIndex = zForPane(pane);
    }
    if (pane.attached && appState.currentNotebookFileId) {
      startCanvasX = pane._canvasX;
      startCanvasY = pane._canvasY;
    }
    pane._titlebar.setPointerCapture(e.pointerId);
    showDockOverlay(true);

    const onMove = (me) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      if (pane.gutter) {
        pane.x = startLeft + dx;
        pane.el.style.left = pane.x + "px";
        return;
      }
      if (pane.attached && appState.currentNotebookFileId) {
        const canvas = notebookBridge?.getCanvasInstance();
        const zoom = canvas ? canvas.state.camera.zoom : 1;
        pane._canvasX = startCanvasX + dx / zoom;
        pane._canvasY = startCanvasY + dy / zoom;
      } else if (pane.attached && !appState.currentNotebookFileId) {
        pane.x = startLeft + dx;
        pane.y = startTop + dy;
        pane._scrollRelY = pane.y + (appState.editor?.view.scrollDOM.scrollTop || 0);
        pane.el.style.left = pane.x + "px";
        pane.el.style.top = pane.y + "px";
      } else {
        pane.x = startLeft + dx;
        pane.y = startTop + dy;
        pane.el.style.left = pane.x + "px";
        pane.el.style.top = pane.y + "px";
      }
      highlightDockZone(dropZoneAt(me.clientX, me.clientY));
      // Live-refresh the editor column so the auto make-space follows
      // the pane as the user drags it. notifyPaneDragMove updates
      // visiblePaneCentroid + triggers the column resize handler.
      deps.notifyPaneDragMove?.();
    };

    const onUp = (ue) => {
      pane._titlebar.removeEventListener("pointermove", onMove);
      pane._titlebar.removeEventListener("pointerup", onUp);
      const edge = dropZoneAt(ue.clientX, ue.clientY);
      if (edge) dockPane(pane, edge);
      showDockOverlay(false);
      highlightDockZone(null);
      schedulePersist();
    };

    pane._titlebar.addEventListener("pointermove", onMove);
    pane._titlebar.addEventListener("pointerup", onUp);
  });
}

export function setupPaneResize(pane, deps) {
  const { schedulePersist } = deps;
  for (const handle of pane.el.querySelectorAll(".fp-resize")) {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dir = handle.dataset.dir;
      // Docked panes only allow resize on the edge opposite the dock,
      // and only on the perpendicular axis. Other directional handles
      // are ignored.
      if (isDocked(pane)) {
        const allowed = allowedDockResizeDir(pane.dockEdge);
        if (dir !== allowed) return;
      }
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = pane.width;
      const startH = pane.height;
      const startLeft = pane.x;
      const startTop = pane.y;
      let zoomFactor = 1;
      if (pane.attached && appState && appState.currentNotebookFileId) {
        const canvas = notebookBridge ? notebookBridge.getCanvasInstance() : null;
        if (canvas) zoomFactor = canvas.state.camera.zoom || 1;
      }

      handle.setPointerCapture(e.pointerId);

      const onMove = (me) => {
        const dx = (me.clientX - startX) / zoomFactor;
        const dy = (me.clientY - startY) / zoomFactor;
        let w = startW, h = startH, nx = startLeft, ny = startTop;
        if (dir.includes("e")) w = Math.max(MIN_WIDTH, startW + dx);
        if (dir.includes("w")) { w = Math.max(MIN_WIDTH, startW - dx); nx = startLeft + (startW - w) * zoomFactor; }
        if (dir.includes("s")) h = Math.max(MIN_HEIGHT, startH + dy);
        if (dir.includes("n")) { h = Math.max(MIN_HEIGHT, startH - dy); ny = startTop + (startH - h) * zoomFactor; }
        pane.width = w; pane.height = h; pane.x = nx; pane.y = ny;
        if (isDocked(pane)) {
          // Capture the new user dimension and re-flex.
          if (pane.dockEdge === "top" || pane.dockEdge === "bottom") pane.dockUserSize = h;
          else pane.dockUserSize = w;
          applyDockGeometry(pane);
          return;
        }
        Object.assign(pane.el.style, { width: w + "px", height: h + "px", left: nx + "px", top: ny + "px" });
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        schedulePersist();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
  }
}

/** Map dock edge to the single resize handle direction that's still
 *  active when the pane is docked. */
function allowedDockResizeDir(edge) {
  switch (edge) {
    case "top": return "s";
    case "bottom": return "n";
    case "left": return "e";
    case "right": return "w";
    default: return "";
  }
}

// Re-export the count of panes so the manager can reflow docks on
// sidebar / window changes — caller registers this once.
export { panes };
