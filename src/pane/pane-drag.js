/**
 * Pane drag (titlebar) and resize (edge / corner handles). Both wire
 * pointer-down/move/up sequences with PointerCapture so the gesture
 * survives leaving the pane bounds. Notebook-attached panes translate
 * screen deltas into world coords via the camera zoom.
 */
import {
  appState,
  notebookBridge,
  panes,
  zForPane,
  TITLEBAR_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
} from "./pane-state.js";

export function setupPaneDrag(pane, deps) {
  const { createPane, getCurrentContext, schedulePersist } = deps;
  let startX, startY, startLeft, startTop, startCanvasX, startCanvasY;

  pane._titlebar.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".floating-pane-btn, .fp-title-link")) return;
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = pane.el.offsetLeft;
    startTop = pane.el.offsetTop;
    // Option+drag: spawn a static duplicate at the source position; the
    // pane being dragged stays on top (skipFocus keeps the duplicate from
    // stealing z-index when its async load finishes).
    if (e.altKey) {
      createPane(pane.fileId, pane.fileName, pane.fileType,
        startLeft + pane.width / 2, startTop + TITLEBAR_HEIGHT / 2,
        { allowDuplicate: true, ownerContext: getCurrentContext(), skipFocus: true });
      pane.el.style.zIndex = zForPane(pane);
    }
    // Snapshot canvas coords for attached panes (notebook mode)
    if (pane.attached && appState.currentNotebookFileId) {
      startCanvasX = pane._canvasX;
      startCanvasY = pane._canvasY;
    }
    pane._titlebar.setPointerCapture(e.pointerId);

    const onMove = (me) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      if (pane.attached && appState.currentNotebookFileId) {
        // Convert screen delta to canvas delta (account for zoom)
        const canvas = notebookBridge?.getCanvasInstance();
        const zoom = canvas ? canvas.state.camera.zoom : 1;
        pane._canvasX = startCanvasX + dx / zoom;
        pane._canvasY = startCanvasY + dy / zoom;
        // Screen position updates via the canvas sync loop
      } else if (pane.attached && !appState.currentNotebookFileId) {
        // Doc-attached: update both screen position and scroll-relative Y
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
    };

    const onUp = () => {
      pane._titlebar.removeEventListener("pointermove", onMove);
      pane._titlebar.removeEventListener("pointerup", onUp);
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
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = pane.width;
      const startH = pane.height;
      const startLeft = pane.x;
      const startTop = pane.y;
      // Canvas-attached panes render through `transform: scale(zoom)`,
      // so a screen-px drag delta corresponds to (delta / zoom) layout
      // px on the pane. Fall back to 1 for unattached or doc-mode
      // panes where layout px == screen px.
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
