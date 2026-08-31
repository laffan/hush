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

export function createRenderer({ doneCtx, hlCtx, clearCtx, getStrokes, getTintedAtlas, options, isVisible, isActive, blitCanvas, hlBlitCanvas, onHighlightBacking }) {
  const visible = isVisible || (() => true);
  const activeFn = isActive || (() => false);

  // Hush delta #38: TWO bake targets. `multiply` inside a canvas can only
  // see ink already on that canvas — which is why the highlighter's own
  // composite (see STROKE_MODES) gives it an even density and a proper
  // multiply against other strokes, and nothing at all against a
  // proofread page, because the page is an ImageShape on the notebook's
  // canvas one DOM layer down. Highlighter strokes therefore bake into
  // their own canvas, which the host blends `multiply` against that page
  // (see drawing-layer-dom.ts). Everything else about them is unchanged:
  // same tile index, same z-order within the stroke list, same erase and
  // selection paths.
  //
  // The highlight target stays UNBACKED until a highlighter stroke
  // actually exists (`onHighlightBacking` asks the host to size the
  // pair), so a notebook that never reaches for the tool pays neither
  // the two world-sized backings nor a second clear/repaint per rebake.
  const done = { ctx: doneCtx, spare: blitCanvas ? blitCanvas.getContext('2d') : null };
  const hl = hlCtx
    ? { ctx: hlCtx, spare: hlBlitCanvas ? hlBlitCanvas.getContext('2d') : null }
    : null;
  let hlBacked = false;

  function isHighlightStroke(s) { return (s.mode || 'normal') === 'highlighter'; }
  function targetFor(s) { return (hl && isHighlightStroke(s)) ? hl : done; }
  // Cached so the per-rebake path (an erase drag calls it per pointer
  // move) doesn't allocate an array a frame.
  const DONE_ONLY = [done];
  const BOTH = hl ? [done, hl] : DONE_ONLY;
  /** Targets that currently hold (or may hold) pixels. */
  function bakeTargets() { return (hl && hlBacked) ? BOTH : DONE_ONLY; }
  /** First highlighter stroke wins the backing, permanently. */
  function ensureHighlightBacking() {
    if (!hl || hlBacked) return;
    hlBacked = true;
    if (onHighlightBacking) onHighlightBacking();
  }
  /** O(N) only while the highlight target is still unbacked — one pass
   *  of property reads, and it stops running the moment it succeeds. */
  function scanForHighlight() {
    if (!hl || hlBacked) return;
    for (const s of getStrokes()) {
      if (isHighlightStroke(s)) { ensureHighlightBacking(); return; }
    }
  }

  // Hush delta #26: per-stroke streamline cache. getStrokePoints used to
  // be recomputed from scratch on EVERY render of every stroke — on a
  // full rebake of a dense notebook that pass alone costs milliseconds
  // and allocates two objects per point (GC pressure, worst on iPad
  // JSC). Geometry mutations replace the points array (setStrokePoints,
  // commitTransform, slice), so caching on points-array identity + the
  // streamline value in effect is sound. Two traps, both handled:
  //   - the ACTIVE stroke's points array grows / mutates in place while
  //     its identity stays stable — never cache it (`isActive`);
  //   - translateAllStrokePoints shifts raw points in place (identity
  //     unchanged); it shifts the cached streamline points alongside
  //     (streamlining is translation-invariant) so the cache stays warm
  //     across re-anchors.
  // `_streamCache` lives only on engine-private strokes — the sync shim
  // builds fresh objects at both boundaries, so it can never leak into
  // DrawShapes or serialization.
  function streamPtsFor(stroke) {
    if (activeFn(stroke)) return getStrokePoints(stroke.points, options.streamline);
    const c = stroke._streamCache;
    if (c && c.pointsRef === stroke.points && c.streamline === options.streamline) return c.pts;
    const pts = getStrokePoints(stroke.points, options.streamline);
    stroke._streamCache = { pts, pointsRef: stroke.points, streamline: options.streamline };
    return pts;
  }

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
    const streamPts = streamPtsFor(stroke);
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
    scanForHighlight();
    // Collect the set of strokes that touch any of the dirty tiles. Walk the
    // canonical strokes array in order so z-ordering is preserved.
    const touched = new Set();
    for (const key of uniq) {
      const set = tileIndex.get(key);
      if (!set) continue;
      for (const id of set) touched.add(id);
    }
    for (const t of bakeTargets()) {
      const ctx = t.ctx;
      ctx.save();
      // Build clip region from tile rects.
      ctx.beginPath();
      for (const key of uniq) {
        const comma = key.indexOf(',');
        const tx = +key.slice(0, comma);
        const ty = +key.slice(comma + 1);
        ctx.rect(tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
      ctx.clip();
      for (const key of uniq) {
        const comma = key.indexOf(',');
        const tx = +key.slice(0, comma);
        const ty = +key.slice(comma + 1);
        ctx.clearRect(tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
      for (const s of getStrokes()) {
        if (!touched.has(s.id)) continue;
        if (excludeIds && excludeIds.has(s.id)) continue;
        if (!visible(s)) continue;
        if (targetFor(s) !== t) continue;
        renderStroke(ctx, s);
      }
      ctx.restore();
    }
  }

  // Paint every stroke into its bake target from scratch. Does not touch
  // the index;
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
    scanForHighlight();
    for (const t of bakeTargets()) repaintTarget(t);
  }

  function repaintTarget(t) {
    // Delta #31 extension: full repaints also go through the spare.
    // Painting every stroke into the VISIBLE canvas fully dirties it —
    // the ~235 ms commit upload — so resize re-anchors (zoom
    // crossings), theme retints, and bulk loads paint into the
    // near-invisible spare and swap roles instead, same as the shift.
    let target = t.ctx;
    if (t.spare) {
      const spare = t.spare.canvas;
      const current = t.ctx.canvas;
      if (spare.width !== current.width) spare.width = current.width;
      if (spare.height !== current.height) spare.height = current.height;
      t.spare.setTransform(t.ctx.getTransform());
      t.spare.imageSmoothingEnabled = true;
      target = t.spare;
    }
    clearCtx(target);
    const tr = target.getTransform();
    const dpr = tr.a || 1;
    const rectW = target.canvas.width / dpr;
    const rectH = target.canvas.height / dpr;
    for (const s of getStrokes()) {
      if (!visible(s)) continue;
      if (targetFor(s) !== t) continue;
      const b = s.bbox;
      if (b && (b.maxX < 0 || b.maxY < 0 || b.minX > rectW || b.minY > rectH)) continue;
      renderStroke(target, s);
    }
    if (target === t.spare) swapRoles(t);
  }

  // Delta #31: swap the done/spare roles — opacity + class flips and a
  // ctx rebind, all compositor-cheap. The caller has already painted
  // the frame-to-display into the spare. Class names follow the role so
  // external queries (perf HUD, tooling) keep resolving; the DPR
  // transform + smoothing carry over to the new target.
  function swapRoles(t) {
    const spare = t.spare.canvas;
    const current = t.ctx.canvas;
    spare.style.opacity = '1';
    current.style.opacity = '0.01';
    const cls = spare.className;
    spare.className = current.className;
    current.className = cls;
    const carried = t.ctx.getTransform();
    const tmp = t.ctx;
    t.ctx = t.spare;
    t.spare = tmp;
    t.ctx.setTransform(carried);
    t.ctx.imageSmoothingEnabled = true;
  }

  // Rebuild the index from the canonical stroke list and repaint. Used for
  // resize and clear, and for recovering state after a full mutation.
  function fullRebake() {
    rebuildIndex();
    repaintAll();
  }

  // Hush delta #25 (support): clear + repaint exact CSS-px rects on the
  // done canvas. Like rebakeTiles, but takes literal rects instead of
  // tile keys — the re-anchor's exposed edge strips are typically a
  // 200-400 px band, and snapping that outward to 512-px tile
  // granularity re-stamps up to three quarters of the backing (an
  // L-shaped two-axis strip can touch 12 of 16 tiles), which would eat
  // most of the blit's win. The strip edges land on device-pixel
  // boundaries (the re-anchor delta is snapped to the device grid), so
  // the clip seam against blitted pixels is exact. Strokes are matched
  // by bbox intersection and painted in canonical order under a clip
  // of the rect union, so z-order and spill containment match
  // rebakeTiles semantics.
  function rebakeRects(rects) {
    if (!rects || !rects.length) return;
    scanForHighlight();
    for (const t of bakeTargets()) {
      const ctx = t.ctx;
      ctx.save();
      ctx.beginPath();
      for (const r of rects) {
        ctx.rect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
      }
      ctx.clip();
      for (const r of rects) {
        ctx.clearRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
      }
      for (const s of getStrokes()) {
        if (!visible(s)) continue;
        if (targetFor(s) !== t) continue;
        const b = s.bbox;
        if (!b) { renderStroke(ctx, s); continue; }
        let hit = false;
        for (const r of rects) {
          if (b.minX <= r.maxX && b.maxX >= r.minX && b.minY <= r.maxY && b.maxY >= r.minY) {
            hit = true;
            break;
          }
        }
        if (hit) renderStroke(ctx, s);
      }
      ctx.restore();
    }
  }

  // Hush delta #25 (support): slide the done canvas's pixels by (dx, dy)
  // CSS px. Used by the blit-forward re-anchor — on a same-size re-anchor
  // the old backing already holds almost everything the new one needs, so
  // the pixels are copied across and only the newly exposed edge strips
  // get repainted.
  //
  // Hush delta #31 (preferred path): SWAP double buffer. On-device
  // measurement pinned the irreducible re-anchor cost to WebKit
  // uploading the full dirty region of a VISIBLE canvas at commit
  // (~235 ms for 4096² at ~280 MB/s) — writes to the ~1%-opacity
  // helper are upload-free, small dirty rects are cheap, and no JS-
  // side variant escapes the full-surface upload while a single
  // visible canvas must slide. So: draw the SHIFTED frame into the
  // near-invisible spare with one cross-canvas 'copy' (no upload, no
  // self-snapshot), then swap the two canvases' roles — opacity +
  // class flips and the ctx rebind are compositor-cheap and land in
  // the same commit as the wrapper-transform change. The visible
  // canvas is never fully dirtied. A target's `ctx` is a mutable
  // field: every other renderer function reads the current target
  // through it automatically.
  //
  // Fallbacks when no attached helper exists: self-drawImage under
  // 'copy' (spec snapshots the source; verified once at runtime on a
  // tiny canvas), else the detached-scratch round trip. The caller
  // guarantees dx·dpr / dy·dpr are integers so the copy is pixel-exact
  // (a fractional device-pixel shift would resample — and, re-anchor
  // after re-anchor, progressively blur — the baked ink).
  let selfBlitOk = null;
  function testSelfBlit() {
    try {
      const c = document.createElement('canvas');
      c.width = 4;
      c.height = 4;
      const x = c.getContext('2d');
      x.fillStyle = '#f00';
      x.fillRect(0, 0, 1, 1);
      x.globalCompositeOperation = 'copy';
      x.drawImage(c, 1, 0);
      const moved = x.getImageData(1, 0, 1, 1).data;   // red must land at (1,0)
      const vacated = x.getImageData(0, 0, 1, 1).data; // (0,0) must be cleared
      return moved[0] === 255 && moved[3] === 255 && vacated[3] === 0;
    } catch {
      return false;
    }
  }
  function shiftDoneCanvas(dx, dy) {
    for (const t of bakeTargets()) shiftTarget(t, dx, dy);
  }

  function shiftTarget(t, dx, dy) {
    const xf = t.ctx.getTransform();
    const dpr = xf.a || 1;
    const devX = Math.round(dx * dpr);
    const devY = Math.round(dy * dpr);
    // Delta #31 swap path — see the comment block above.
    if (t.spare) {
      const spare = t.spare.canvas;
      const current = t.ctx.canvas;
      if (spare.width !== current.width) spare.width = current.width;
      if (spare.height !== current.height) spare.height = current.height;
      t.spare.save();
      t.spare.setTransform(1, 0, 0, 1, 0, 0);
      t.spare.globalCompositeOperation = 'copy';
      t.spare.drawImage(current, devX, devY);
      t.spare.restore();
      swapRoles(t);
      return;
    }
    if (selfBlitOk === null) selfBlitOk = testSelfBlit();
    if (selfBlitOk) {
      t.ctx.save();
      t.ctx.setTransform(1, 0, 0, 1, 0, 0);
      t.ctx.globalCompositeOperation = 'copy';
      t.ctx.drawImage(t.ctx.canvas, devX, devY);
      t.ctx.restore();
      return;
    }
    // Fallback: scratch round-trip (two full-surface copies).
    const w = t.ctx.canvas.width;
    const h = t.ctx.canvas.height;
    const sCtx = ensureScratch(t.ctx);
    sCtx.save();
    sCtx.setTransform(1, 0, 0, 1, 0, 0);
    sCtx.clearRect(0, 0, w, h);
    sCtx.drawImage(t.ctx.canvas, 0, 0);
    sCtx.restore();
    t.ctx.save();
    t.ctx.setTransform(1, 0, 0, 1, 0, 0);
    t.ctx.clearRect(0, 0, w, h);
    t.ctx.drawImage(scratchCanvas, devX, devY);
    t.ctx.restore();
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

  /** Bake one freshly-committed stroke into whichever target owns it.
   *  Callers used to reach for `getDoneCtx()` directly; with two targets
   *  the choice belongs here. */
  function bakeStroke(stroke) {
    const t = targetFor(stroke);
    if (t === hl) ensureHighlightBacking();
    renderStroke(t.ctx, stroke);
  }

  return {
    renderStroke,
    bakeStroke,
    addToIndex,
    removeFromIndex,
    rebuildIndex,
    rebakeTiles,
    repaintAll,
    fullRebake,
    rebakeRects,
    shiftDoneCanvas,
    tilesForStrokes,
    clearIndex,
    // Delta #31: the done target swaps between two canvases; every
    // consumer that draws to or reads "the done canvas" must resolve
    // it through these instead of a captured reference.
    getDoneCtx: () => done.ctx,
    getSpareCtx: () => done.spare,
    getDoneCanvas: () => done.ctx.canvas,
    // Delta #38: the highlight pair, for the host's sizing / transform
    // passes. `getHighlightCtxs` returns an empty list while the pair is
    // still unbacked, so nothing walks canvases that hold no pixels.
    isHighlightBacked: () => hlBacked,
    getHighlightCtxs: () => (hl && hlBacked ? [hl.ctx, hl.spare].filter(Boolean) : []),
  };
}
