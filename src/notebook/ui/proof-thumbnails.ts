/**
 * Page rail for a proofread notebook — a live vertical minimap of the
 * page layer.
 *
 * It is NOT a list of the pages the PDF had. It is a picture of the
 * document as it stands: split a page and the rail shows two pieces with
 * the gap between them; drag a split open and the gap grows; grab a
 * band out and the rail loses it. That is the whole point of having it
 * next to a proof — the canvas shows you one page at a time, and the
 * rail is where you see what the surgery did to the shape of the
 * document.
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

export const RAIL_MIN_WIDTH = 60;
export const RAIL_MAX_WIDTH = 300;
export const RAIL_DEFAULT_WIDTH = 92;

/** Horizontal padding inside the rail, each side. */
const RAIL_PAD = 8;

/** Ceiling on how tall a gap between two pieces may render. A split
 *  dragged a whole screen open would otherwise push every later page off
 *  the bottom of a rail whose job is showing you the running order. */
const MAX_GAP_PX = 120;

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
  const scroller = h("div", {
    style: {
      flex: "1", overflowY: "auto", overflowX: "hidden",
      display: "flex", flexDirection: "column", alignItems: "flex-start",
      padding: `${RAIL_PAD}px ${RAIL_PAD}px`, boxSizing: "border-box",
    },
  });

  const resizer = h("div", {
    title: "Drag to resize",
    style: {
      position: "absolute", left: "0", top: "0", bottom: "0", width: "7px",
      cursor: "ew-resize", zIndex: "2",
    },
  });

  const root = h("div", {
    style: {
      position: "absolute", top: "calc(env(safe-area-inset-top) + 20px + var(--pane-dock-top-height, 0px))",
      bottom: "calc(env(safe-area-inset-bottom) + 20px + var(--pane-dock-bottom-height, 0px))",
      display: "none", flexDirection: "column", boxSizing: "border-box",
      // Below the shelf (150) so the shelf's rounded edge stays on top,
      // above the toolbar (100) so a centred bar can't cover the rail.
      zIndex: "149", borderRadius: "10px 0 0 10px", overflow: "hidden",
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
    scroller.innerHTML = "";
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
      // The rail is a DOM sibling above the canvas, so a tap here never
      // reaches the canvas's own pointer handlers — which is what lets a
      // grab waiting in its place stage survive a page jump. The
      // stopPropagation is belt-and-braces for hosts that reparent us.
      cell.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        jumpTo(piece);
      });
      cells.push({ el: cell, piece });
      scroller.appendChild(cell);
    }
  }

  /** Write every piece's size, crop offset and inter-piece gap. Split
   *  from `rebuild` because a split drag changes all of these on every
   *  frame while the element set stays identical. */
  function layout(pieces: Piece[]) {
    const scale = contentWidth() / documentWidth(pieces);
    let minX = Infinity;
    for (const p of pieces) if (p.x < minX) minX = p.x;
    if (!isFinite(minX)) minX = 0;
    let prevBottom: number | null = null;

    for (let i = 0; i < cells.length; i++) {
      const { el, piece } = cells[i];
      const crop = piece.shape.crop || { x: 0, y: 0, w: 1, h: 1 };
      const cw = Math.max(1, piece.w * scale);
      const ch = Math.max(1, piece.h * scale);
      el.style.width = `${cw}px`;
      el.style.height = `${ch}px`;
      el.style.marginLeft = `${Math.max(0, (piece.x - minX) * scale)}px`;
      // Gap = the real world distance from the previous piece, to scale,
      // so an opened split reads as an opened split.
      const gap = prevBottom == null ? 0 : Math.max(0, Math.min(MAX_GAP_PX, (piece.y - prevBottom) * scale));
      el.style.marginTop = `${gap}px`;
      prevBottom = piece.y + piece.h;

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
    }
  }

  /** Centre a piece in the viewport at the current zoom. */
  function jumpTo(piece: Piece) {
    const zoom = state.camera.zoom;
    const w = state.canvasEl?.clientWidth || window.innerWidth;
    const usableLeft = state.leftInset || 0;
    const usableW = Math.max(0, w - usableLeft - (state.rightInset || 0) - width);
    state.camera = {
      ...state.camera,
      x: usableLeft + usableW / 2 - (piece.x + piece.w / 2) * zoom,
      y: 40 - piece.y * zoom,
    };
    state.notify("camera");
  }

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
      activeEl.scrollIntoView({ block: "nearest" });
    }
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
      const app = (window as unknown as { __hushState__?: { updateSettings?: (p: Record<string, unknown>) => void } }).__hushState__;
      app?.updateSettings?.({ notebookProofRailWidth: width });
    };
    resizer.addEventListener("pointermove", onMove);
    resizer.addEventListener("pointerup", onUp);
    resizer.addEventListener("pointercancel", onUp);
  });

  // ── update ──

  function update() {
    if (!state.proof) { root.style.display = "none"; return; }
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

    const theme = state.theme;
    // Only touch style properties that changed — this runs on every
    // notify, and unconditional writes cost a style recalc per pan frame.
    const skin = `${theme.uiBackground}|${theme.uiBorder}|${theme.foreground}`;
    if (skin !== lastSkin) {
      lastSkin = skin;
      root.style.background = theme.uiBackground;
      root.style.borderLeft = `1px solid ${theme.uiBorder}`;
      root.style.color = theme.foreground;
    }
    // `rightInset` is the canvas-right-edge → shelf-left-edge distance,
    // measured live by the canvas controller, so it already folds in the
    // safe-area inset and any right-docked pane.
    const right = Math.max(0, state.rightInset || 0);
    if (right !== lastRight) {
      lastRight = right;
      root.style.right = `${right}px`;
    }
    syncActive();
  }

  const onChange = () => update();
  state.addEventListener("change", onChange);
  update();

  return {
    root,
    destroy() {
      state.removeEventListener("change", onChange);
      root.remove();
    },
  };
}
