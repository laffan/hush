/**
 * Bridges Hush's `state.selectedIds` set into the engine's selection
 * so the resize / rotate bbox + handles appear for strokes selected
 * via *any* tool, not just the pen-mode lasso. CSS pins
 * `pointer-events: auto` on the bbox + handles so they stay
 * interactive even while the SVG root is non-capturing outside pen
 * mode (see `drawing-layer-dom.ts` and `notebook.css`).
 *
 * Since selection unification (selection-region.ts) this runs in pen
 * mode too: the lasso and the finger marquee hand their polygon to
 * Hush, Hush hit-tests every shape type, and the result comes back
 * down here. That means a selection can now hold shapes the engine has
 * never heard of — text, images, drag-areas — so the bridge also
 * unions their bounds into the engine bbox (delta #34) and hides the
 * resize / rotate handles, which only ever reach strokes.
 *
 * Pulled out of `drawing-layer.ts` to keep that file under the 700
 * line cap.
 */

import type { Bounds } from "../types";
import { unionBoundsOf } from "../selection-region";
import type { ShimState } from "./sync-shim";

interface SelectionEngine {
  activate(): void;
  deactivate(): void;
  setSelectedIds(ids: Iterable<number>): void;
  setBboxClickable(enabled: boolean): void;
  setChromeHidden(hidden: boolean): void;
  setChromeInteractive(enabled: boolean): void;
  setExternalBounds(bbox: { x: number; y: number; w: number; h: number } | null): void;
  setHandlesHidden(hidden: boolean): void;
  isRegionActive(): boolean;
}

interface ShimRef {
  current: { getEngineStrokeId(id: string): number | undefined } | null;
}

/** Engine coords are world coords shifted by the canvas backing's
 *  origin, which slides as the camera pans (`re-anchor.ts`). */
interface OriginRef { originX: number; originY: number }

export function createSelectionBridge(deps: {
  state: ShimState;
  selectionEngine: SelectionEngine;
  shimBox: ShimRef;
  anchor: OriginRef;
}): { refresh(): void; destroy(): void } {
  const { state, selectionEngine, shimBox, anchor } = deps;
  let bridging = false;

  function toLocalBox(b: Bounds | null): { x: number; y: number; w: number; h: number } | null {
    if (!b) return null;
    return {
      x: b.minX - anchor.originX,
      y: b.minY - anchor.originY,
      w: b.maxX - b.minX,
      h: b.maxY - b.minY,
    };
  }

  function sync(): void {
    if (bridging) return;
    // An engine-driven drag owns the bbox for the duration: it walks
    // the box from a drag-start snapshot while the strokes ride a
    // preview transform, so recomputing here from half-moved state
    // (the non-stroke shapes mutate per frame) would fight it.
    if (state.strokeEngineDragging) return;
    // Likewise a lasso / marquee mid-gesture: pushing a selection down
    // now would clear the polygon the user is still drawing. The region
    // resolves into state.selectedIds on release and we sync then.
    if (selectionEngine.isRegionActive()) return;

    const drawIds = new Set<number>();
    for (const id of state.selectedIds) {
      const eid = shimBox.current?.getEngineStrokeId(id);
      if (eid !== undefined) drawIds.add(eid);
    }
    // Pen-mode drawing / erasing / slicing keeps the selection alive
    // (so brush-slot taps and flyout edits can retroactively restyle
    // it). Show the chrome as a passive visual cue but flip
    // pointer-events off so the handles don't intercept the user's next
    // stroke — they're only there for feedback while the user iterates
    // on size / color / brush against the live selection.
    const penSelect = state.tool === "pen" && state.drawingSubTool === "select";
    const inPenNonSelect = state.tool === "pen" && !penSelect;

    // Bounds of the selected shapes the engine can't see — pen mode
    // only. There, the drawing SVG is capturing, so the notebook canvas
    // never sees a pointerdown: without this the engine bbox would
    // frame the strokes alone and a lassoed text shape would have no
    // chrome and no way to be dragged. Under the Select tool Hush's own
    // highlights and drag already cover it, and a second dashed rect
    // around them is just noise.
    const extra = state.tool === "pen" ? toLocalBox(unionBoundsOf(
      state.shapes, state.selectedIds, state.fontFamily, (s) => s.type !== "draw",
    )) : null;

    bridging = true;
    try {
      if (drawIds.size > 0 || extra) {
        selectionEngine.activate();
        selectionEngine.setExternalBounds(extra);
        selectionEngine.setSelectedIds(drawIds);
        // In pen-select the bbox body is the grab target for moving the
        // selection. Everywhere else it has to pass clicks through, or
        // it covers the shapes underneath and steals Hush's own drag.
        selectionEngine.setBboxClickable(penSelect);
        selectionEngine.setChromeHidden(false);
        selectionEngine.setChromeInteractive(!inPenNonSelect);
        // Resize + rotate bake into stroke points; a mixed selection
        // would scale the ink and leave the text shapes behind.
        selectionEngine.setHandlesHidden(extra != null);
      } else {
        selectionEngine.setExternalBounds(null);
        selectionEngine.setSelectedIds(new Set());
        // Pen-select must stay event-active with an empty selection —
        // that's the state a lasso starts from. `deactivate()` there
        // would stop the engine listening and the next sweep would
        // never begin.
        if (penSelect) selectionEngine.activate();
        else selectionEngine.deactivate();
        selectionEngine.setChromeHidden(false);
        selectionEngine.setChromeInteractive(true);
        selectionEngine.setHandlesHidden(false);
      }
    } finally {
      bridging = false;
    }
  }

  const onChange = ((e: CustomEvent) => {
    const keys: string[] = (e.detail && e.detail.keys) || [];
    if (!keys.includes("selectedIds") && !keys.includes("shapes") &&
        !keys.includes("tool") && !keys.includes("drawingSubTool") &&
        !keys.includes("strokeEngineDragging")) return;
    sync();
  }) as EventListener;
  state.addEventListener("change", onChange);

  return {
    // Called after a re-anchor: the stored external bounds are in
    // engine-local coords, so an origin shift invalidates them.
    refresh() { sync(); },
    destroy() { state.removeEventListener("change", onChange); },
  };
}
