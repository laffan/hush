// Flowchart edge geometry — where an arrow leaves its parent, where it
// enters its child, and the cubic bezier between them. Split out of
// flowchart.ts (700-line cap); pure functions, no layer state.
//
// `edgeGeometry` picks the anchor pair by connect mode. `offsetGeometry`
// then slides an endpoint along the edge it sits on, which is how the
// layer separates arrows that would otherwise stack on top of each other
// at the same box side.

import type { FlowBounds, FlowConnectMode } from "./flowchart";

export interface Pt {
  x: number;
  y: number;
}

export interface EdgeGeometry {
  p0: Pt;
  cp1: Pt;
  cp2: Pt;
  /** End of the line — base of the arrowhead. */
  p3: Pt;
  /** Tip of the arrowhead — touches the child shape's edge. */
  tip: Pt;
  /** Legacy hint kept for renderers that assume horizontal arrows.
   *  +1 if child is to the right/below parent, -1 if to the left/above. */
  sign: number;
  /** Unit vector perpendicular to the arrow direction at the tip — used to
   *  splay the arrowhead base. For a horizontal arrow this is (0, ±1); for
   *  a vertical arrow (±1, 0). */
  perpX: number;
  perpY: number;
}


export function bezier(g: EdgeGeometry, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * g.p0.x + b * g.cp1.x + c * g.cp2.x + d * g.p3.x,
    y: a * g.p0.y + b * g.cp1.y + c * g.cp2.y + d * g.p3.y,
  };
}

export function pointToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function geometryHorizontal(ab: FlowBounds, bb: FlowBounds, arrowHeadSize: number): EdgeGeometry {
  // Pick the side of each box closer to the other so the arrow looks sane
  // even if the user drags the child to the parent's left/below.
  const childOnRight = (bb.minX + bb.maxX) / 2 >= (ab.minX + ab.maxX) / 2;
  const sx = childOnRight ? ab.maxX : ab.minX;
  const sy = (ab.minY + ab.maxY) / 2;
  const sign = childOnRight ? 1 : -1;
  // Visual breathing room: tip stops 10px shy of the child's edge.
  const TIP_GAP = 10;
  const tipX = childOnRight ? bb.minX - TIP_GAP : bb.maxX + TIP_GAP;
  const tipY = (bb.minY + bb.maxY) / 2;
  // Back the line off by `ah` more so it terminates at the BASE of the
  // arrowhead (rather than the tip). Tangent at t=1 is horizontal by
  // construction.
  const ah = arrowHeadSize;
  const ex = tipX - sign * ah;
  const ey = tipY;
  const dx = Math.max(40, Math.abs(ex - sx) * 0.5);
  const cp1x = sx + sign * dx;
  const cp2x = ex - sign * dx;
  return {
    p0: { x: sx, y: sy },
    cp1: { x: cp1x, y: sy },
    cp2: { x: cp2x, y: ey },
    p3: { x: ex, y: ey },
    tip: { x: tipX, y: tipY },
    sign,
    perpX: 0,
    perpY: sign,
  };
}

