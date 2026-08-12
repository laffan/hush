/**
 * Page thumbnail rail for a proofread notebook.
 *
 * Sits flush against the LEFT edge of the shelf, which is why it reads
 * `state.rightInset` (the canvas controller keeps that in sync with the
 * shelf's animating width) rather than pinning itself to the viewport:
 * with the shelf closed the rail sits just inboard of its 24 px grip and
 * is fully visible; opening the shelf pushes the rail left instead of
 * burying it.
 *
 * The thumbnails are the small rasters baked at import time
 * (`ProofPage.thumbDataUrl`), NOT scaled-down page images. Pointing an
 * `<img>` at a full-size page raster would decode the whole page just to
 * paint 90 px of it, and a rail of fifty of those is the exact memory
 * blow-up `image-budget.ts` exists to prevent.
 */

import type { DrawingState } from "../state";
import { h } from "./dom-helpers";

const RAIL_WIDTH = 92;
const THUMB_WIDTH = 76;

export interface ProofThumbnailRail {
  root: HTMLElement;
  destroy(): void;
}

export function createProofThumbnails(state: DrawingState): ProofThumbnailRail {
  const scroller = h("div", {
    style: {
      flex: "1", overflowY: "auto", overflowX: "hidden",
      display: "flex", flexDirection: "column", alignItems: "center",
      gap: "8px", padding: "8px 0",
    },
  });

  const root = h("div", {
    style: {
      position: "absolute", top: "calc(env(safe-area-inset-top) + 20px + var(--pane-dock-top-height, 0px))",
      bottom: "calc(env(safe-area-inset-bottom) + 20px + var(--pane-dock-bottom-height, 0px))",
      width: `${RAIL_WIDTH}px`, display: "none", flexDirection: "column",
      // Below the shelf (150) so the shelf's rounded edge stays on top,
      // above the toolbar (100) so a centred bar can't cover the rail.
      zIndex: "149", borderRadius: "10px 0 0 10px", overflow: "hidden",
      boxShadow: "0 2px 12px rgba(0,0,0,0.12)", backdropFilter: "blur(8px)",
    },
    children: [scroller],
  });
  root.classList.add("notebook-proof-rail");

  const cells = new Map<number, HTMLElement>();
  let builtFor: string | null = null;
  let activeIndex = -1;
  let lastSkin = "";
  let lastRight = -1;

  function build() {
    const proof = state.proof;
    scroller.innerHTML = "";
    cells.clear();
    if (!proof) return;
    for (const page of proof.pages) {
      const img = h("img", {
        attrs: { src: page.thumbDataUrl, alt: `Page ${page.index + 1}`, draggable: "false" },
        style: { width: `${THUMB_WIDTH}px`, height: "auto", display: "block", borderRadius: "2px" },
      });
      const label = h("div", {
        text: String(page.index + 1),
        style: { fontSize: "10px", textAlign: "center", opacity: "0.6", marginTop: "2px", fontFamily: "var(--ui-font-family)" },
      });
      const cell = h("div", {
        title: `Page ${page.index + 1}`,
        style: {
          cursor: "pointer", padding: "3px", borderRadius: "4px",
          border: "1px solid transparent", flexShrink: "0",
        },
        children: [img, label],
        onClick: (e) => { e.stopPropagation(); },
      });
      // The rail is a DOM sibling above the canvas, so a tap here never
      // reaches the canvas's own pointer handlers — which is what lets a
      // grab waiting in its place stage survive a page jump. The
      // stopPropagation is belt-and-braces for hosts that reparent us.
      cell.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        jumpToPage(page.index);
      });
      cells.set(page.index, cell);
      scroller.appendChild(cell);
    }
  }

  /** Centre the page in the viewport at the current zoom. The live shape
   *  wins over the stored placement — a page that has been split or
   *  dragged has moved, and the rail should follow it there. */
  function jumpToPage(index: number) {
    const proof = state.proof;
    if (!proof) return;
    const page = proof.pages.find((p) => p.index === index);
    if (!page) return;
    const shape = state.shapes.find((s) => s.id === page.shapeId);
    const y = shape && shape.type === "image" ? shape.position.y : page.y;
    const x = shape && shape.type === "image" ? shape.position.x : 0;
    const zoom = state.camera.zoom;
    const w = state.canvasEl?.clientWidth || window.innerWidth;
    const pageW = shape && shape.type === "image" ? shape.width : 0;
    // A 40 px top margin so the page edge isn't flush with the toolbar,
    // and horizontally centred on the usable width between the sidebar
    // and the rail itself.
    const usableLeft = state.leftInset || 0;
    const usableW = Math.max(0, w - usableLeft - (state.rightInset || 0) - RAIL_WIDTH);
    state.camera = {
      ...state.camera,
      x: usableLeft + usableW / 2 - (x + pageW / 2) * zoom,
      y: 40 - y * zoom,
    };
    state.notify("camera");
  }

  /** Highlight whichever page owns the viewport's vertical centre.
   *  Runs on every state notify — including every pan frame — so the
   *  page lookup is one Map build over the shapes rather than a
   *  `find` per page (which is pages × shapes of scanning per frame on
   *  exactly the notebooks that can least afford it). */
  function syncActive() {
    const proof = state.proof;
    if (!proof) return;
    const h0 = state.canvasEl?.clientHeight || window.innerHeight;
    const zoom = state.camera.zoom;
    const centerWorldY = (h0 / 2 - state.camera.y) / zoom;
    const byId = new Map(state.shapes.map((s) => [s.id, s]));
    let next = -1;
    for (const page of proof.pages) {
      const shape = byId.get(page.shapeId);
      const top = shape && shape.type === "image" ? shape.position.y : page.y;
      const height = shape && shape.type === "image" ? shape.height : page.height;
      if (centerWorldY >= top && centerWorldY <= top + height) { next = page.index; break; }
      if (top <= centerWorldY) next = page.index;
    }
    if (next === activeIndex) return;
    const theme = state.theme;
    cells.get(activeIndex)?.style.setProperty("border-color", "transparent");
    activeIndex = next;
    const cell = cells.get(activeIndex);
    if (cell) {
      cell.style.borderColor = theme.accent;
      cell.scrollIntoView({ block: "nearest" });
    }
  }

  function update() {
    const proof = state.proof;
    if (!proof) {
      root.style.display = "none";
      return;
    }
    // Rebuild only when the page set itself changed — this runs on every
    // state notify, and rebuilding fifty <img> elements per pan frame
    // would undo everything the thumbnail bake bought us.
    const key = `${proof.pages.length}:${proof.pages[0]?.shapeId || ""}`;
    if (key !== builtFor) { builtFor = key; build(); }
    const theme = state.theme;
    root.style.display = "flex";
    // Only touch the style properties that changed — this runs on every
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
    // safe-area inset and any right-docked pane. Offsetting by it puts
    // the rail flush against the shelf however wide the shelf currently
    // is — including mid-transition, which is why the controller
    // re-measures per frame while the shelf animates.
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
