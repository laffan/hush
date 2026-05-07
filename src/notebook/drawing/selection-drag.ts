/* src/notebook/drawing/selection-drag.ts
 *
 * Hush ↔ engine selection-drag bridge extracted from drawing-layer.ts.
 *
 * Naive drag is "update N DrawShape.points per frame, fire shapes
 * notify, diff, call setStrokePoints N times, rebake N tiles" — that
 * craters above ~20 strokes. Instead we route DrawShape moves through
 * the engine's `previewTransform`: the selected strokes drop off the
 * done canvas and ride a single GPU-composited preview overlay for
 * the duration of the gesture, then we commit the final delta and
 * let the shim rebridge points on release.
 *
 * The shim has to pause for the duration so per-frame state.shapes
 * point updates from Hush's drag handler don't re-enter the engine,
 * and the engine's bbox + handles hide so Hush owns the visible
 * feedback while the gesture runs. The try / finally ladder keeps
 * the shim from staying paused if previewTransform / commitTransform
 * throws.
 */

interface StrokeEngineLike {
  previewTransform(ids: Set<number>, payload: { kind: "move"; dx: number; dy: number } | null): void;
  commitTransform(ids: Set<number>, fn: (x: number, y: number) => [number, number]): void;
}

interface SelectionEngineLike {
  beginExternalDrag(): void;
  endExternalDrag(): void;
}

interface ShimLike {
  getEngineStrokeId(hushId: string): number | undefined;
  pauseForDrag(): void;
  resumeForDrag(): void;
}

export interface SelectionDragController {
  begin(hushIds: Iterable<string>): void;
  update(totalDx: number, totalDy: number): void;
  end(): void;
}

export function createSelectionDragController(opts: {
  strokeEngine: StrokeEngineLike;
  selectionEngine: SelectionEngineLike;
  shim: ShimLike;
}): SelectionDragController {
  const { strokeEngine, selectionEngine, shim } = opts;
  let dragEngineIds: Set<number> | null = null;
  let dragTotalDx = 0;
  let dragTotalDy = 0;

  function begin(hushIds: Iterable<string>): void {
    const ids = new Set<number>();
    for (const hid of hushIds) {
      const eid = shim.getEngineStrokeId(hid);
      if (eid !== undefined) ids.add(eid);
    }
    if (ids.size === 0) return;
    dragEngineIds = ids;
    dragTotalDx = 0;
    dragTotalDy = 0;
    shim.pauseForDrag();
    selectionEngine.beginExternalDrag();
    try { strokeEngine.previewTransform(dragEngineIds, { kind: "move", dx: 0, dy: 0 }); }
    catch (e) {
      console.warn("beginSelectionDrag: previewTransform failed:", e);
      shim.resumeForDrag();
      dragEngineIds = null;
    }
  }

  function update(totalDx: number, totalDy: number): void {
    if (!dragEngineIds || dragEngineIds.size === 0) return;
    dragTotalDx = totalDx;
    dragTotalDy = totalDy;
    strokeEngine.previewTransform(dragEngineIds, { kind: "move", dx: totalDx, dy: totalDy });
  }

  function end(): void {
    if (!dragEngineIds || dragEngineIds.size === 0) {
      dragEngineIds = null;
      selectionEngine.endExternalDrag();
      shim.resumeForDrag();
      return;
    }
    try {
      const dx = dragTotalDx, dy = dragTotalDy;
      strokeEngine.commitTransform(dragEngineIds, (x, y) => [x + dx, y + dy]);
      strokeEngine.previewTransform(dragEngineIds, null);
    } finally {
      selectionEngine.endExternalDrag();
      shim.resumeForDrag();
      dragEngineIds = null;
      dragTotalDx = 0;
      dragTotalDy = 0;
    }
  }

  return { begin, update, end };
}
