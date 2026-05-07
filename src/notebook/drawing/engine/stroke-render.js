/* ============================================================
 * stroke-render.js (stamped) — stamping + tile-indexed rebake.
 *
 * stampStream is the hot per-stamp loop. createRenderer returns the
 * renderStroke binding plus the tile index (addToIndex/removeFromIndex/
 * rebakeTiles/repaintAll/fullRebake/tilesForStrokes) for managing the
 * done canvas's dirty regions.
 * ============================================================ */

import {
  TILE_SIZE,
  computeBBox,
  tileKeysForBBox,
  getStrokePoints,
  stampAngle,
} from './stroke-geometry.js';
import { BRUSH_DEFS, getModeComposite } from './stroke-atlas.js';

const { max, hypot } = Math;

// Stamps a streamlined point list into ctx using the tinted brush atlas.
// Each stamp is one drawImage call with a source rect picking a variant
// from the atlas. The stamp is rotated to a stable pseudo-random angle
// derived from its index within the stroke, so adjacent stamps don't
// mirror each other and the same stroke re-bakes identically frame to
// frame. Angle is deterministic per stamp-index so live drawing doesn't
// jitter as the stroke extends.
//
// A transform fn (x, y) -> [x, y] is optional and applied to each
// streamlined point — used by the preview pipeline to scale/translate
// without mutating stroke.points until commit.
export function stampStream(ctx, streamPts, size, tinted, spacingFrac, xform) {
  if (!streamPts.length) return;
  const { atlas, cell, variants } = tinted;
  const halfSize = size * 0.5;
  const spacing = max(0.6, size * spacingFrac);
  let stampIndex = 0;
  if (streamPts.length === 1) {
    const p = streamPts[0];
    const [x, y] = xform ? xform(p.point[0], p.point[1]) : p.point;
    const r = halfSize * (0.6 + 0.4 * p.pressure);
    const sx = (stampIndex % variants) * cell;
    const ang = stampAngle(stampIndex);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.drawImage(atlas, sx, 0, cell, cell, -r, -r, r * 2, r * 2);
    ctx.restore();
    return;
  }
  let carry = 0;
  for (let i = 1; i < streamPts.length; i++) {
    const a = streamPts[i - 1];
    const b = streamPts[i];
    const ax0 = a.point[0], ay0 = a.point[1];
    const bx0 = b.point[0], by0 = b.point[1];
    const [ax, ay] = xform ? xform(ax0, ay0) : [ax0, ay0];
    const [bx, by] = xform ? xform(bx0, by0) : [bx0, by0];
    const dx = bx - ax, dy = by - ay;
    const segLen = hypot(dx, dy);
    if (segLen === 0) continue;
    const ux = dx / segLen, uy = dy / segLen;
    let d = carry;
    while (d < segLen) {
      const t = d / segLen;
      const pressure = a.pressure + (b.pressure - a.pressure) * t;
      const r = halfSize * (0.6 + 0.4 * pressure);
      const cx = ax + ux * d;
      const cy = ay + uy * d;
      const v = stampIndex % variants;
      const ang = stampAngle(stampIndex);
      stampIndex++;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ang);
      ctx.drawImage(atlas, v * cell, 0, cell, cell, -r, -r, r * 2, r * 2);
      ctx.restore();
      d += spacing;
    }
    carry = d - segLen;
  }
}

