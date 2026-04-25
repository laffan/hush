/**
 * Anchoring a floating pane to its host content. Two flavours:
 *
 *   - Notebook canvas: convert screen ↔ canvas world coords through the
 *     active camera, then drive the pane's `transform: scale(zoom)` via
 *     a per-frame requestAnimationFrame loop so the pane shrinks/grows
 *     with the surrounding shapes.
 *   - Document scroll: stash a scroll-relative Y offset, listen for
 *     scroll, reposition the pane on every event.
 *
 * `stopAttachSync` cleans up both flavours.
 */
import { appState, notebookBridge, panes } from "./pane-state.js";

export function screenToCanvas(screenX, screenY) {
  if (!notebookBridge) return null;
  const canvas = notebookBridge.getCanvasInstance();
  if (!canvas) return null;
  const cam = canvas.state.camera;
  return {
    x: (screenX - cam.x) / cam.zoom,
    y: (screenY - cam.y) / cam.zoom,
  };
}

export function canvasToScreen(canvasX, canvasY) {
  if (!notebookBridge) return null;
  const canvas = notebookBridge.getCanvasInstance();
  if (!canvas) return null;
  const cam = canvas.state.camera;
  return {
    x: canvasX * cam.zoom + cam.x,
    y: canvasY * cam.zoom + cam.y,
  };
}

export function startCanvasSync(pane) {
  function tick() {
    if (!pane.attached || !panes.has(pane.id)) return;
    const pos = canvasToScreen(pane._canvasX, pane._canvasY);
    if (pos) {
      pane.x = pos.x;
      pane.y = pos.y;
      pane.el.style.left = pos.x + "px";
      pane.el.style.top = pos.y + "px";
      // Pane is anchored to the canvas — scale it with the camera zoom
      // so it shrinks/grows together with the surrounding shapes. The
      // pane's own width/height are interpreted as "size at 1× zoom"
      // and rendered through the transform; the resize handler
      // compensates by dividing screen-px deltas by the same zoom.
      const canvas = notebookBridge ? notebookBridge.getCanvasInstance() : null;
      const zoom = canvas ? canvas.state.camera.zoom : 1;
      pane.el.style.transformOrigin = "top left";
      pane.el.style.transform = `scale(${zoom})`;
    }
    pane._syncFrame = requestAnimationFrame(tick);
  }
  tick();
}

export function startScrollSync(pane) {
  const scrollDOM = appState.editor?.view.scrollDOM;
  if (!scrollDOM) return;
  pane._scrollHandler = () => {
    if (!pane.attached || !panes.has(pane.id)) return;
    const scrollTop = scrollDOM.scrollTop;
    pane.y = pane._scrollRelY - scrollTop;
    pane.el.style.top = pane.y + "px";
  };
  scrollDOM.addEventListener("scroll", pane._scrollHandler);
  // Sync once immediately so restored attach positions don't wait for a scroll
  pane._scrollHandler();
}

export function stopAttachSync(pane) {
  // Stop canvas sync (notebook)
  if (pane._syncFrame) {
    cancelAnimationFrame(pane._syncFrame);
    pane._syncFrame = null;
  }
  // Drop the camera-zoom transform a canvas-attached pane was using —
  // once detached, the pane lives at fixed screen size again.
  if (pane.el) {
    pane.el.style.transform = "";
    pane.el.style.transformOrigin = "";
  }
  // Stop scroll sync (doc)
  if (pane._scrollHandler) {
    const scrollDOM = appState.editor?.view.scrollDOM;
    if (scrollDOM) scrollDOM.removeEventListener("scroll", pane._scrollHandler);
    pane._scrollHandler = null;
  }
}
