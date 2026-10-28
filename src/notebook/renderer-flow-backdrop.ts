/**
 * Arrows under text.
 *
 * Flowchart arrows paint beneath the text shapes (`renderer.ts` draws
 * them between the drag-area pass and the shape pass), but a text shape
 * has no fill of its own, so an arrow that crossed one ran straight
 * through its words. A text shape an arrow passes over now gets a
 * backdrop in the canvas's own background colour, not quite opaque, so
 * the line fades out under the words rather than obstructing them — and
 * so does every node of a chart, so a chart's boxes read alike whether
 * or not a line happens to cross a given one.
 *
 * Text only: an image is opaque already, a drag area is a container an
 * arrow is meant to be seen inside, an outline has its own frame, and a
 * text shape with a background colour of its own keeps it.
 *
 * Pure — no DOM, no global state — like the rest of the renderer.
 */

import type { Bounds, Shape, TextShape } from "./types";
import { getShapeBounds } from "./utils";
import type { FlowchartLayer } from "./flowchart";

/** How much of the canvas colour the backdrop lays over an arrow. High
 *  enough that the line is plainly behind the words, low enough that it
 *  still reads as one line running under them. */
const BACKDROP_ALPHA = 0.85;
/** Around the glyphs' own box, in world px. Small: an arrow starts right
 *  at its parent's edge, and a wide pad would eat the start of it. */
const BACKDROP_PAD = 3;
const BACKDROP_RADIUS = 4;
/** A chart node's outlined box sits this far out from its text — and
 *  its arrows end at the box (state.ts pads the node's anchor bounds by
 *  the same, `flowNodePad`). */
export const NODE_PAD = 5;
const NODE_RADIUS = 5;

/** How far a shape's flowchart anchor sits outside its own bounds: a
 *  plain text node's outlined box (`NODE_PAD`); nothing for anything
 *  else. */
export function flowNodePad(shape: Shape): number {
  if (shape.type !== "text") return 0;
  const t = shape as TextShape;
  return t.outline || t.backgroundColor ? 0 : NODE_PAD;
}
/** A chart node's backdrop also takes a hairline in the text colour at
 *  this strength, so a node reads as a box even on a canvas whose colour
 *  the backdrop matches. */
const NODE_BORDER_ALPHA = 0.22;
const NODE_BORDER_WIDTH = 1;

/** A text shape's bounds, measured once per shape object. Shapes are
 *  immutable (README-NOTEBOOK's load-bearing invariant), so an edit is a
 *  new object and a fresh measure — and the crossing test below doesn't
 *  re-run text metrics for every text shape on every frame. */
const boundsCache = new WeakMap<Shape, { ff: string; b: Bounds }>();

function boundsOf(s: Shape, fontFamily: string): Bounds {
  const hit = boundsCache.get(s);
  if (hit && hit.ff === fontFamily) return hit.b;
  const b = getShapeBounds(s, fontFamily);
  boundsCache.set(s, { ff: fontFamily, b });
  return b;
}

/** Does segment a→b pass through box `r`? (Liang–Barsky clip.) */
function segmentHitsBox(ax: number, ay: number, bx: number, by: number, r: Bounds): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, ax - r.minX) && clip(dx, r.maxX - ax)
    && clip(-dy, ay - r.minY) && clip(dy, r.maxY - ay);
}

/**
 * Ids of the text shapes that get a backdrop this frame: every node an
 * edge touches, plus any other text shape an arrow's path crosses. Empty
 * — and nearly free — on a canvas with no edges.
 */
export function flowBackdropIds(
  flowchart: FlowchartLayer<Shape> | undefined | null,
  shapes: Shape[],
  fontFamily: string,
): Set<string> {
  const ids = new Set<string>();
  if (!flowchart || flowchart.edges.length === 0) return ids;
  const paths = flowchart.edgePolylines(shapes);
  if (!paths.length) return ids;
  // The layer hands back the same polylines while the chart is
  // unchanged (a pan, a zoom, a hover), and with the same shapes the
  // answer is the same — reuse it rather than re-clipping every path
  // against every text box each frame.
  const memo = idsMemo.get(paths);
  if (memo && memo.ff === fontFamily && memo.shapes.length === shapes.length
    && memo.shapes.every((s, i) => s === shapes[i])) return memo.ids;

  const boxes = paths.map(({ edge, points }) => {
    ids.add(edge.from);
    ids.add(edge.to);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { points, minX, minY, maxX, maxY };
  });

  for (const s of shapes) {
    if (s.type !== "text" || ids.has(s.id) || s.outline || s.backgroundColor) continue;
    const b = boundsOf(s, fontFamily);
    for (const path of boxes) {
      if (path.maxX < b.minX || path.minX > b.maxX || path.maxY < b.minY || path.minY > b.maxY) continue;
      const pts = path.points;
      let crossed = false;
      for (let i = 1; i < pts.length && !crossed; i++) {
        crossed = segmentHitsBox(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, b);
      }
      if (crossed) { ids.add(s.id); break; }
    }
  }
  idsMemo.set(paths, { ff: fontFamily, shapes: shapes.slice(), ids });
  return ids;
}

const idsMemo = new WeakMap<object, { ff: string; shapes: Shape[]; ids: Set<string> }>();

/** The ids of the shapes at either end of an edge — a chart's nodes. */
export function flowNodeIds(flowchart: FlowchartLayer<Shape> | undefined | null): Set<string> {
  const ids = new Set<string>();
  for (const e of flowchart?.edges || []) { ids.add(e.from); ids.add(e.to); }
  return ids;
}

/** Lay the backdrop under one text shape, in world space — with a subtle
 *  border in `borderColor` when it is given (a chart's own nodes; text an
 *  arrow merely crosses gets the backdrop alone). */
export function drawTextBackdrop(
  ctx: CanvasRenderingContext2D,
  shape: TextShape,
  fontFamily: string,
  color: string,
  borderColor?: string | null,
): void {
  if (shape.outline || shape.backgroundColor) return;
  const b = boundsOf(shape, fontFamily);
  // An outlined chart node gets room round its words; a backdrop alone
  // stays tight, so an arrow starting at its parent isn't eaten.
  const pad = borderColor ? NODE_PAD : BACKDROP_PAD;
  ctx.save();
  ctx.beginPath();
  (ctx as any).roundRect(
    b.minX - pad, b.minY - pad,
    b.maxX - b.minX + pad * 2, b.maxY - b.minY + pad * 2,
    borderColor ? NODE_RADIUS : BACKDROP_RADIUS,
  );
  const alpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha * BACKDROP_ALPHA;
  ctx.fillStyle = color;
  ctx.fill();
  if (borderColor) {
    ctx.globalAlpha = alpha * NODE_BORDER_ALPHA;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = NODE_BORDER_WIDTH;
    ctx.stroke();
  }
  ctx.restore();
}
