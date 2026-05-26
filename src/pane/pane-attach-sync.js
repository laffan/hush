/**
 * Anchoring a floating pane to its host content. Three flavours:
 *
 *   - Notebook canvas: convert screen ↔ canvas world coords through the
 *     active camera, then drive the pane's `transform: scale(zoom)` via
 *     a per-frame requestAnimationFrame loop so the pane shrinks/grows
 *     with the surrounding shapes.
 *   - Document scroll: stash a scroll-relative Y offset, listen for
 *     scroll, reposition the pane on every event.
 *   - PDF scroll: stash a page-relative position (page index + fraction
 *     offsets), reposition on scroll/zoom by resolving back to the page
 *     wrapper's screen position.
 *
 * `stopAttachSync` cleans up all flavours.
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
  pane._scrollHandler();
}

export function startPdfScrollSync(pane) {
  const pdfContainer = document.getElementById("pdf-container");
  const scrollArea = pdfContainer?.querySelector(".pdf-scroll-area");
  if (!scrollArea) return;

  pane._pdfScrollHandler = () => {
    if (!pane.attached || !panes.has(pane.id)) return;
    const anchor = pane._pdfAnchor;
    if (!anchor) return;
    const pageWrapper = scrollArea.querySelector(`.pdf-page-wrapper[data-page-index="${anchor.pageIndex}"]`);
    if (!pageWrapper) return;
    const containerRect = pdfContainer.getBoundingClientRect();
    const pageRect = pageWrapper.getBoundingClientRect();
    pane.x = pageRect.left - containerRect.left + anchor.xFrac * pageRect.width;
    pane.y = pageRect.top - containerRect.top + anchor.yFrac * pageRect.height;
    pane.el.style.left = pane.x + "px";
    pane.el.style.top = pane.y + "px";
  };
  scrollArea.addEventListener("scroll", pane._pdfScrollHandler);
  pane._pdfScrollHandler();
}

export function anchorPaneToPdf(pane) {
  const pdfContainer = document.getElementById("pdf-container");
  const scrollArea = pdfContainer?.querySelector(".pdf-scroll-area");
  if (!scrollArea) return;
  const containerRect = pdfContainer.getBoundingClientRect();
  const paneScreenX = pane.x;
  const paneScreenY = pane.y;

  const wrappers = scrollArea.querySelectorAll(".pdf-page-wrapper");
  let best = null;
  let bestDist = Infinity;
  for (const w of wrappers) {
    const r = w.getBoundingClientRect();
    const relR = { left: r.left - containerRect.left, top: r.top - containerRect.top, width: r.width, height: r.height };
    const cx = relR.left + relR.width / 2;
    const cy = relR.top + relR.height / 2;
    const dist = Math.abs(paneScreenX - cx) + Math.abs(paneScreenY - cy);
    if (dist < bestDist) {
      bestDist = dist;
      best = { pageIndex: parseInt(w.dataset.pageIndex, 10), rect: relR };
    }
  }
  if (!best) return;
  pane._pdfAnchor = {
    pageIndex: best.pageIndex,
    xFrac: (paneScreenX - best.rect.left) / Math.max(1, best.rect.width),
    yFrac: (paneScreenY - best.rect.top) / Math.max(1, best.rect.height),
  };
}

export function stopAttachSync(pane) {
  if (pane._syncFrame) {
    cancelAnimationFrame(pane._syncFrame);
    pane._syncFrame = null;
  }
  if (pane.el) {
    pane.el.style.transform = "";
    pane.el.style.transformOrigin = "";
  }
  if (pane._scrollHandler) {
    const scrollDOM = appState.editor?.view.scrollDOM;
    if (scrollDOM) scrollDOM.removeEventListener("scroll", pane._scrollHandler);
    pane._scrollHandler = null;
  }
  if (pane._pdfScrollHandler) {
    const pdfContainer = document.getElementById("pdf-container");
    const scrollArea = pdfContainer?.querySelector(".pdf-scroll-area");
    if (scrollArea) scrollArea.removeEventListener("scroll", pane._pdfScrollHandler);
    pane._pdfScrollHandler = null;
    pane._pdfAnchor = null;
  }
}
