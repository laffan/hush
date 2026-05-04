/* ============================================================
 * stroke-geometry.js (stamped) — pure geometry helpers.
 *
 * Streamline, stamp-angle hash, bbox/tile math, segment-circle roots,
 * stroke slicing, and preview-transform descriptor. No DOM, no state,
 * no canvas — just math. Imported by the renderer, the erase controller,
 * and the main engine.
 * ============================================================ */

const { hypot } = Math;

// --------- vector helpers (trimmed — only what streamline + stamping need) ---------
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const lrp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const uni = (a) => {
  const l = hypot(a[0], a[1]) || 1;
  return [a[0] / l, a[1] / l];
};

// --------- perfect-freehand: streamline (unchanged from pure-svg) ---------
export function getStrokePoints(rawPts, streamline) {
  if (!rawPts.length) return [];
  const t = 0.15 + (1 - streamline) * 0.85;
  const out = [];
  let pp = [rawPts[0].x, rawPts[0].y];
  out.push({ point: pp, pressure: rawPts[0].pressure });
  for (let i = 1; i < rawPts.length; i++) {
    const raw = [rawPts[i].x, rawPts[i].y];
    const np = i === rawPts.length - 1 ? raw : lrp(pp, raw, t);
    if (np[0] === pp[0] && np[1] === pp[1]) continue;
    out.push({ point: np, pressure: rawPts[i].pressure });
    pp = np;
  }
  return out;
}

// Stable hash → [0, 2π). Same math as mulberry32 seeded by the stamp
// index; avoids the allocation of a PRNG object per stroke. Used to give
// each stamp a deterministic rotation so adjacent stamps don't mirror each
// other and the same stroke re-bakes identically frame to frame.
export function stampAngle(i) {
  let h = (i * 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296 * Math.PI * 2;
}

// --------- tiling ---------
// The done canvas is partitioned into TILE_SIZE×TILE_SIZE regions in CSS
// space. Each stroke caches its bbox + the list of tile keys it intersects;
// tileIndex maps tileKey → Set<strokeId> so an edit can be resolved by
// clearing a handful of tile rects and redrawing only the strokes that
// actually touch them. This keeps edit cost proportional to the footprint
// of the affected strokes rather than the total stroke count.
export const TILE_SIZE = 512;

export function computeBBox(stroke) {
  const pts = stroke.points;
  if (!pts.length) return null;
  let minX = pts[0].x, minY = pts[0].y, maxX = pts[0].x, maxY = pts[0].y;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  // Max stamp radius is halfSize * 1.0 (pressure = 1). Pad by size to be
  // safe against sub-pixel smearing from the streamline bump at corners.
  const pad = stroke.size + 1;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

export function tileKeysForBBox(bbox) {
  if (!bbox) return [];
  const x0 = Math.floor(bbox.minX / TILE_SIZE);
  const x1 = Math.floor(bbox.maxX / TILE_SIZE);
  const y0 = Math.floor(bbox.minY / TILE_SIZE);
  const y1 = Math.floor(bbox.maxY / TILE_SIZE);
  const out = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      out.push(`${tx},${ty}`);
    }
  }
  return out;
}

// --------- segment/disc math (eraser) ---------
export function pointToSegmentDist2(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const vv = vx * vx + vy * vy;
  if (vv === 0) return wx * wx + wy * wy;
  let t = (wx * vx + wy * vy) / vv;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = ax + vx * t, cy = ay + vy * t;
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy;
}

// Roots in (0,1) of the segment a→b crossing a circle of radius r at
// (cx,cy). Returns 0, 1, or 2 t-values, ascending.
export function segmentCircleRoots(a, b, cx, cy, r) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const ex = a.x - cx, ey = a.y - cy;
  const A = dx * dx + dy * dy;
  if (A === 0) return [];
  const B = 2 * (ex * dx + ey * dy);
  const C = ex * ex + ey * ey - r * r;
  const D = B * B - 4 * A * C;
  if (D <= 0) return [];
  const sqrtD = Math.sqrt(D);
  const t1 = (-B - sqrtD) / (2 * A);
  const t2 = (-B + sqrtD) / (2 * A);
  const out = [];
  if (t1 > 0 && t1 < 1) out.push(t1);
  if (t2 > 0 && t2 < 1 && t2 !== t1) out.push(t2);
  return out;
}

