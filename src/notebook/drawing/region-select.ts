/* src/notebook/drawing/region-select.ts
 *
 * Pen-mode region selection: the glue between the stroke engine's
 * lasso / marquee gestures and Hush's shape-level hit test.
 *
 * The engine can only see strokes, so it no longer decides what a
 * region selected. It hands the polygon up (engine deltas #32/#33) and
 * this module translates engine-local → world, runs
 * `DrawingState.selectShapesInRegion` (selection-region.ts), and lets
 * the selection bridge push the stroke subset back down for the bbox.
 * One hit test, every shape type, whichever gesture drew the region.
 *
 * It also owns the two bits of session state that hang off those
 * gestures: the transient sub-tool (a lasso / marquee promotes the user
 * out of their brush and back into it when the region comes up empty)
 * and the engine-driven bbox move of a mixed selection, where strokes
 * ride the engine's preview transform and every other shape is moved
 * by DrawingState from a snapshot.
 *
 * Extracted from drawing-layer.ts, which is at the 700-line cap.
 */

import type { Point } from "../types";
import type { ShimState } from "./sync-shim";
import type { AnchorState } from "./re-anchor";

type SubTool = "draw" | "erase" | "slice" | "select";

interface MarqueeCapableSelection {
  startMarqueeAtPointer(pointerId: number, point: { x: number; y: number }): void;
}

export interface RegionSelectController {
  /** Engine delta #32 — completed lasso / marquee polygon, engine-local. */
  onLassoRegion(poly: number[][]): void;
  /** Engine delta #33 — a finger dragged in pen mode; start a marquee. */
  onFingerDragSelect(e: { pointerId: number; point: { x: number; y: number } }): void;
  onEngineDragStart(kind: "move" | "resize" | "rotate"): void;
  onEngineDragMove(info: { kind: string; dx: number; dy: number }): void;
  onEngineDragEnd(cancelled?: boolean): void;
  /** A region gesture (lasso or marquee) is starting: promote the user
   *  into select mode, remembering the brush they came from, and clear
   *  the old selection so its chrome doesn't hang around under the
   *  polygon they're drawing. */
  beginRegionGesture(): void;
  /** Hand the remembered brush back — the region came up empty, or the
   *  selection was dismissed (Escape, delete). */
  restoreTransientSubTool(): void;
  /** Engine delta #33 — the pen touched down during a borrowed select.
   *  Returns true once the brush is back and this contact may draw. */
  onPenResumeDraw(): boolean;
  destroy(): void;
}

export function createRegionSelect(deps: {
  state: ShimState;
  anchor: AnchorState;
  selectionBox: { current: MarqueeCapableSelection | null };
  /** Flash the "select" pill at an engine-local point. */
  flashHint: (localPt: { x: number; y: number }) => void;
  /** Synchronous engine-side tool flip. The usual route (setDrawingSubTool
   *  → notify → tool-panel → setTool) is a microtask late, and the pen
   *  contact that triggers it has to draw *now*. */
  setEngineTool: (tool: SubTool) => void;
  /** Synchronous counterpart for the selection engine's event capture,
   *  so the same pen contact doesn't also open a lasso. */
  setSelectionEventActive: (active: boolean) => void;
}): RegionSelectController {
  const { state, anchor, selectionBox, flashHint, setEngineTool, setSelectionEventActive } = deps;

  // Sub-tool the user was on before a lasso / marquee promoted them
  // into select mode. Restored when the region misses or they tap away
  // — null when select mode was chosen deliberately from the toolbar,
  // where auto-exiting would be wrong.
  let transientPrevSubTool: Exclude<SubTool, "select"> | null = null;

  function enterTransientSelect(): void {
    if (state.drawingSubTool === "select") return;
    transientPrevSubTool = state.drawingSubTool as Exclude<SubTool, "select">;
    state.setDrawingSubTool("select");
  }

  function restoreTransientSubTool(): void {
    if (!transientPrevSubTool) return;
    const prev = transientPrevSubTool;
    transientPrevSubTool = null;
    if (state.drawingSubTool === "select") state.setDrawingSubTool(prev);
  }

  // A manual sub-tool change (brush slot, Erase, Slice, toolbar Lasso)
  // clears the memo so a later deselect doesn't "restore" a stale tool.
  const onSubToolChange = ((e: CustomEvent) => {
    const keys: string[] = (e.detail && e.detail.keys) || [];
    if (!keys.includes("drawingSubTool")) return;
    if (state.drawingSubTool !== "select") transientPrevSubTool = null;
  }) as EventListener;
  state.addEventListener("change", onSubToolChange);

  function onLassoRegion(poly: number[][]): void {
    const world: Point[] = poly.map(([x, y]) => ({
      x: x + anchor.originX,
      y: y + anchor.originY,
    }));
    const hits = state.selectShapesInRegion(world);
    // An empty region is a dismissal: hand the user back their brush so
    // a stray sweep doesn't strand them in select mode.
    if (hits === 0) restoreTransientSubTool();
  }

  /** The engine has already dropped its own selection by the time a
   *  region gesture starts; drop Hush's too so the canvas isn't still
   *  painting highlights around shapes the sweep is about to replace. */
  function beginRegionGesture(): void {
    // Flip to select first: the stroke engine must stop accepting
    // pointerdowns as draws while the selection is live, or a tap
    // inside the bbox both moves the selection and starts a stroke.
    enterTransientSelect();
    if (state.selectedIds.size > 0) {
      state.selectedIds = new Set();
      state.notify("selectedIds");
    }
  }

  function onFingerDragSelect(e: { pointerId: number; point: { x: number; y: number } }): void {
    const sel = selectionBox.current;
    if (!sel) return;
    beginRegionGesture();
    sel.startMarqueeAtPointer(e.pointerId, e.point);
    flashHint(e.point);
  }

  /** Pen down during a borrowed select: restore the brush in the same
   *  tick so the engine's pointerdown can fall straight through into a
   *  stroke, and stop the selection engine listening so it doesn't open
   *  a lasso on the same contact. */
  function onPenResumeDraw(): boolean {
    if (!transientPrevSubTool) return false;
    const prev = transientPrevSubTool;
    restoreTransientSubTool();
    setSelectionEventActive(false);
    setEngineTool(prev);
    return true;
  }

  function onEngineDragStart(kind: "move" | "resize" | "rotate"): void {
    // Hide Hush's own group highlight + selection toolbar for the
    // duration so the engine bbox is the only chrome tracking the
    // gesture — two boxes on slightly different paths read as lag.
    if (!state.strokeEngineDragging) {
      state.strokeEngineDragging = true;
      state.notify("strokeEngineDragging");
    }
    // Only a move carries the non-stroke half of the selection. Resize
    // and rotate are stroke-only transforms (the bridge hides those
    // handles for mixed selections), so there's nothing to snapshot.
    if (kind === "move") state.beginExternalMove();
  }

  function onEngineDragMove(info: { kind: string; dx: number; dy: number }): void {
    if (info.kind !== "move") return;
    state.updateExternalMove(info.dx, info.dy);
  }

  function onEngineDragEnd(cancelled?: boolean): void {
    state.endExternalMove(!!cancelled);
    if (state.strokeEngineDragging) {
      state.strokeEngineDragging = false;
      state.notify("strokeEngineDragging");
    }
  }

  return {
    onLassoRegion,
    onFingerDragSelect,
    beginRegionGesture,
    onEngineDragStart,
    onEngineDragMove,
    onEngineDragEnd,
    restoreTransientSubTool,
    onPenResumeDraw,
    destroy() { state.removeEventListener("change", onSubToolChange); },
  };
}