function geometryClosest(ab: FlowBounds, bb: FlowBounds, arrowHeadSize: number): EdgeGeometry {
  const acx = (ab.minX + ab.maxX) / 2;
  const acy = (ab.minY + ab.maxY) / 2;
  const bcx = (bb.minX + bb.maxX) / 2;
  const bcy = (bb.minY + bb.maxY) / 2;

  // Signed gap between facing edges along each axis. Positive = clear
  // separation, negative = overlap on that axis. The axis with the larger
  // gap is the one with clearer separation, so route the arrow that way.
  const horizGap = bcx >= acx ? bb.minX - ab.maxX : ab.minX - bb.maxX;
  const vertGap = bcy >= acy ? bb.minY - ab.maxY : ab.minY - bb.maxY;

  let dirX = 0, dirY = 0;
  let sx: number, sy: number, cx: number, cy: number;
  if (horizGap >= vertGap) {
    // Connect right↔left (or left↔right) — anchor at the vertical midpoint
    // of each edge so the line is fixed to the centre of the side rather
    // than sliding along it as the other box moves.
    if (bcx >= acx) {
      sx = ab.maxX; cx = bb.minX; dirX = 1;
    } else {
      sx = ab.minX; cx = bb.maxX; dirX = -1;
    }
    sy = acy;
    cy = bcy;
  } else {
    // Connect bottom↔top (or top↔bottom) — anchor at the horizontal
    // midpoint of each edge.
    if (bcy >= acy) {
      sy = ab.maxY; cy = bb.minY; dirY = 1;
    } else {
      sy = ab.minY; cy = bb.maxY; dirY = -1;
    }
    sx = acx;
    cx = bcx;
  }

  const TIP_GAP = 10;
  const tipX = cx - dirX * TIP_GAP;
  const tipY = cy - dirY * TIP_GAP;

  const ah = arrowHeadSize;
  const ex = tipX - dirX * ah;
  const ey = tipY - dirY * ah;

  // Pull bezier control points along the arrow direction from each end so
  // the curve leaves and arrives perpendicular to the edges it touches.
  const span = Math.max(40, (Math.abs(ex - sx) + Math.abs(ey - sy)) * 0.5);
  const cp1x = sx + dirX * span;
  const cp1y = sy + dirY * span;
  const cp2x = ex - dirX * span;
  const cp2y = ey - dirY * span;

  // Perpendicular unit vector — used to splay the arrowhead base.
  const perpX = -dirY;
  const perpY = dirX;
  // `sign` is retained for legacy renderers that assume horizontal arrows.
  // Picks something sensible for vertical arrows but new code should use
  // perpX/perpY directly.
  const sign = dirX !== 0 ? dirX : dirY;

  return {
    p0: { x: sx, y: sy },
    cp1: { x: cp1x, y: cp1y },
    cp2: { x: cp2x, y: cp2y },
    p3: { x: ex, y: ey },
    tip: { x: tipX, y: tipY },
    sign,
    perpX,
    perpY,
  };
}

/** Which side of the *source* box the arrow leaves from. The geometry's
 *  perpendicular is the arrow direction rotated a quarter turn, so the
 *  direction reads straight back off it. */
export function exitSide(g: EdgeGeometry): "right" | "left" | "down" | "up" {
  const dirX = g.perpY, dirY = -g.perpX;
  if (dirX > 0) return "right";
  if (dirX < 0) return "left";
  return dirY > 0 ? "down" : "up";
}

/** The side of the *target* box the same arrow enters. */
export function oppositeSide(side: string): "right" | "left" | "down" | "up" {
  return side === "right" ? "left" : side === "left" ? "right"
    : side === "down" ? "up" : "down";
}

/** The axis arrows slide along to clear each other on a given side —
 *  vertical for a left/right side, horizontal for a top/bottom one. */
export function sideAxis(side: string): Pt {
  return (side === "left" || side === "right") ? { x: 0, y: 1 } : { x: 1, y: 0 };
}

/** Shift an arrow's two ends independently along their own box edges.
 *  Control points move with the end they belong to, so the curve stays
 *  smooth and still leaves / arrives perpendicular. */
export function offsetGeometry(g: EdgeGeometry, s: Pt, e: Pt): EdgeGeometry {
  if (!s.x && !s.y && !e.x && !e.y) return g;
  const mv = (p: Pt, d: Pt) => ({ x: p.x + d.x, y: p.y + d.y });
  return {
    ...g,
    p0: mv(g.p0, s), cp1: mv(g.cp1, s),
    cp2: mv(g.cp2, e), p3: mv(g.p3, e), tip: mv(g.tip, e),
  };
}

/** Anchor pair + bezier for one edge, by connect mode. */
export function edgeGeometry(
  ab: FlowBounds, bb: FlowBounds, mode: FlowConnectMode, arrowHeadSize: number,
): EdgeGeometry {
  return mode === "closest"
    ? geometryClosest(ab, bb, arrowHeadSize)
    : geometryHorizontal(ab, bb, arrowHeadSize);
}
