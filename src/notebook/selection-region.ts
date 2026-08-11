/* src/notebook/selection-region.ts
 *
 * One region → selection hit test, shared by every "sweep an area to
 * select" gesture on the canvas:
 *
 *   - the Select tool's rectangle marquee (`DrawingState.selectionBox`),
 *   - the pen-mode finger marquee (engine SVG rect, iPad),
 *   - the pen-mode freehand lasso (engine SVG path).
 *
 * All three hand a **world-space polygon** to `collectShapesInPolygon`
 * and get back a set of Hush shape ids. A rectangle is just a 4-point
 * polygon, so the marquee and the lasso can't drift apart in what they
 * consider "inside" — which is the whole point: before this module the
 * lasso lived in the stroke engine and could only ever see strokes,
 * while the marquee lived in DrawingState and hit-tested bounding
 * boxes. Two mechanisms, two answers.
 *
 * Hit rules per shape type:
 *   - `draw`   — any stroke point inside the polygon, or any stroke
 *                segment crossing a polygon edge (so a long, sparsely
 *                sampled stroke swept across the middle still counts).
 *   - everything else — the shape's bounds intersect the polygon. For
 *                an axis-aligned rectangle polygon this is exactly the
 *                old `boundsOverlap` behaviour, so marquee semantics
 *                for text / images / drag-areas are unchanged.
 *
 * Pure module: geometry only, no DOM and no state access.
 */

import type { Bounds, Point, Shape } from "./types";
import { getShapeBounds } from "./utils";

export interface RegionSelectOptions {
  fontFamily?: string;
  /** Shapes on these layers are invisible, so they can't be swept up. */
  hiddenLayerIds?: Set<string> | null;
  /** Extra ids to skip (e.g. shapes currently drawn in the pocket
   *  tray, whose world position is stale). */
  skipIds?: Set<string> | null;
}

/** Corner-to-corner rectangle as a closed 4-point polygon. */
export function rectPolygon(a: Point, b: Point): Point[] {
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

export function polygonBounds(poly: Point[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Even-odd ray cast. Same implementation the stroke engine's lasso
 *  used, kept identical so pen-mode selections don't shift meaning. */
export function pointInPolygon(x: number, y: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect =
      (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** Proper segment crossing (shared endpoints / collinear overlap read
 *  as "no crossing" — the point-inside and bounds tests already cover
 *  those degenerate cases). */
function segmentsCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d1 = orient(ax, ay, bx, by, cx, cy);
  const d2 = orient(ax, ay, bx, by, dx, dy);
  const d3 = orient(cx, cy, dx, dy, ax, ay);
  const d4 = orient(cx, cy, dx, dy, bx, by);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function segmentCrossesPolygon(
  ax: number, ay: number, bx: number, by: number, poly: Point[],
): boolean {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (segmentsCross(ax, ay, bx, by, poly[j].x, poly[j].y, poly[i].x, poly[i].y)) return true;
  }
  return false;
}

function boundsOverlapRaw(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Rect-vs-polygon intersection. Three ways they can meet: a polygon
 *  vertex inside the rect, a rect corner inside the polygon, or an
 *  edge crossing with neither's vertices contained (a sliver passing
 *  straight through). For an axis-aligned rectangle polygon the first
 *  two cover every overlap, so this collapses to plain bounds overlap. */
export function boundsIntersectPolygon(b: Bounds, poly: Point[], pb: Bounds): boolean {
  if (!boundsOverlapRaw(b, pb)) return false;
  for (const p of poly) {
    if (p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY) return true;
  }
  const corners: [number, number][] = [
    [b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY],
  ];
  for (const [x, y] of corners) {
    if (pointInPolygon(x, y, poly)) return true;
  }
  for (let i = 0; i < corners.length; i++) {
    const [x1, y1] = corners[i];
    const [x2, y2] = corners[(i + 1) % corners.length];
    if (segmentCrossesPolygon(x1, y1, x2, y2, poly)) return true;
  }
  return false;
}

/** Stroke test: sampled points first (the common case — ink is dense),
 *  then segment crossings for the sparse two-point straight line a
 *  marquee is swept across. Callers reject by bbox first, so the
 *  quadratic-looking loops only run for strokes near the region. */
function strokeIntersectsPolygon(points: Point[], poly: Point[]): boolean {
  for (const p of points) {
    if (pointInPolygon(p.x, p.y, poly)) return true;
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (segmentCrossesPolygon(a.x, a.y, b.x, b.y, poly)) return true;
  }
  return false;
}

export function shapeIntersectsPolygon(
  shape: Shape, poly: Point[], pb: Bounds, fontFamily?: string,
): boolean {
  const b = getShapeBounds(shape, fontFamily);
  if (!boundsOverlapRaw(b, pb)) return false;
  if (shape.type === "draw") return strokeIntersectsPolygon(shape.points, poly);
  return boundsIntersectPolygon(b, poly, pb);
}

/** Every shape the region touches, with grouped shapes promoted to
 *  whole groups — a group's members move / style together, so a
 *  partial sweep that split one would tear it apart on the next drag.
 *
 *  A degenerate region (a tap, or a sub-pixel drag) selects nothing:
 *  the caller's "did this hit anything" branch is how a stray tap in
 *  pen mode gets the user back to their brush. */
export function collectShapesInPolygon(
  shapes: Shape[], poly: Point[], opts: RegionSelectOptions = {},
): Set<string> {
  const out = new Set<string>();
  if (poly.length < 3) return out;
  const pb = polygonBounds(poly);
  if (pb.maxX - pb.minX < 1 && pb.maxY - pb.minY < 1) return out;

  const hidden = opts.hiddenLayerIds;
  const skip = opts.skipIds;
  const touchedGroups = new Set<string>();
  for (const s of shapes) {
    if (s.pocketed) continue;
    if (hidden && s.layerId && hidden.has(s.layerId)) continue;
    if (skip && skip.has(s.id)) continue;
    if (!shapeIntersectsPolygon(s, poly, pb, opts.fontFamily)) continue;
    out.add(s.id);
    if (s.groupId) touchedGroups.add(s.groupId);
  }
  if (touchedGroups.size > 0) {
    for (const s of shapes) {
      if (!s.groupId || !touchedGroups.has(s.groupId)) continue;
      if (s.pocketed) continue;
      if (hidden && s.layerId && hidden.has(s.layerId)) continue;
      out.add(s.id);
    }
  }
  return out;
}

/** Union bounds of a set of shapes, or null when the set is empty.
 *  Used by the selection bridge to hand the stroke engine a bbox for
 *  the non-stroke half of a mixed selection. */
export function unionBoundsOf(
  shapes: Shape[], ids: Set<string>, fontFamily?: string,
  filter?: (s: Shape) => boolean,
): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let any = false;
  for (const s of shapes) {
    if (!ids.has(s.id) || s.pocketed) continue;
    if (filter && !filter(s)) continue;
    const b = getShapeBounds(s, fontFamily);
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
    any = true;
  }
  return any ? { minX, minY, maxX, maxY } : null;
}
