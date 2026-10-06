/**
 * Snap to grid — a per-notebook option (the canvas options popup, saved
 * with the background like canvas rotation) under which a moved selection
 * lands on the background grid: the grid of `gridSpacing`, phase-locked to
 * the world origin, which is the one the pattern draws.
 *
 * A drag snaps when it is dropped. The whole moved set shifts by one
 * offset — the one that puts the top-left of its attached shapes' box on
 * a grid point — so a group, a drag area's contents or a dragged
 * flowchart keep their arrangement. A shape can be released from the
 * grid (`gridFree`, from the selection toolbar) and then moves freely; a
 * drag made only of released shapes doesn't snap, and re-attaching a
 * shape snaps it straight away. Ink isn't snapped: while a drag moves
 * strokes the drawing engine owns their positions until it bakes them,
 * so a drag that carries any is left where it was dropped.
 */
import type { DrawingState } from "./state";
import type { Shape } from "./types";
import { getShapeBounds } from "./utils";
import { moveShape } from "./state-helpers";

function positionOf(s: Shape): { x: number; y: number } | null {
  return s.type === "draw" ? null : s.position;
}

/** The offset that puts the top-left of `shapes`' box on the grid. */
function snapOffset(state: DrawingState, shapes: Shape[]): { dx: number; dy: number } | null {
  const step = state.gridSpacing;
  if (!(step > 0) || !shapes.length) return null;
  let minX = Infinity, minY = Infinity;
  for (const s of shapes) {
    const b = getShapeBounds(s, state.fontFamily);
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
  }
  const dx = Math.round(minX / step) * step - minX;
  const dy = Math.round(minY / step) * step - minY;
  return dx || dy ? { dx, dy } : null;
}

/** After a drag: snap what it moved (shapes that changed position since
 *  `before`). Returns whether anything moved. The caller records the
 *  history step, as it does for the drag itself. */
export function snapMovedToGrid(state: DrawingState, before: Shape[] | null): boolean {
  if (!state.snapToGrid || !before) return false;
  const prev = new Map(before.map((s) => [s.id, s]));
  const moved = state.shapes.filter((s) => {
    const p = prev.get(s.id);
    if (!p || p === s) return false;
    if (s.type === "draw" || p.type === "draw") return true; // flagged below
    const a = positionOf(p), b = positionOf(s);
    return !!a && !!b && (a.x !== b.x || a.y !== b.y);
  });
  if (!moved.length || moved.some((s) => s.type === "draw" || s.pocketed)) return false;
  const off = snapOffset(state, moved.filter((s) => !s.gridFree));
  if (!off) return false;
  const ids = new Set(moved.map((s) => s.id));
  state.shapes = state.shapes.map((s) => (ids.has(s.id) ? moveShape(s, off.dx, off.dy) : s));
  return true;
}

/** Release the selected shapes from the grid, or attach them to it again
 *  (snapping each attached one into place). One undo step. */
export function setSelectedGridFree(state: DrawingState, free: boolean): void {
  const step = state.gridSpacing;
  state.shapes = state.shapes.map((s) => {
    if (!state.selectedIds.has(s.id) || s.type === "draw") return s;
    if (free) return s.gridFree ? s : { ...s, gridFree: true };
    const { gridFree: _f, ...rest } = s;
    const attached = rest as Shape;
    if (!state.snapToGrid || !(step > 0)) return attached;
    const off = snapOffset(state, [attached]);
    return off ? moveShape(attached, off.dx, off.dy) : attached;
  });
  state.recordHistory();
  state.notify("shapes");
}
