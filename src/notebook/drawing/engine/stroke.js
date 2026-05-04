/* ============================================================
 * HUSH FORK DELTA LOG (vs. temp-drawing-demo reference):
 *   1. createStrokeEngine({ pointToLocal }) — optional resolver for
 *      world-space pointer coords (CSS-transformed wrapper hosts).
 *   2. createStrokeEngine({ getDpr }) — optional DPR provider for
 *      capping backing-store size on memory-limited devices.
 *   3. createStrokeEngine({ brushUrl }) — threaded through to
 *      createAtlasCache; lets callers inject bundler-resolved URLs.
 *   6. Public `fullRebake()` method on the returned API so a sync
 *      shim can batch-load without side-door access via resize().
 *   8. `isStrokeHidden` also excludes strokes with `pocketed === true`
 *      so the hush pocket tray's offscreen thumbnail is the only
 *      rendering of a pocketed stroke.
 *   (Deltas 4 + 5 live in selection.js + gestures.js.)
 * All deltas are additive. Default behavior matches the reference.
 * ============================================================
 *
 * stroke.js (stamped) — canvas-stamp brush renderer.
 *
 * Same stroke data model as pure-svg (arrays of {x, y, pressure}
 * streamlined into smooth curves) but strokes are rendered by
 * stamping a pre-baked brush bitmap along the streamlined path into
 * a 2D canvas. Drop-in for the selection/history engines by exposing
 * the same API surface as pure-svg/stroke.js:
 *
 *   setTool, setColor, setSize, setStreamline, setSmoothing,
 *   setTextured, setRough, setGrain, setTooth, setSpacing,
 *   getStrokes, removeStrokes, insertStrokeAt, setStrokePoints,
 *   previewTransform, commitTransform, clear, resize
 *
 * Layout:
 *   - doneCanvas    baked strokes, excludes any currently-being-previewed ids
 *   - previewCanvas selected strokes drawn with a live transform applied
 *   - liveCanvas    the in-progress stroke
 *   - svg overlay   lasso, bbox, handles, eraser cursor (pointer target)
 *
 * Brush bitmaps are memoised per (color, texture-variant). Any change
 * to texture controls invalidates the cache and rebakes the done layer.
 *
 * previewTransform accepts a structured descriptor:
 *   { kind: 'move',  dx, dy }
 *   { kind: 'scale', sx, sy, ax, ay }
 *   null            (clears the preview and rebakes done with all strokes)
 *
 * This file is the engine factory that wires together:
 *   - stroke-atlas.js    brush atlas cache
 *   - stroke-geometry.js pure math (streamline, bbox, slice, xform desc)
 *   - stroke-render.js   stamping + tile index / rebake
 *   - stroke-erase.js    slice + whole-stroke eraser
 * ============================================================ */

import { BRUSH_DEFS, STROKE_MODES, createAtlasCache, getModeComposite } from './stroke-atlas.js';
import { setsEqual, xformFromDescriptor } from './stroke-geometry.js';
import { createRenderer } from './stroke-render.js';
import { createEraseController } from './stroke-erase.js';

const { min, max } = Math;

// iOS detection — matches tldraw's policy of disabling coalesced events on iOS.
const ua = navigator.userAgent;
const isIOS =
  /iPad|iPhone|iPod/.test(ua) ||
  (/Macintosh/.test(ua) && 'ontouchend' in document);

const LONG_PRESS_MS_DEFAULT = 500;
const LONG_PRESS_MOVE_THRESHOLD_2 = 16; // 4px