export function lerpPoint(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    pressure: a.pressure + (b.pressure - a.pressure) * t,
  };
}

// Cheap bbox-vs-disc filter so the slice walk skips strokes we know don't
// overlap the eraser. Pads the bbox by the eraser radius.
export function bboxIntersectsDisc(bbox, cx, cy, r) {
  if (!bbox) return false;
  return cx >= bbox.minX - r && cx <= bbox.maxX + r &&
         cy >= bbox.minY - r && cy <= bbox.maxY + r;
}

// Returns null if the eraser doesn't touch this stroke; otherwise an
// array of point arrays — one per surviving sub-stroke. An empty array
// means the stroke is fully erased.
export function sliceStrokePoints(stroke, cx, cy, eraserR) {
  const hitR = eraserR + stroke.size / 2;
  const hit2 = hitR * hitR;
  const pts = stroke.points;

  if (pts.length === 1) {
    const dx = pts[0].x - cx, dy = pts[0].y - cy;
    return (dx * dx + dy * dy < hit2) ? [] : null;
  }

  // Per-point inside flag; also detect touched=true by either an inside
  // point or a segment that passes through the disc with both endpoints out.
  const isInside = new Array(pts.length);
  let touched = false;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i].x - cx, dy = pts[i].y - cy;
    isInside[i] = (dx * dx + dy * dy) < hit2;
    if (isInside[i]) touched = true;
  }
  if (!touched) {
    for (let i = 1; i < pts.length; i++) {
      if (pointToSegmentDist2(cx, cy, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) < hit2) {
        touched = true;
        break;
      }
    }
    if (!touched) return null;
  }

  const subs = [];
  let cur = isInside[0] ? null : [pts[0]];

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const aIn = isInside[i - 1];
    const bIn = isInside[i];

    if (aIn && bIn) {
      // Wholly inside the disc — nothing to emit.
      continue;
    }

    if (!aIn && !bIn) {
      const ts = segmentCircleRoots(a, b, cx, cy, hitR);
      if (ts.length === 2) {
        // Segment dips into the disc and exits. Close cur at the entry
        // point; start a new cur at the exit point.
        if (cur) {
          cur.push(lerpPoint(a, b, ts[0]));
          if (cur.length > 1) subs.push(cur);
        }
        cur = [lerpPoint(a, b, ts[1]), b];
      } else {
        // Segment is wholly outside (or numerically tangent); just append.
        if (cur) cur.push(b); else cur = [a, b];
      }
      continue;
    }

    if (!aIn && bIn) {
      // Crossing into the disc — close current sub at the boundary.
      const ts = segmentCircleRoots(a, b, cx, cy, hitR);
      const enterT = ts.length ? ts[0] : 1;
      if (cur) {
        cur.push(lerpPoint(a, b, enterT));
        if (cur.length > 1) subs.push(cur);
      }
      cur = null;
      continue;
    }

    // aIn && !bIn — emerging from the disc. Start a new sub at the exit.
    const ts = segmentCircleRoots(a, b, cx, cy, hitR);
    const exitT = ts.length ? ts[ts.length - 1] : 0;
    cur = [lerpPoint(a, b, exitT), b];
  }

  if (cur && cur.length > 1) subs.push(cur);
  return subs;
}

// --------- preview transform descriptor ---------
export function setsEqual(a, b) {
  if (!a || !b) return false;
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function xformFromDescriptor(t) {
  if (t.kind === 'move') {
    const { dx, dy } = t;
    return (x, y) => [x + dx, y + dy];
  }
  if (t.kind === 'scale') {
    const { sx, sy, ax, ay } = t;
    return (x, y) => [ax + (x - ax) * sx, ay + (y - ay) * sy];
  }
  if (t.kind === 'rotate') {
    const { angle, ax, ay } = t;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return (x, y) => {
      const dx = x - ax, dy = y - ay;
      return [ax + dx * cos - dy * sin, ay + dx * sin + dy * cos];
    };
  }
  return null;
}