export function createRenderer({ doneCtx, clearCtx, getStrokes, getTintedAtlas, options, isVisible }) {
  const visible = isVisible || (() => true);

  // Scratch canvas used by the flatten path (highlighter-family brushes).
  // A single canvas is shared across all target contexts — done/preview/live
  // are the same pixel size + DPR — and is lazily resized/re-transformed to
  // match the target on each use. Only the current stroke's bbox is cleared
  // and blitted, so leftover pixels elsewhere in scratch are harmless.
  let scratchCanvas = null;
  let scratchCtx = null;
  function ensureScratch(targetCtx) {
    const tc = targetCtx.canvas;
    if (!scratchCanvas) {
      scratchCanvas = document.createElement('canvas');
      scratchCtx = scratchCanvas.getContext('2d');
    }
    if (scratchCanvas.width !== tc.width || scratchCanvas.height !== tc.height) {
      scratchCanvas.width = tc.width;
      scratchCanvas.height = tc.height;
    }
    const t = targetCtx.getTransform();
    scratchCtx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
    return scratchCtx;
  }

  // Flatten path: stamp the stroke into scratch at normal composite / full
  // opacity so self-overlap does not compound, then blit the stroke's bbox
  // onto the target with the mode's composite op + stroke alpha. This is
  // what gives a highlighter its even density inside the stroke and its
  // multiply-over-ink interaction outside.
  function renderStrokeFlat(ctx, stroke, streamPts, tinted, xform, composite, strokeAlpha) {
    if (!streamPts.length) return;
    const sCtx = ensureScratch(ctx);
    const pad = stroke.size + 2;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < streamPts.length; i++) {
      const p = streamPts[i].point;
      const [x, y] = xform ? xform(p[0], p[1]) : p;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const rx = minX - pad, ry = minY - pad;
    const rw = (maxX - minX) + 2 * pad, rh = (maxY - minY) + 2 * pad;

    sCtx.save();
    sCtx.globalCompositeOperation = 'source-over';
    sCtx.globalAlpha = 1;
    sCtx.clearRect(rx, ry, rw, rh);
    stampStream(sCtx, streamPts, stroke.size, tinted, options.spacing, xform);
    sCtx.restore();

    // drawImage source rect is in scratch raw pixels; dest rect is in CSS
    // px (the target ctx's DPR transform is active).
    const t = ctx.getTransform();
    const dpr = t.a;
    ctx.save();
    ctx.globalCompositeOperation = composite;
    ctx.globalAlpha = strokeAlpha;
    ctx.drawImage(
      scratchCanvas,
      rx * dpr, ry * dpr, rw * dpr, rh * dpr,
      rx, ry, rw, rh,
    );
    ctx.restore();
  }

  function renderStroke(ctx, stroke, xform) {
    const streamPts = getStrokePoints(stroke.points, options.streamline);
    const brushId = stroke.brush || BRUSH_DEFS[0].id;
    const tinted = getTintedAtlas(brushId, stroke.color);
    const { composite, strokeAlpha } = getModeComposite(stroke.mode || 'normal');
    if (composite === 'source-over' && strokeAlpha === 1) {
      stampStream(ctx, streamPts, stroke.size, tinted, options.spacing, xform);
    } else {
      renderStrokeFlat(ctx, stroke, streamPts, tinted, xform, composite, strokeAlpha);
    }
  }

  const tileIndex = new Map();

  function addToIndex(stroke) {
    stroke.bbox = computeBBox(stroke);
    stroke.tiles = tileKeysForBBox(stroke.bbox);
    for (const key of stroke.tiles) {
      let set = tileIndex.get(key);
      if (!set) { set = new Set(); tileIndex.set(key, set); }
      set.add(stroke.id);
    }
  }

  function removeFromIndex(stroke) {
    if (!stroke.tiles) return;
    for (const key of stroke.tiles) {
      const set = tileIndex.get(key);
      if (set) {
        set.delete(stroke.id);
        if (set.size === 0) tileIndex.delete(key);
      }
    }
    stroke.tiles = null;
    stroke.bbox = null;
  }

  function rebuildIndex() {
    tileIndex.clear();
    for (const s of getStrokes()) addToIndex(s);
  }

  // Rebake a collection of tile keys on the done canvas. Each tile's rect is
  // cleared, then the union of those rects acts as a clip so strokes spanning
  // the tile boundary don't spill over onto clean areas. Returns nothing.
  function rebakeTiles(tileKeys, excludeIds) {
    if (!tileKeys) return;
    const uniq = tileKeys instanceof Set ? tileKeys : new Set(tileKeys);
    if (uniq.size === 0) return;
    doneCtx.save();
    // Build clip region from tile rects.
    doneCtx.beginPath();
    for (const key of uniq) {
      const comma = key.indexOf(',');
      const tx = +key.slice(0, comma);
      const ty = +key.slice(comma + 1);
      doneCtx.rect(tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
    doneCtx.clip();
    for (const key of uniq) {
      const comma = key.indexOf(',');
      const tx = +key.slice(0, comma);
      const ty = +key.slice(comma + 1);
      doneCtx.clearRect(tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
    // Collect the set of strokes that touch any of the dirty tiles. Walk the
    // canonical strokes array in order so z-ordering is preserved.
    const touched = new Set();
    for (const key of uniq) {
      const set = tileIndex.get(key);
      if (!set) continue;
      for (const id of set) touched.add(id);
    }
    for (const s of getStrokes()) {
      if (!touched.has(s.id)) continue;
      if (excludeIds && excludeIds.has(s.id)) continue;
      if (!visible(s)) continue;
      renderStroke(doneCtx, s);
    }
    doneCtx.restore();
  }

  // Paint every stroke into doneCtx from scratch. Does not touch the index;
  // used by texture-slider changes where the stroke geometry is unchanged but
  // every brush bitmap has been invalidated.
  //
  // Off-canvas strokes are skipped via a bbox-vs-canvas-rect cull. The host
  // re-anchors the canvas to follow the camera, so on a notebook with
  // hundreds of strokes spread across a wide world the cull can drop most
  // of them per rebake — turning a worst-case linear scan over N stamps
  // into work proportional to the visible footprint. Strokes without a
  // computed bbox (newly inserted, pre-index) fall back to the unconditional
  // path so we don't silently drop them.
  function repaintAll() {
    clearCtx(doneCtx);
    const t = doneCtx.getTransform();
    const dpr = t.a || 1;
    const rectW = doneCtx.canvas.width / dpr;
    const rectH = doneCtx.canvas.height / dpr;
    for (const s of getStrokes()) {
      if (!visible(s)) continue;
      const b = s.bbox;
      if (b && (b.maxX < 0 || b.maxY < 0 || b.minX > rectW || b.minY > rectH)) continue;
      renderStroke(doneCtx, s);
    }
  }

  // Rebuild the index from the canonical stroke list and repaint. Used for
  // resize and clear, and for recovering state after a full mutation.
  function fullRebake() {
    rebuildIndex();
    repaintAll();
  }

  // Collect the union of tile keys for an iterable of strokes.
  function tilesForStrokes(strokes) {
    const out = new Set();
    for (const s of strokes) {
      if (!s.tiles) continue;
      for (const k of s.tiles) out.add(k);
    }
    return out;
  }

  function clearIndex() { tileIndex.clear(); }

  return {
    renderStroke,
    addToIndex,
    removeFromIndex,
    rebuildIndex,
    rebakeTiles,
    repaintAll,
    fullRebake,
    tilesForStrokes,
    clearIndex,
  };
}