export function createStrokeEngine({
  svg,                   // pointer target + overlay host
  doneCanvas,
  previewCanvas,
  liveCanvas,
  eraserCursor,
  getRect,               // () => DOMRect-ish (cached by the app)
  pointToLocal,          // Hush delta #1: optional (clientPt) => localPt for world-space hosts
  getDpr,                // Hush delta #2: optional () => number; defaults to window.devicePixelRatio
  brushUrl,              // Hush delta #3: optional brush-PNG resolver passed to createAtlasCache
  onLongPress,
  onStrokeAdded,
  onStrokesRemoved,
  onStrokesTransformed,
  onStrokesSliced,
  onBrushAtlasLoaded,
  onLayersChanged,
}) {
  // Hush delta #1: when the pointer target lives inside a CSS-transformed
  // wrapper (our case — Pivot B), raw clientX/clientY minus the element's
  // rect gives post-transform screen px, not the world/local px the
  // engine wants to record on stroke points. `pointToLocal` lets the
  // caller swap in a transform-aware converter. Defaults preserve the
  // reference demo's "strip rect.left/top" behavior.
  const toLocal = pointToLocal || ((p) => {
    const r = getRect();
    return { x: p.x - r.left, y: p.y - r.top };
  });
  // Hush delta #2: `getDpr` lets the host cap device-pixel ratio —
  // necessary on iPad where our world-sized canvases can blow past
  // Safari's per-canvas memory limit at native retina. Reference default
  // is unchanged.
  const getDprFn = getDpr || (() => window.devicePixelRatio || 1);
  function fireLayersChanged() {
    if (onLayersChanged) onLayersChanged();
  }
  const OPTIONS = {
    streamline: 0.1,
    smoothing: 1,       // kept for API parity; unused by the stamper
    spacing: 0.2,       // stamp spacing as fraction of brush size
  };

  const state = {
    tool: 'draw',
    color: '#111111',
    size: 4,
    eraserSize: 16,           // dedicated eraser thickness (CSS px radius)
    brush: BRUSH_DEFS[0].id,  // id of the default brush for new strokes
    mode: 'normal',           // stroke composite mode for new strokes (see STROKE_MODES)
    strokes: [],              // ordered list of committed strokes (bottom→top by layer)
    active: null,             // in-progress stroke
    activePointerId: null,
    suppressedPointerId: null,
    lastRecorded: null,
    dirty: false,
    rafId: 0,
    nextId: 1,
    nextLayerId: 1,
    nextLayerNum: 1,          // monotonic counter used to name "Layer N"
    layers: [],               // [{ id, name, locked, hidden }] — index 0 = top
    activeLayerId: 0,
    longPressTimer: 0,
    longPressAnchor: null,
    longPressPointer: null,
    longPressMs: LONG_PRESS_MS_DEFAULT,  // Hush delta #11: configurable via setLongPressMs()
    previewingIds: null,      // Set<id> currently rendered to previewCanvas
    previewingTiles: null,    // tile keys currently held out of doneCanvas
  };

  // Seed with a single default layer.
  (function seedLayers() {
    const id = state.nextLayerId++;
    state.layers.push({ id, name: `Layer ${state.nextLayerNum++}`, locked: false, hidden: false });
    state.activeLayerId = id;
  })();

  function findLayer(id) { return state.layers.find((l) => l.id === id) || null; }
  function layerIndex(id) { return state.layers.findIndex((l) => l.id === id); }
  function activeLayer() { return findLayer(state.activeLayerId); }

  // --------- canvas setup & DPR handling ---------
  const doneCtx = doneCanvas.getContext('2d');
  const previewCtx = previewCanvas.getContext('2d');
  const liveCtx = liveCanvas.getContext('2d');
  const ctxs = [doneCtx, previewCtx, liveCtx];
  let cssWidth = 0, cssHeight = 0, dpr = 1;

  function clearCtx(ctx) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
  }

  function resize(width, height) {
    dpr = getDprFn();
    cssWidth = width;
    cssHeight = height;
    for (const canvas of [doneCanvas, previewCanvas, liveCanvas]) {
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    for (const ctx of ctxs) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
    }
    // Rebake from the stored stroke list so resizing or first-paint matches.
    renderer.fullRebake();
    // Preview/live are transient; clear them.
    clearCtx(previewCtx);
    clearCtx(liveCtx);
    state.previewingIds = null;
    state.previewingTiles = null;
  }

  // --------- wire up subsystems ---------
  const atlas = createAtlasCache({
    brushUrl,            // Hush delta #3: pass-through of the bundler-resolved URL.
    onAtlasReady(brushId) {
      // When a PNG lands, repaint existing strokes that use this brush, and
      // notify the UI so thumbnails can refresh.
      const needsRepaint = brushId === state.brush ||
        state.strokes.some((s) => (s.brush || BRUSH_DEFS[0].id) === brushId);
      if (needsRepaint) renderer.repaintAll();
      if (onBrushAtlasLoaded) onBrushAtlasLoaded(brushId);
    },
  });

  function isStrokeHidden(s) {
    // Hush delta #8: pocketed strokes are rendered in the pocket tray
    // via an offscreen blit, not in the world-space done canvas. Hide
    // them here so they don't double up. Custom `pocketed` field is
    // set by the sync shim when state.shapes[i].pocketed changes.
    if (s.pocketed) return true;
    const L = findLayer(s.layerId);
    return !!(L && L.hidden);
  }
  function isStrokeProtected(s) {
    const L = findLayer(s.layerId);
    return !!(L && (L.locked || L.hidden));
  }

  const renderer = createRenderer({
    doneCtx,
    clearCtx,
    getStrokes: () => state.strokes,
    getTintedAtlas: (brushId, color) => atlas.getTintedAtlas(brushId, color),
    options: OPTIONS,
    isVisible: (s) => !isStrokeHidden(s),
  });

  const eraser = createEraseController({
    getStrokes: () => state.strokes,
    allocId: () => state.nextId++,
    renderer,
    onStrokesSliced,
    isProtected: isStrokeProtected,
  });

  // --------- rAF batching ---------
  function scheduleRender() {
    if (state.rafId) return;
    state.rafId = requestAnimationFrame(render);
  }
  function render() {
    state.rafId = 0;
    if (!state.dirty) return;
    state.dirty = false;
    const a = state.active;
    if (!a) {
      clearCtx(liveCtx);
      return;
    }
    if (a.tool === 'erase' || a.tool === 'slice') {
      clearCtx(liveCtx);
      const p = a.points[a.points.length - 1];
      const r = max(2, state.eraserSize);
      eraserCursor.setAttribute('cx', p.x);
      eraserCursor.setAttribute('cy', p.y);
      eraserCursor.setAttribute('r', r);
      eraserCursor.setAttribute('visibility', 'visible');
      if (a.tool === 'slice') eraser.sliceStrokesAt(p.x, p.y, r);
      else eraser.eraseStrokesAt(p.x, p.y, r);
      return;
    }
    // Draw tool: re-stamp the whole active stroke each frame. The stamper is
    // O(N) and the active stroke is bounded in practice — fast enough to feel
    // live on an iPad Pro, and avoids the ghost-stamp problem that a partial
    // incremental redraw would hit whenever the streamliner retroactively
    // nudges a recent point.
    clearCtx(liveCtx);
    renderer.renderStroke(liveCtx, a);
  }

  // --------- point capture ---------
  function getPoint(e) {
    const raw = e.pressure;
    let pressure;
    if (e.pointerType === 'pen' && raw > 0) pressure = min(1, raw * 1.25);
    else if (raw > 0 && raw !== 0.5 && raw < 1) pressure = min(1, raw * 1.25);
    else pressure = 0.5;
    const local = toLocal({ x: e.clientX, y: e.clientY });
    return { x: local.x, y: local.y, pressure };
  }

  // --------- long-press timer ---------
  function armLongPress(point, pointerId) {
    cancelLongPress();
    state.longPressAnchor = { x: point.x, y: point.y };
    state.longPressPointer = pointerId;
    state.longPressTimer = setTimeout(() => {
      state.longPressTimer = 0;
      if (state.active) {
        state.active = null;
        clearCtx(liveCtx);
        eraserCursor.setAttribute('visibility', 'hidden');
      }
      const pid = state.longPressPointer;
      const anchor = state.longPressAnchor;
      state.suppressedPointerId = pid;
      onLongPress && onLongPress({ pointerId: pid, point: anchor });
    }, state.longPressMs);
  }
  function cancelLongPress() {
    if (state.longPressTimer) {
      clearTimeout(state.longPressTimer);
      state.longPressTimer = 0;
    }
    state.longPressAnchor = null;
    state.longPressPointer = null;
  }

  // --------- pointer handlers ---------
  function onPointerDown(e) {
    if (state.tool !== 'draw' && state.tool !== 'erase' && state.tool !== 'slice') return;
    if (state.tool === 'draw') {
      const L = activeLayer();
      if (L && (L.locked || L.hidden)) return;
    }
    if (e.button !== undefined && e.button !== 0) return;
    // Defensive: if a stroke is already in flight from a different
    // pointer, treat the new contact as the start of a multi-touch
    // gesture (the gestures recogniser may also intercept this in its
    // capture-phase listener; this branch is the backstop). Cancel
    // the in-flight stroke and don't open a second one — committing
    // both would draw a stray dot at each finger.
    if (state.active && state.activePointerId !== null && state.activePointerId !== e.pointerId) {
      cancelLongPress();
      state.active = null;
      state.activePointerId = null;
      state.suppressedPointerId = null;
      clearCtx(liveCtx);
      eraserCursor.setAttribute('visibility', 'hidden');
      return;
    }
    try { svg.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
    const p = getPoint(e);
    const isPen = e.pointerType === 'pen';
    state.active = {
      id: state.nextId++,
      tool: state.tool,
      color: state.color,
      size: state.size,
      brush: state.brush,
      mode: state.mode,
      layerId: state.activeLayerId,
      isPen,
      points: [p],
    };
    state.lastRecorded = p;
    state.activePointerId = e.pointerId;
    state.suppressedPointerId = null;
    state.dirty = true;
    armLongPress(p, e.pointerId);
    if (state.tool === 'erase' || state.tool === 'slice') {
      svg.classList.add('erasing');
      // Snapshot for the diff. Both erase and slice use the same session
      // machinery; the first cursor sample fires here so a quick tap acts
      // at the down-point too.
      eraser.beginSliceSession();
      const r = max(2, state.eraserSize);
      if (state.tool === 'slice') eraser.sliceStrokesAt(p.x, p.y, r);
      else eraser.eraseStrokesAt(p.x, p.y, r);
    }
    scheduleRender();
  }

  function extendStroke(p) {
    const a = state.active;
    if (!a) return;
    const last = state.lastRecorded;
    const dx = p.x - last.x, dy = p.y - last.y;
    if (dx * dx + dy * dy < 1) {
      a.points[a.points.length - 1] = p;
    } else {
      a.points.push(p);
      state.lastRecorded = p;
    }
    state.dirty = true;
    if (state.longPressTimer && state.longPressAnchor) {
      const ax = p.x - state.longPressAnchor.x;
      const ay = p.y - state.longPressAnchor.y;
      if (ax * ax + ay * ay > LONG_PRESS_MOVE_THRESHOLD_2) cancelLongPress();
    }
  }

  function onPointerMove(e) {
    if (e.pointerId === state.suppressedPointerId) return;
    if (!state.active) return;
    // Only the pointer that started the stroke extends it. Without
    // this, a second finger landing on the canvas (e.g. during a
    // 2-finger undo gesture) appends its position to the active
    // stroke — the user sees a stray straight line between fingers.
    // The gesture recogniser cancels the stroke once it qualifies as
    // a tap, but a single pointermove can land first.
    if (state.activePointerId !== null && e.pointerId !== state.activePointerId) return;
    const events = !isIOS && typeof e.getCoalescedEvents === 'function'
      ? e.getCoalescedEvents()
      : [e];
    for (let i = 0; i < events.length; i++) extendStroke(getPoint(events[i]));
    scheduleRender();
  }

  function endStroke() {
    cancelLongPress();
    const a = state.active;
    state.active = null;
    state.activePointerId = null;
    if (!a) return;
    if (a.tool === 'erase' || a.tool === 'slice') {
      clearCtx(liveCtx);
      // Commit one history-worthy event for the whole drag.
      eraser.endSliceSession();
      return;
    }
    // Commit: draw to done and clear live on the same frame so there's no gap.
    renderer.renderStroke(doneCtx, a);
    clearCtx(liveCtx);
    const insertIdx = insertStrokeIntoLayer(a, a.layerId);
    renderer.addToIndex(a);
    if (insertIdx !== state.strokes.length - 1) {
      // Stroke was inserted beneath existing strokes in higher layers; those
      // strokes' tiles need a rebake so overlaps composite in the right order.
      renderer.rebakeTiles(a.tiles);
    }
    if (onStrokeAdded) onStrokeAdded(a, insertIdx);
  }

  // Inserts `stroke` at the top of its layer's contiguous block inside
  // state.strokes (which is kept sorted bottom-layer first). Returns the
  // resulting index.
  function insertStrokeIntoLayer(stroke, layerId) {
    const k = layerIndex(layerId);
    let lastAtOrBelow = -1;
    for (let i = 0; i < state.strokes.length; i++) {
      if (layerIndex(state.strokes[i].layerId) >= k) lastAtOrBelow = i;
    }
    const at = lastAtOrBelow + 1;
    state.strokes.splice(at, 0, stroke);
    return at;
  }

  // Resort state.strokes by layer z-order (bottom layer first). Uses the
  // native stable sort so per-layer stroke order is preserved.
  function resortStrokesByLayer() {
    state.strokes.sort((a, b) => layerIndex(b.layerId) - layerIndex(a.layerId));
  }

  function onPointerUp(e) {
    if (e.pointerId === state.suppressedPointerId) {
      state.suppressedPointerId = null;
      svg.classList.remove('erasing');
      eraserCursor.setAttribute('visibility', 'hidden');
      return;
    }
    if (!state.active) return;
    // Mirror the pointermove guard: only the active pointer's lift
    // commits the stroke. Ignoring foreign pointerups stops a second
    // finger lifting (during a 2-finger undo) from extending and
    // committing the in-flight stroke.
    if (state.activePointerId !== null && e.pointerId !== state.activePointerId) return;
    try { svg.releasePointerCapture(e.pointerId); } catch {}
    extendStroke(getPoint(e));
    endStroke();
    svg.classList.remove('erasing');
    eraserCursor.setAttribute('visibility', 'hidden');
  }

  svg.addEventListener('pointerdown', onPointerDown);
  document.body.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  // --------- preview transform pipeline ---------
  // idsSet comparison: previewTransform is called on every pointermove during
  // a drag, but the selection set only changes on pointerdown. We rebake the
  // done layer (excluding selected ids) only on the first call for a given
  // set, then just redraw the preview canvas on subsequent calls.
  function previewTransform(idsSet, transform) {
    if (transform == null) {
      clearCtx(previewCtx);
      if (state.previewingIds) {
        // Restore the done canvas for the tiles the selection was hiding.
        renderer.rebakeTiles(state.previewingTiles);
        state.previewingIds = null;
        state.previewingTiles = null;
      }
      return;
    }
    if (!setsEqual(state.previewingIds, idsSet)) {
      // Collect the tiles the selected strokes currently occupy on done and
      // rebake them without those strokes. Subsequent preview frames only
      // have to redraw the preview canvas.
      const selected = [];
      for (const s of state.strokes) if (idsSet.has(s.id)) selected.push(s);
      const tiles = renderer.tilesForStrokes(selected);
      renderer.rebakeTiles(tiles, idsSet);
      state.previewingIds = new Set(idsSet);
      state.previewingTiles = tiles;
    }
    clearCtx(previewCtx);
    const xf = xformFromDescriptor(transform);
    for (const s of state.strokes) {
      if (idsSet.has(s.id)) renderer.renderStroke(previewCtx, s, xf);
    }
  }

  function commitTransform(idsSet, fn, sizeScale) {
    const entries = [];
    // Gather the tiles both before and after the transform so rebake sweeps
    // clean the old position and paints the new one in one pass.
    const dirty = new Set();
    if (state.previewingTiles) for (const k of state.previewingTiles) dirty.add(k);
    const scale = (typeof sizeScale === 'number' && sizeScale > 0) ? sizeScale : 1;
    for (const s of state.strokes) {
      if (!idsSet.has(s.id)) continue;
      const before = s.points;
      const after = before.map((p) => {
        const [x, y] = fn(p.x, p.y);
        return { x, y, pressure: p.pressure };
      });
      s.points = after;
      // Proportional resize also scales the brush thickness so
      // strokes shrink / grow visually as their bbox does. Caller
      // omits sizeScale (or passes 1) for translation-only commits.
      if (scale !== 1) s.size = Math.max(0.5, s.size * scale);
      // Re-index at the new bbox; collect both old and new tiles as dirty.
      if (s.tiles) for (const k of s.tiles) dirty.add(k);
      renderer.removeFromIndex(s);
      renderer.addToIndex(s);
      for (const k of s.tiles) dirty.add(k);
      entries.push({ id: s.id, before, after });
    }
    clearCtx(previewCtx);
    state.previewingIds = null;
    state.previewingTiles = null;
    renderer.rebakeTiles(dirty);
    if (entries.length && onStrokesTransformed) onStrokesTransformed(entries);
  }

  // Fire off PNG atlas loads. Procedural fallbacks carry the engine until the
  // PNGs finish decoding; as each lands the affected strokes repaint in place.
  atlas.loadPngBrushes();

  return {
    // --- config ---
    setTool(t) {
      if (state.tool === t) return;
      state.tool = t;
      if (state.active) {
        // Abandoning an active erase/slice mid-drag: commit whatever was
        // changed so the drag isn't silently discarded into a non-undoable
        // state.
        if (state.active.tool === 'erase' || state.active.tool === 'slice') {
          eraser.endSliceSession();
        }
        state.active = null;
        clearCtx(liveCtx);
      }
      cancelLongPress();
      svg.classList.remove('erasing');
      eraserCursor.setAttribute('visibility', 'hidden');
    },
    // Abort the in-flight stroke without committing it. Called by the gesture
    // recogniser when a second finger lands to promote the burst into a
    // multi-touch gesture.
    cancelActiveStroke() {
      if (!state.active) return false;
      // For an erase/slice drag, drop the snapshot without firing — the
      // multi-touch gesture is going to undo any change the first finger did.
      if (state.active.tool === 'erase' || state.active.tool === 'slice') {
        eraser.discardSliceSession();
      }
      cancelLongPress();
      state.active = null;
      state.activePointerId = null;
      state.suppressedPointerId = null;
      clearCtx(liveCtx);
      svg.classList.remove('erasing');
      eraserCursor.setAttribute('visibility', 'hidden');
      return true;
    },
    setColor(c) { state.color = c; },
    setSize(n) { state.size = +n; },
    setEraserSize(n) { state.eraserSize = max(2, +n); },
    getEraserSize() { return state.eraserSize; },
    setBrush(id) {
      if (!BRUSH_DEFS.some((b) => b.id === id)) return;
      state.brush = id;
    },
    setMode(mode) {
      if (!STROKE_MODES[mode]) return;
      state.mode = mode;
    },
    getBrushList() {
      return BRUSH_DEFS.map((b) => ({ id: b.id, name: b.name }));
    },
    getCurrentBrush() { return state.brush; },
    getCurrentMode() { return state.mode; },
    setStreamline(v) { OPTIONS.streamline = +v; },
    setSmoothing(v) { OPTIONS.smoothing = +v; },
    setSpacing(v) { OPTIONS.spacing = +v; },
    // Hush delta #11: long-press-to-lasso delay, in ms. Configurable so
    // the hush UI can expose a slider for users who want the select
    // gesture to fire faster or require a more deliberate hold.
    setLongPressMs(ms) {
      const n = +ms;
      if (!Number.isFinite(n) || n <= 0) return;
      state.longPressMs = n;
    },
    // Render a brush swatch (atlas cell 0, tinted by color) into targetCtx,
    // centered at (x, y) with the given pixel size. The caller is responsible
    // for clearing targetCtx first. `mode` governs how the thumbnail reads:
    // in highlighter mode we honor the stroke alpha so the thumbnail comes
    // out translucent. The composite op stays source-over — the swatch sits
    // on an empty canvas, so multiplying against transparent would just show
    // the source anyway.
    renderBrushSwatch(brushId, color, targetCtx, x, y, size, mode) {
      const { atlas: tinted, cell } = atlas.getTintedAtlas(brushId, color);
      const { strokeAlpha } = getModeComposite(mode || 'normal');
      const half = size / 2;
      targetCtx.save();
      targetCtx.globalAlpha = strokeAlpha;
      targetCtx.drawImage(tinted, 0, 0, cell, cell, x - half, y - half, size, size);
      targetCtx.restore();
    },

    // --- canvas lifecycle ---
    resize,

    // --- queries ---
    getStrokes() { return state.strokes; },
    getStrokeNode() { return null; },  // no per-stroke DOM node

    // --- mutations (used by erase, selection, history) ---
    removeStrokes(ids) {
      const idSet = ids instanceof Set ? ids : new Set(ids);
      const removed = [];
      const dirty = new Set();
      for (let i = state.strokes.length - 1; i >= 0; i--) {
        const s = state.strokes[i];
        if (idSet.has(s.id)) {
          if (s.tiles) for (const k of s.tiles) dirty.add(k);
          renderer.removeFromIndex(s);
          state.strokes.splice(i, 1);
          removed.push({ stroke: s, index: i });
        }
      }
      if (!removed.length) return;
      removed.reverse();
      renderer.rebakeTiles(dirty);
      if (onStrokesRemoved) onStrokesRemoved(removed);
    },
    insertStrokeAt(stroke, index) {
      const clamped = max(0, min(index, state.strokes.length));
      state.strokes.splice(clamped, 0, stroke);
      renderer.addToIndex(stroke);
      // Everything in these tiles may need to re-layer with the inserted one.
      renderer.rebakeTiles(stroke.tiles);
    },
    setStrokePoints(id, points) {
      const s = state.strokes.find((x) => x.id === id);
      if (!s) return;
      const dirty = new Set();
      if (s.tiles) for (const k of s.tiles) dirty.add(k);
      renderer.removeFromIndex(s);
      s.points = points;
      renderer.addToIndex(s);
      for (const k of s.tiles) dirty.add(k);
      renderer.rebakeTiles(dirty);
    },
    // Retroactively change color, size, brush, and/or mode on a set of
    // strokes. History is handled by the caller (it snapshots before/after
    // and pushes a single entry for the whole styling session, which can
    // span many live slider ticks). Size changes may expand the stroke's
    // bbox, so we re-index; color / brush / mode changes don't affect bbox.
    setStrokesStyle(ids, patch) {
      const idSet = ids instanceof Set ? ids : new Set(ids);
      const sizeChanged = patch.size !== undefined;
      const dirty = new Set();
      let any = false;
      for (const s of state.strokes) {
        if (!idSet.has(s.id)) continue;
        if (s.tiles) for (const k of s.tiles) dirty.add(k);
        if (patch.color !== undefined) s.color = patch.color;
        if (patch.brushId !== undefined) s.brush = patch.brushId;
        if (patch.mode !== undefined && STROKE_MODES[patch.mode]) s.mode = patch.mode;
        if (sizeChanged) s.size = +patch.size;
        if (sizeChanged) {
          renderer.removeFromIndex(s);
          renderer.addToIndex(s);
          for (const k of s.tiles) dirty.add(k);
        }
        any = true;
      }
      if (any) renderer.rebakeTiles(dirty);
    },
    // Per-id style map, used by undo/redo when the original selection had
    // heterogeneous styles.
    setStrokesStyleMap(styleMap) {
      const dirty = new Set();
      let any = false;
      for (const s of state.strokes) {
        const patch = styleMap.get(s.id);
        if (!patch) continue;
        if (s.tiles) for (const k of s.tiles) dirty.add(k);
        if (patch.color !== undefined) s.color = patch.color;
        if (patch.brushId !== undefined) s.brush = patch.brushId;
        if (patch.mode !== undefined && STROKE_MODES[patch.mode]) s.mode = patch.mode;
        if (patch.size !== undefined) {
          s.size = +patch.size;
          renderer.removeFromIndex(s);
          renderer.addToIndex(s);
          for (const k of s.tiles) dirty.add(k);
        }
        any = true;
      }
      if (any) renderer.rebakeTiles(dirty);
    },

    // --- selection live preview ---
    previewTransform,
    commitTransform,

    clear() {
      state.strokes = [];
      renderer.clearIndex();
      clearCtx(doneCtx);
      clearCtx(previewCtx);
      clearCtx(liveCtx);
      state.previewingIds = null;
      state.previewingTiles = null;
    },

    // Hush delta #6: public rebake — expose the renderer's fullRebake
    // so the sync shim can batch-load a notebook full of strokes with a
    // single repaint at the end, instead of triggering a rebake per
    // insert. See INTEGRATION-PLAN.md.
    fullRebake() {
      renderer.fullRebake();
    },

    // --- layers ---
    getLayers() {
      return state.layers.map((l) => ({ ...l }));
    },
    getLayerById(id) {
      const L = findLayer(id);
      return L ? { ...L } : null;
    },
    getActiveLayerId() { return state.activeLayerId; },
    setActiveLayer(id) {
      if (!findLayer(id)) return false;
      if (state.activeLayerId === id) return false;
      state.activeLayerId = id;
      fireLayersChanged();
      return true;
    },
    // Create a new layer. Without opts, inserts above the active layer.
    // `idHint` + `nameHint` + `atIndex` make this replayable by the history
    // stack: pass the original values on redo to reproduce the same layer.
    createLayer(opts = {}) {
      const idHint = opts.idHint;
      const id = idHint != null ? idHint : state.nextLayerId++;
      if (idHint != null && idHint >= state.nextLayerId) state.nextLayerId = idHint + 1;
      let name;
      if (opts.name) {
        name = opts.name;
      } else {
        name = `Layer ${state.nextLayerNum++}`;
      }
      const layer = {
        id,
        name,
        locked: !!opts.locked,
        hidden: !!opts.hidden,
      };
      let at = opts.atIndex;
      if (at == null) {
        const k = layerIndex(state.activeLayerId);
        at = k < 0 ? 0 : k;
      }
      at = max(0, min(at, state.layers.length));
      state.layers.splice(at, 0, layer);
      state.activeLayerId = id;
      // New layer has no strokes, so no rebake needed.
      fireLayersChanged();
      return { layer: { ...layer }, index: at };
    },
    // Remove a layer and all of its strokes. Returns a snapshot for undo:
    // { layer, layerIndex, strokes: [{ stroke, index }], prevActiveLayerId }.
    deleteLayer(id) {
      if (state.layers.length <= 1) return null;
      const idx = layerIndex(id);
      if (idx < 0) return null;
      const layer = state.layers[idx];
      // Snapshot strokes in ascending state.strokes-index order so restore
      // can splice them back at their original positions.
      const snapStrokes = [];
      const dirty = new Set();
      for (let i = 0; i < state.strokes.length; i++) {
        const s = state.strokes[i];
        if (s.layerId === id) snapStrokes.push({ stroke: s, index: i });
      }
      // Walk in reverse to splice and collect dirty tiles.
      for (let j = snapStrokes.length - 1; j >= 0; j--) {
        const s = snapStrokes[j].stroke;
        if (s.tiles) for (const k of s.tiles) dirty.add(k);
        renderer.removeFromIndex(s);
        state.strokes.splice(snapStrokes[j].index, 1);
      }
      const prevActiveLayerId = state.activeLayerId;
      state.layers.splice(idx, 1);
      if (state.activeLayerId === id) {
        // Prefer the layer that took this layer's slot; fall back to prev.
        const nextIdx = min(idx, state.layers.length - 1);
        state.activeLayerId = state.layers[nextIdx].id;
      }
      if (dirty.size) renderer.rebakeTiles(dirty);
      fireLayersChanged();
      return {
        layer: { ...layer },
        layerIndex: idx,
        strokes: snapStrokes,
        prevActiveLayerId,
      };
    },
    restoreLayerSnapshot(snap) {
      if (!snap) return;
      const { layer, layerIndex: lIdx, strokes, prevActiveLayerId } = snap;
      state.layers.splice(lIdx, 0, { ...layer });
      if (layer.id >= state.nextLayerId) state.nextLayerId = layer.id + 1;
      // Re-insert strokes at their original indices (ascending order).
      const dirty = new Set();
      for (const entry of strokes) {
        state.strokes.splice(entry.index, 0, entry.stroke);
        renderer.addToIndex(entry.stroke);
        if (entry.stroke.tiles) for (const k of entry.stroke.tiles) dirty.add(k);
      }
      if (prevActiveLayerId != null && findLayer(prevActiveLayerId)) {
        state.activeLayerId = prevActiveLayerId;
      }
      if (dirty.size) renderer.rebakeTiles(dirty);
      fireLayersChanged();
    },
    renameLayer(id, name) {
      const L = findLayer(id);
      if (!L || L.name === name) return false;
      L.name = name;
      fireLayersChanged();
      return true;
    },
    setLayerLocked(id, locked) {
      const L = findLayer(id);
      if (!L || L.locked === !!locked) return false;
      L.locked = !!locked;
      fireLayersChanged();
      return true;
    },
    setLayerHidden(id, hidden) {
      const L = findLayer(id);
      if (!L || L.hidden === !!hidden) return false;
      L.hidden = !!hidden;
      const dirty = new Set();
      for (const s of state.strokes) {
        if (s.layerId !== id) continue;
        if (s.tiles) for (const k of s.tiles) dirty.add(k);
      }
      if (dirty.size) renderer.rebakeTiles(dirty);
      fireLayersChanged();
      return true;
    },
    moveLayer(fromIdx, toIdx) {
      const N = state.layers.length;
      if (fromIdx < 0 || fromIdx >= N) return false;
      if (toIdx < 0 || toIdx >= N) return false;
      if (fromIdx === toIdx) return false;
      const [layer] = state.layers.splice(fromIdx, 1);
      state.layers.splice(toIdx, 0, layer);
      resortStrokesByLayer();
      renderer.fullRebake();
      fireLayersChanged();
      return true;
    },
  };
}
