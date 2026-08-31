/**
 * DOM scaffolding for the drawing layer. Builds the transform wrapper,
 * three stacked canvases (done / preview / live), the highlight wrapper
 * and its own bake pair, the offscreen pocket stash, the SVG overlay
 * (eraser cursor + selection layer), and the "Selecting" hint pill.
 *
 * Pulled out of drawing-layer.ts so the factory can focus on engine
 * wiring rather than element construction.
 *
 * **Two transform wrappers, not one.** Highlighter ink bakes into its
 * own pair of canvases under `mix-blend-mode: multiply`, so a highlight
 * drawn over a proofread page darkens the words instead of painting a
 * translucent slab over them. The blend has to live on a *wrapper*
 * rather than on the canvas: the main wrapper carries
 * `will-change: transform`, which makes it a stacking context, and a
 * blend inside a stacking context only sees that group's own backdrop —
 * it would never reach the notebook canvas one layer down. Blending the
 * wrapper itself composites the whole group against the page. Both
 * wrappers carry the same camera transform, and the highlight pair
 * stays unbacked (1x1) until a highlighter stroke exists, so the
 * ordinary notebook pays neither the memory nor the compositing.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export interface DrawingDom {
  wrapper: HTMLDivElement;
  /** Sibling of `wrapper`, painted beneath it and blended `multiply`
   *  against the notebook canvas. Holds the highlight bake pair, and
   *  the live canvas is reparented into it while the active brush slot
   *  is a highlighter so an in-progress stroke reads the same as the
   *  baked one. Always sized and transformed with `wrapper`; its
   *  canvases are backed lazily by the engine. */
  hlWrapper: HTMLDivElement;
  hlCanvas: HTMLCanvasElement;
  /** The highlight pair's swap spare — same role as `blitHelper`. */
  hlBlitHelper: HTMLCanvasElement;
  doneCanvas: HTMLCanvasElement;
  previewCanvas: HTMLCanvasElement;
  liveCanvas: HTMLCanvasElement;
  /** Attached (composited → GPU-backed) helper for the re-anchor blit
   *  (engine delta #29). Self-drawImage forces WebKit to snapshot the
   *  whole source surface — a ~230 ms GPU→CPU readback on iPad — and a
   *  DETACHED scratch is CPU-backed, paying the same readback on its
   *  first leg. Two cross-canvas 'copy' draws through this attached
   *  helper stay on the GPU. Sits UNDER the done canvas at near-zero
   *  opacity so it's composited but never visible. */
  blitHelper: HTMLCanvasElement;
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

  function mkWrapper(cls: string): HTMLDivElement {
    const el = document.createElement("div");
    el.className = cls;
    return el;
  }

  const hlWrapper = mkWrapper("notebook-drawing-wrapper notebook-drawing-highlight-wrapper");
  const wrapper = mkWrapper("notebook-drawing-wrapper");
  Object.assign(wrapper.style, {
    position: "absolute",
    top: "0",
    left: "0",
    width: worldSize + "px",
    height: worldSize + "px",
    transformOrigin: "0 0",
    pointerEvents: "none",
    // Keep the stroke layer on its own stable compositor layer so panning
    // is a pure GPU transform with no per-frame repaint of the baked
    // strokes. Declaring it up-front (rather than letting the browser
    // promote/demote around each gesture) avoids the hitch a layer
    // create/destroy causes at pan start on stroke-heavy notebooks. The
    // cost is just GPU memory while idle — no extra compute.
    willChange: "transform",
  });
  // The highlight group is painted first so ordinary ink stacks over it —
  // a pen note written on top of a highlight stays legible.
  Object.assign(hlWrapper.style, {
    position: "absolute",
    top: "0",
    left: "0",
    width: worldSize + "px",
    height: worldSize + "px",
    transformOrigin: "0 0",
    pointerEvents: "none",
    // Both are switched on by the engine the moment the group has
    // something to show (`setHighlightHostActive`). A permanently
    // blended, permanently promoted layer would make the compositor
    // read the page behind it every frame of every pan for a notebook
    // that has never seen a highlighter — the blend is the whole point
    // of this wrapper, and it is also the only thing it costs.
    willChange: "auto",
    mixBlendMode: "normal",
  });
  container.appendChild(hlWrapper);
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

  // Blit helper first so it sits UNDER the done canvas (its content is
  // a stale copy of pre-shift ink; the 1% opacity keeps it composited
  // — WebKit demotes fully-hidden canvases off the GPU — while staying
  // imperceptible behind the real ink). See DrawingDom.blitHelper.
  const blitHelper = mkStageCanvas("draw-canvas drawing-blit-helper");
  blitHelper.style.opacity = "0.01";
  wrapper.appendChild(blitHelper);
  // Highlight pair, same spare-then-visible order. Left at 1x1 until the
  // engine sizes them — a notebook with no highlighter ink never pays
  // for two more world-sized backings.
  const hlBlitHelper = mkStageCanvas("draw-canvas drawing-highlight-blit-helper");
  hlBlitHelper.style.opacity = "0.01";
  hlBlitHelper.width = 1;
  hlBlitHelper.height = 1;
  const hlCanvas = mkStageCanvas("draw-canvas drawing-highlight");
  hlCanvas.width = 1;
  hlCanvas.height = 1;
  hlWrapper.appendChild(hlBlitHelper);
  hlWrapper.appendChild(hlCanvas);
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
    // App UI font, not the notebook's content font — this is chrome, and
    // it sat inside `#notebook-container`, which inherits the active
    // style's font from `body`.
    fontFamily: "var(--ui-font-family, system-ui, sans-serif)",
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
    wrapper, hlWrapper, hlCanvas, hlBlitHelper,
    doneCanvas, previewCanvas, liveCanvas, blitHelper,
    pocketStash, pocketStashCtx,
    svg, eraserCursor, selectionLayer,
    selectHint,
    originX, originY,
  };
}
