/**
 * Page rail for a proofread notebook — a live vertical minimap of the
 * page layer.
 *
 * It is NOT a list of the pages the PDF had. It is a picture of the
 * document as it stands: split a page and the rail shows two pieces,
 * each the shape the cut left it; grab a band out and the rail loses
 * it. That is the whole point of having it next to a proof — the canvas
 * shows you one page at a time, and the rail is where you see what the
 * surgery did to the shape of the document.
 *
 * Piece *sizes* are to scale against each other; the space between them
 * is to scale too, but clamped at both ends (see `MIN_GAP_PX`).
 *
 * Only the page layer is drawn. Ink, text and drag boxes are the
 * annotations, not the document, and at rail scale they would be
 * indistinguishable smudges over the thing you're trying to read.
 *
 * ### How pieces are painted without decoding a page
 *
 * Each piece is an `<img>` of its source page's small thumbnail raster,
 * blown up to the page's full rail size and clipped by an
 * `overflow: hidden` wrapper to the piece's `crop` window. Because a
 * split cut is a crop of the same bytes (`splits.ts#cutImage`), the same
 * crop fractions index into the thumbnail exactly as they index into the
 * full-size raster — so a half page renders as a half thumbnail, with no
 * full-size decode anywhere in the rail. The `proofPageIndex` a piece
 * inherits from its parent is what ties it back to its thumbnail.
 *
 * Sits flush against the LEFT edge of the shelf via `state.rightInset`
 * (the canvas controller keeps that in sync with the shelf's animating
 * width), so with the shelf closed the rail sits inboard of its 24 px
 * grip and is fully visible; opening the shelf pushes the rail left
 * rather than burying it.
 */

import type { DrawingState } from "../state";
import type { ImageShape } from "../types";
import { h } from "./dom-helpers";
import { type RailSegment, drawProofRailInk, railToWorld } from "./proof-rail-ink";

export const RAIL_MIN_WIDTH = 60;
export const RAIL_MAX_WIDTH = 300;
export const RAIL_DEFAULT_WIDTH = 92;

/** Horizontal padding inside the rail, each side. */
const RAIL_PAD = 8;

/** Space between two pieces, in rail px: the world gap to scale, but
 *  clamped hard at both ends.
 *
 *  Neither extreme works on its own. Fully to scale, one split dragged
 *  wide open dominates the rail and pushes the pages either side of it
 *  out of view. Fully fixed, opening a split changes nothing here at
 *  all — and since making room and then writing into it is the whole
 *  proofreading gesture, the rail would go quiet exactly when the user
 *  most wants to see what they did. Clamping keeps the page gutters
 *  tidy, shows an opened split as a real band with room for the notes
 *  written into it, and stops a runaway drag from taking over. */
const MIN_GAP_PX = 4;
const MAX_GAP_PX = 40;

/** Trailing debounce before the annotation overlay repaints. */
const INK_DEBOUNCE_MS = 180;

/** Duration of the click-to-navigate glide. */
const GLIDE_MS = 280;

/** Vertical clearance at the rail's foot for the fixed canvas-rotation
 *  and background-settings buttons, which park in the bottom-right
 *  corner just inboard of the shelf — directly under the rail. */
const BOTTOM_CHROME_PX = 62;

export interface ProofThumbnailRail {
  root: HTMLElement;
  destroy(): void;
}

interface Piece {
  shape: ImageShape;
  pageIndex: number;
  /** World rect. */
  x: number; y: number; w: number; h: number;
}

/** Page pieces in document order: down the page, then across.
 *
 *  `proofPageIndex` is the normal route — it rides every cut for free,
 *  which is what makes a split show up here as two pieces. Proofs baked
 *  before that field existed fall back to matching the page entries'
 *  recorded `shapeId`, so an old proof still gets a rail (its uncut
 *  pages, at least) instead of silently losing one. */
