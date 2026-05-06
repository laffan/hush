/**
 * DOM scaffolding for the drawing layer. Builds the transform wrapper,
 * three stacked canvases (done / preview / live), the offscreen pocket
 * stash, the SVG overlay (eraser cursor + selection layer), and the
 * "Selecting" hint pill.
 *
 * Pulled out of drawing-layer.ts so the factory can focus on engine
 * wiring rather than element construction.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export interface DrawingDom {
  wrapper: HTMLDivElement;
  doneCanvas: HTMLCanvasElement;
  previewCanvas: HTMLCanvasElement;
  liveCanvas: HTMLCanvasElement;
  pocketStash: HTMLCanvasElement;
  pocketStashCtx: CanvasRenderingContext2D;
  svg: SVGSVGElement;
  eraserCursor: SVGCircleElement;
  selectionLayer: SVGGElement;
  selectHint: HTMLDivElement;
  originX: number;
  originY: number;
}

export function createDrawingDom(container: HTMLElement, worldSize: number): DrawingDom {
  // ---------- DOM: transform wrapper + engine stage ----------

  const wrapper = document.createElement("div");
  wrapper.className = "notebook-drawing-wrapper";
  Object.assign(wrapper.style, {
    position: "absolute",
    top: "0",
    left: "0",
    width: worldSize + "px",
    height: worldSize + "px",
    transformOrigin: "0 0",
    pointerEvents: "none",
  });
  container.appendChild(wrapper);

  // Center the wrapper on the current viewport so the default cursor
  // position lands inside canvas bounds.
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;
  const originX = vw / 2 - worldSize / 2;
  const originY = vh / 2 - worldSize / 2;

  function mkStageCanvas(cls: string): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.className = cls;
    Object.assign(c.style, {
      position: "absolute",
      top: "0",
      left: "0",
      pointerEvents: "none",
    });
    return c;
  }

  const doneCanvas = mkStageCanvas("draw-canvas drawing-done");
  const previewCanvas = mkStageCanvas("draw-canvas drawing-preview");
  const liveCanvas = mkStageCanvas("draw-canvas drawing-live");
  wrapper.appendChild(doneCanvas);
  wrapper.appendChild(previewCanvas);
  wrapper.appendChild(liveCanvas);

  // Pocket stash: offscreen canvas mirroring the done canvas's pixel
  // layout. When a stroke flips to pocketed, its region is copied
  // from done → stash before the engine rebakes (which removes it
  // from done via engine delta #8). `blitWorldRegion` for pocket
  // render reads from the stash so pocketed strokes remain paintable
  // in the pocket tray even though they're absent from the world
  // view. Stash and done are always the same size/DPR.
  const pocketStash = document.createElement("canvas");
  const pocketStashCtx = pocketStash.getContext("2d")!;

  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("viewBox", `0 0 ${worldSize} ${worldSize}`);
  Object.assign(svg.style, {
    position: "absolute",
    top: "0",
    left: "0",
    width: worldSize + "px",
    height: worldSize + "px",
    // iPad WebKit doesn't treat an empty `<svg>` with `pointer-events: auto`
    // as a hit target — without painted children it skips the SVG and routes
    // pointerdowns to the underlying canvas. `bounding-box` makes the entire
    // SVG box hit-testable regardless of its children, so the engine's
    // pointer listener actually fires. Drawing-layer `setInputEnabled` flips
    // this between `bounding-box` (drawing mode) and `none` (everywhere else).
    pointerEvents: "none",
    touchAction: "none",
  });
  wrapper.appendChild(svg);

  // iPad safety: touch preventDefaults so gesture detection doesn't
  // yank pointer capture mid-stroke. Mounted even while the SVG is
  // non-capturing — cheap to keep on.
  svg.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
  svg.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

  const eraserCursor = document.createElementNS(SVG_NS, "circle") as SVGCircleElement;
  eraserCursor.setAttribute("r", "12");
  eraserCursor.setAttribute("fill", "none");
  eraserCursor.setAttribute("stroke", "#111");
  eraserCursor.setAttribute("stroke-width", "1");
  eraserCursor.setAttribute("stroke-dasharray", "3 3");
  eraserCursor.setAttribute("visibility", "hidden");
  eraserCursor.setAttribute("pointer-events", "none");
  svg.appendChild(eraserCursor);

  const selectionLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  selectionLayer.setAttribute("class", "selection-layer");
  svg.appendChild(selectionLayer);

  // Hold-to-select hint pill — flashed when a long press during draw /
  // erase promotes the gesture into a lasso. iPad / Apple Pencil users
  // need a visible acknowledgement that select mode engaged. Mounted in
  // `container` so it stays at fixed screen size as the user zooms.
  const selectHint = document.createElement("div");
  selectHint.className = "notebook-drawing-select-hint";
  selectHint.textContent = "Selecting";
  Object.assign(selectHint.style, {
    position: "absolute",
    pointerEvents: "none",
    padding: "3px 8px",
    borderRadius: "999px",
    background: "rgba(17,17,17,0.85)",
    color: "#fff",
    fontSize: "11px",
    fontWeight: "500",
    letterSpacing: "0.03em",
    whiteSpace: "nowrap",
    opacity: "0",
    transition: "opacity 0.15s",
    zIndex: "250",
    // Sit to the LEFT of the anchor, vertically centered on it.
    transform: "translate(-100%, -50%)",
  } as CSSStyleDeclaration);
  container.appendChild(selectHint);

  return {
    wrapper, doneCanvas, previewCanvas, liveCanvas,
    pocketStash, pocketStashCtx,
    svg, eraserCursor, selectionLayer,
    selectHint,
    originX, originY,
  };
}