function collectPieces(state: DrawingState): Piece[] {
  const out: Piece[] = [];
  let legacy: Map<string, number> | null = null;
  for (const s of state.shapes) {
    if (s.type !== "image" || s.pocketed) continue;
    const img = s as ImageShape;
    let pageIndex = img.proofPageIndex;
    if (typeof pageIndex !== "number") {
      if (!legacy) {
        legacy = new Map();
        for (const p of state.proof?.pages || []) legacy.set(p.shapeId, p.index);
      }
      pageIndex = legacy.get(img.id);
      if (typeof pageIndex !== "number") continue;
    }
    out.push({
      shape: img,
      pageIndex,
      x: img.position.x, y: img.position.y, w: img.width, h: img.height,
    });
  }
  out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return out;
}

export function createProofThumbnails(state: DrawingState): ProofThumbnailRail {
  // Cells stack inside `column`; the ink canvas overlays it. The canvas
  // has to share the column's coordinate space (not the scroller's) so
  // the projection stays valid as the rail scrolls.
  const column = h("div", { style: { position: "relative", width: "100%" } });
  const ink = h("canvas", {
    style: {
      position: "absolute", left: "0", top: "0", pointerEvents: "none",
      // Above the page cells. Both are positioned siblings with auto
      // z-index, so DOM order would otherwise decide — and the cells are
      // appended after, which buried every annotation that fell on a
      // page. Only ink in the gaps and margins showed, which is a
      // confusing way to be broken.
      zIndex: "1",
    },
  }) as HTMLCanvasElement;
  column.appendChild(ink);

  const scroller = h("div", {
    style: {
      flex: "1", overflowY: "auto", overflowX: "hidden",
      padding: `${RAIL_PAD}px ${RAIL_PAD}px`, boxSizing: "border-box",
    },
    children: [column],
  });

  // The rail's left edge resizes it. The strip is exactly `RAIL_PAD`
  // wide so it lands inside the scroller's padding and never covers a
  // page piece: the rail is a navigation surface too, and taking a few
  // px off every cell's click target for a handle would be the wrong
  // trade. The grip inside it is the whole point of this element being
  // visible at all — an `ew-resize` cursor only tells you the edge is
  // draggable once you have already put the pointer somewhere you had
  // no reason to try. Styling (and the hover / drag states) lives in
  // `styles/notebook.css` beside the toolbar's drag grip, which is the
  // same affordance in the same visual language.
  const resizeGrip = h("div", { cls: "notebook-proof-rail-grip" });
  const resizer = h("div", {
    cls: "notebook-proof-rail-resizer",
    title: "Drag to resize",
    style: {
      position: "absolute", left: "0", top: "0", bottom: "0", width: `${RAIL_PAD}px`,
      cursor: "ew-resize", zIndex: "2",
    },
    children: [resizeGrip],
  });

  const root = h("div", {
    style: {
      // Vertical placement is written by `applyPlacement` on the first
      // update: it depends on `state.paneHosted`, which a pane / stack
      // host sets after this constructor has already run.
      position: "absolute",
      display: "none", flexDirection: "column", boxSizing: "border-box",
      // Below floating panes (--z-pane: 90) — the rail is canvas chrome
      // and a pane is the thing the user pulled to the front, so the
      // rail covering one reads as the pane having gone missing. The
      // trade is that the notebook toolbar (100) now stacks over the
      // rail where a centred bar reaches it; the bar is draggable and
      // the rail's foot already stops short of the corner buttons.
      zIndex: "89", borderRadius: "10px 0 0 10px", overflow: "hidden",
      boxShadow: "0 2px 12px rgba(0,0,0,0.12)", backdropFilter: "blur(8px)",
    },
    children: [resizer, scroller],
  });
  root.classList.add("notebook-proof-rail");

  let width = clampWidth(readSavedWidth());
  let cells: { el: HTMLElement; piece: Piece }[] = [];
  let structureKey = "";
  let geometryKey = "";
  let activeEl: HTMLElement | null = null;
  let lastSkin = "";
  let lastRight = -1;
  /** Piecewise world → rail projection, rebuilt by `layout`. */
  let segments: RailSegment[] = [];
  let inkTimer: ReturnType<typeof setTimeout> | null = null;
  let inkShapes: unknown = null;
  let tweenRaf = 0;

  // ── layout ──

  function contentWidth() { return Math.max(20, width - RAIL_PAD * 2); }

  /** World width the rail maps onto its content width — the widest page,
   *  so a document of mixed page sizes stays to scale against itself
   *  instead of each page filling the rail. */
  function documentWidth(pieces: Piece[]): number {
    let max = 0;
    for (const p of state.proof?.pages || []) if (p.width > max) max = p.width;
    if (max > 0) return max;
    for (const p of pieces) {
      const crop = p.shape.crop;
      const full = crop && crop.w > 0 ? p.w / crop.w : p.w;
      if (full > max) max = full;
    }
    return max || 1;
  }

  function thumbFor(pageIndex: number): string {
    return state.proof?.pages.find((p) => p.index === pageIndex)?.thumbDataUrl || "";
  }

  function rebuild(pieces: Piece[]) {
    // Remove only what we added — the ink canvas is a permanent child of
    // `column` and must survive a rebuild (wiping the container took it
    // out and left the overlay drawing into a detached node).
    for (const { el } of cells) el.remove();
    cells = [];
    activeEl = null;
    for (const piece of pieces) {
      const img = h("img", {
        attrs: { src: thumbFor(piece.pageIndex), alt: "", draggable: "false" },
        style: { display: "block", position: "absolute", left: "0", top: "0", maxWidth: "none" },
      });
      const cell = h("div", {
        style: {
          position: "relative", overflow: "hidden", flexShrink: "0",
          borderRadius: "2px", cursor: "pointer",
          outline: "1px solid transparent", outlineOffset: "1px",
        },
        children: [img],
        onClick: (e) => { e.stopPropagation(); },
      });
      cells.push({ el: cell, piece });
      column.appendChild(cell);
    }
  }

  /** Write every piece's size, crop offset and stacking. Split from
   *  `rebuild` because a split drag changes all of these on every frame
   *  while the element set stays identical. */
  function layout(pieces: Piece[]) {
    const scale = contentWidth() / documentWidth(pieces);
    let minX = Infinity;
    for (const p of pieces) if (p.x < minX) minX = p.x;
    if (!isFinite(minX)) minX = 0;

    const segs: RailSegment[] = [];
    let railY = 0;
    let prevBottom: number | null = null;
    for (let i = 0; i < cells.length; i++) {
      const { el, piece } = cells[i];
      const crop = piece.shape.crop || { x: 0, y: 0, w: 1, h: 1 };
      const cw = Math.max(1, piece.w * scale);
      const ch = Math.max(1, piece.h * scale);
      const railX = Math.max(0, (piece.x - minX) * scale);
      const worldGap = prevBottom == null ? 0 : Math.max(0, piece.y - prevBottom);
      const gap = prevBottom == null
        ? 0
        : Math.max(MIN_GAP_PX, Math.min(MAX_GAP_PX, worldGap * scale));
      prevBottom = piece.y + piece.h;
      railY += gap;
      el.style.width = `${cw}px`;
      el.style.height = `${ch}px`;
      el.style.marginLeft = `${railX}px`;
      el.style.marginTop = `${gap}px`;

      const img = el.firstElementChild as HTMLImageElement;
      // Blow the page's thumbnail up to the size the WHOLE page would be
      // at this scale, then let the wrapper's overflow clip it to the
      // piece's crop window.
      const fullW = crop.w > 0 ? cw / crop.w : cw;
      const fullH = crop.h > 0 ? ch / crop.h : ch;
      img.style.width = `${fullW}px`;
      img.style.height = `${fullH}px`;
      img.style.left = `${-crop.x * fullW}px`;
      img.style.top = `${-crop.y * fullH}px`;

      segs.push({
        wTop: piece.y, wBot: piece.y + piece.h,
        rTop: railY, rBot: railY + ch,
        scale, wLeft: piece.x, rLeft: railX,
      });
      railY += ch;
    }
    segments = segs;

    // The overlay canvas spans the whole stacked column. One canvas
    // rather than one per cell: annotations cross piece boundaries (that
    // is what a split through a paragraph looks like), and a per-cell
    // canvas would clip them at every seam.
    const w = Math.max(1, Math.round(contentWidth()));
    const hgt = Math.max(1, Math.round(railY));
    if (ink.width !== w || ink.height !== hgt) {
      ink.width = w;
      ink.height = hgt;
      ink.style.width = `${w}px`;
      ink.style.height = `${hgt}px`;
    }
    scheduleInk();
  }

  // ── annotations ──

  /** Repaint the overlay on a trailing debounce, and never mid-gesture.
   *  A stroke in progress changes `state.shapes` on every pen-up and a
   *  split drag on every frame; the rail is peripheral vision, so it
   *  waits for the pause rather than competing for the frame. */
  function scheduleInk() {
    if (inkTimer) clearTimeout(inkTimer);
    inkTimer = setTimeout(() => {
      inkTimer = null;
      if (state.splitDrag || state.grabBandDrag || state.isActiveDrag || state.strokeEngineDragging) {
        scheduleInk();
        return;
      }
      inkShapes = state.shapes;
      drawProofRailInk(ink, {
        shapes: state.shapes,
        segments,
        theme: state.theme,
        pageLayerId: state.proof?.pageLayerId || null,
        hiddenLayerIds: state._hiddenLayerIds(),
        fontFamily: state.fontFamily,
      });
    }, INK_DEBOUNCE_MS);
  }

  // ── navigation ──

  /** Smoothly bring a world y to the vertical centre of the canvas.
   *
   *  Vertical only, deliberately. The rail is a map of the *document*,
   *  which runs down the page — where the reader has scrolled sideways
   *  to (a margin they're writing in, a page they've pulled out with a
   *  vertical split) is their own working position, and yanking it back
   *  every time they navigate would undo it. So the horizontal camera is
   *  left exactly where they put it. */
  function glideToY(worldY: number) {
    const vh = state.canvasEl?.clientHeight || window.innerHeight;
    const fromY = state.camera.y;
    const toY = vh / 2 - worldY * state.camera.zoom;
    if (tweenRaf) cancelAnimationFrame(tweenRaf);
    const start = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / GLIDE_MS);
      // Ease-out cubic: leaves fast, settles gently. A jump-cut across a
      // fifty-page document costs the reader their place; the travel is
      // what tells them how far they went.
      const k = 1 - Math.pow(1 - t, 3);
      state.camera = { ...state.camera, y: fromY + (toY - fromY) * k };
      state.notify("camera");
      tweenRaf = t < 1 ? requestAnimationFrame(step) : 0;
    };
    tweenRaf = requestAnimationFrame(step);
  }

  // One handler on the column rather than one per cell: the rail is a
  // map, and clicking the gap between two pages should still take you
  // there. `railToWorld` resolves gaps as well as pieces.
  column.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (!segments.length) return;
    const r = column.getBoundingClientRect();
    const world = railToWorld(segments, e.clientX - r.left, e.clientY - r.top);
    glideToY(world.y);
  });

  /** Outline whichever piece owns the viewport's vertical centre. */
  function syncActive() {
    const h0 = state.canvasEl?.clientHeight || window.innerHeight;
    const centerWorldY = (h0 / 2 - state.camera.y) / state.camera.zoom;
    let next: HTMLElement | null = null;
    for (const { el, piece } of cells) {
      if (centerWorldY >= piece.y && centerWorldY <= piece.y + piece.h) { next = el; break; }
      if (piece.y <= centerWorldY) next = el;
    }
    if (next === activeEl) return;
    if (activeEl) activeEl.style.outlineColor = "transparent";
    activeEl = next;
    if (activeEl) {
      activeEl.style.outlineColor = state.theme.accent;
      revealInRail(activeEl);
    }
  }

  /** Bring a cell into view **inside the rail's own scroller, and
   *  nowhere else**.
   *
   *  `scrollIntoView` cannot be used here. It walks every scrollable
   *  ancestor of the element, and in a stack the rail's ancestors are the
   *  column wrapper, the column content box (both `overflow: hidden`, and
   *  browsers scroll those programmatically all the same) and the stack's
   *  own horizontal scroller. So scrolling a proof *down* — which
   *  re-highlights a page every page or so — would scroll the stack
   *  *sideways*, drag the canvas out from under its own wrapper, and, as
   *  the rail is right-anchored and travels with the content it was just
   *  scrolled off, immediately qualify for another correction. The
   *  runaway that produced was the "scrolling widens the column and
   *  pushes everything left" bug, and often the crash after it.
   *
   *  Writing `scrollTop` on the one element that is supposed to move has
   *  none of that reach. Vertical only: the rail never scrolls
   *  horizontally (`overflowX: hidden`), so there is nothing to do on
   *  that axis and nothing that should happen on it. */
  function revealInRail(cell: HTMLElement) {
    const cellBox = cell.getBoundingClientRect();
    const viewBox = scroller.getBoundingClientRect();
    // "nearest": move only when the cell is actually outside the window,
    // and only far enough to bring the offending edge in.
    if (cellBox.top < viewBox.top) scroller.scrollTop -= viewBox.top - cellBox.top;
    else if (cellBox.bottom > viewBox.bottom) scroller.scrollTop += cellBox.bottom - viewBox.bottom;
  }

  // ── width ──

  function readSavedWidth(): number {
    const app = (window as unknown as { __hushState__?: { settings?: { notebookProofRailWidth?: number } } }).__hushState__;
    return app?.settings?.notebookProofRailWidth ?? RAIL_DEFAULT_WIDTH;
  }

  function clampWidth(w: number): number {
    return Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, Math.round(w)));
  }

  function applyWidth() {
    root.style.width = `${width}px`;
    const pieces = collectPieces(state);
    layout(pieces);
  }

  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = width;
    resizer.setPointerCapture(e.pointerId);
    // Pointer capture routes the events here, but it does not carry
    // `:hover` or the strip's cursor with it — and the first thing a
    // widening drag does is leave the strip. Without both of these the
    // grip dims and the cursor reverts to the canvas's the moment the
    // gesture starts, which reads as having lost the handle.
    resizer.classList.add("is-dragging");
    document.body.classList.add("notebook-proof-rail-resizing");
    const onMove = (ev: PointerEvent) => {
      // The rail is right-anchored, so dragging its left edge LEFT makes
      // it wider — the delta is inverted relative to the pointer.
      width = clampWidth(startW - (ev.clientX - startX));
      applyWidth();
    };
    const onUp = () => {
      resizer.removeEventListener("pointermove", onMove);
      resizer.removeEventListener("pointerup", onUp);
      resizer.removeEventListener("pointercancel", onUp);
      resizer.classList.remove("is-dragging");
      document.body.classList.remove("notebook-proof-rail-resizing");
      const app = (window as unknown as { __hushState__?: { updateSettings?: (p: Record<string, unknown>) => void } }).__hushState__;
      app?.updateSettings?.({ notebookProofRailWidth: width });
    };
    resizer.addEventListener("pointermove", onMove);
    resizer.addEventListener("pointerup", onUp);
    resizer.addEventListener("pointercancel", onUp);
  });

  // ── update ──

  /** App-wide reading preference, toggled from the canvas's bottom-right
   *  chrome row. Read live rather than cached: the toggle pulses the
   *  canvas through a repaint-only key, which lands here as an ordinary
   *  change event with no payload of its own. */
  function railEnabled(): boolean {
    const app = (window as unknown as {
      __hushState__?: { settings?: { notebookProofRailVisible?: boolean } };
    }).__hushState__;
    return app?.settings?.notebookProofRailVisible !== false;
  }

  function update() {
    if (!state.proof || !railEnabled()) { root.style.display = "none"; return; }
    const pieces = collectPieces(state);
    if (!pieces.length) { root.style.display = "none"; return; }
    root.style.display = "flex";
    root.style.width = `${width}px`;

    // Structure = which pieces exist. Geometry = where they are. They
    // change on completely different clocks: structure only when a cut
    // is made or content is grabbed, geometry on every frame of a split
    // drag. Rebuilding a hundred elements per drag frame would make the
    // rail the slowest thing on screen, so the two are separated and the
    // geometry pass is skipped outright while a drag is in flight — the
    // user is watching the canvas, and release re-syncs.
    const nextStructure = pieces.map((p) => p.shape.id).join(",");
    if (nextStructure !== structureKey) {
      structureKey = nextStructure;
      geometryKey = "";
      rebuild(pieces);
      // Lay the fresh elements out straight away rather than waiting for
      // the geometry pass below, which is skipped mid-drag — a rebuilt
      // cell with no size yet would render as a 0×0 hole.
      layout(pieces);
    }
    if (!state.splitDrag && !state.grabBandDrag) {
      const nextGeometry = pieces.map((p) => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.w)},${Math.round(p.h)}`).join(";");
      if (nextGeometry !== geometryKey) {
        geometryKey = nextGeometry;
        layout(pieces);
      }
    }

    // Annotations are not part of the page layout, so nothing above
    // notices when a stroke or a text shape is added — this is what
    // keeps the overlay live. Identity, not deep compare: every
    // DrawingState mutation replaces the shapes array.
    if (inkShapes !== state.shapes) scheduleInk();

    const theme = state.theme;
    // Only touch style properties that changed — this runs on every
    // notify, and unconditional writes cost a style recalc per pan frame.
    const skin = `${theme.uiBackground}|${theme.uiBorder}|${theme.foreground}`;
    if (skin !== lastSkin) {
      lastSkin = skin;
      root.style.background = theme.uiBackground;
      root.style.borderLeft = `1px solid ${theme.uiBorder}`;
      root.style.color = theme.foreground;
      // The resize grip takes the rail's border colour rather than the
      // canvas-chrome currentColor the toolbar's drag tab uses — it sits
      // on the panel, and reading as part of the same edge is the point.
      root.style.setProperty("--proof-rail-border", theme.uiBorder);
    }
    // `rightInset` is the canvas-right-edge → shelf-left-edge distance,
    // measured live by the canvas controller, so it already folds in the
    // safe-area inset and any right-docked pane.
    const right = Math.max(0, state.rightInset || 0);
    if (right !== lastRight) {
      lastRight = right;
      root.style.right = `${right}px`;
    }
    applyPlacement();
    syncActive();
  }

  /** Top and bottom offsets, against whichever box the canvas fills.
   *  Window safe-area bands and dock footprints belong to the window
   *  form only: a pane's edges are interior, already carved out by the
   *  host, and folding the window's insets in again would push the rail
   *  down inside its own pane (and, with a bottom dock, off the end of
   *  it). The 62 px foot stays either way — the canvas-rotation and
   *  background buttons park in that corner in a pane too. */
  let lastTop = "";
  let lastBottom = "";
  function applyPlacement() {
    // `hostTopInset` is the pane's floating pill title bar (0 elsewhere).
    const top20 = 20 + (state.hostTopInset || 0);
    const top = state.paneHosted
      ? `${top20}px`
      : `calc(env(safe-area-inset-top) + ${top20}px + var(--pane-dock-top-height, 0px))`;
    const bottom = state.paneHosted
      ? `${BOTTOM_CHROME_PX}px`
      : `calc(env(safe-area-inset-bottom) + ${BOTTOM_CHROME_PX}px + var(--pane-dock-bottom-height, 0px))`;
    if (top !== lastTop) { root.style.top = top; lastTop = top; }
    if (bottom !== lastBottom) { root.style.bottom = bottom; lastBottom = bottom; }
  }

  const onChange = () => update();
  state.addEventListener("change", onChange);
  update();

  return {
    root,
    destroy() {
      state.removeEventListener("change", onChange);
      if (inkTimer) { clearTimeout(inkTimer); inkTimer = null; }
      if (tweenRaf) { cancelAnimationFrame(tweenRaf); tweenRaf = 0; }
      // A rail torn down mid-drag would otherwise leave the whole app
      // wearing a resize cursor, since the class is on <body> and the
      // pointerup that clears it is going to a detached element.
      // Checked per rail: a second proof open elsewhere may be the one
      // actually being dragged.
      if (resizer.classList.contains("is-dragging")) {
        document.body.classList.remove("notebook-proof-rail-resizing");
      }
      root.remove();
    },
  };
}
