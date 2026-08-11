/* ============================================================
 * HUSH FORK DELTA LOG (vs. temp-drawing-demo reference):
 *   4. createSelectionEngine({ pointToLocal }) — optional resolver
 *      used by clientToSvg. Same contract as stroke.js delta #1.
 *   7. Handle shapes are <rect> squares, not <circle>, to match
 *      hush's selection handle style for all shape types.
 *      Sized / positioned via HANDLE_SIZE (side length) + x/y rather
 *      than HANDLE_RADIUS + cx/cy.
 *   9. Delete badge (the red X beside the bbox) is hidden. Hush's
 *      shared selection toolbar's trash icon owns delete for every
 *      shape type, so an extra engine-drawn badge was redundant.
 *      The element is still created (kept out of the DOM) so the
 *      rest of the code path that references `deleteBtn.setAttribute`
 *      stays a no-op without branch changes.
 *  15. setEventActive(bool) — softer counterpart to activate /
 *      deactivate that toggles `state.active` (and clears any
 *      in-flight lasso) WITHOUT clearing the selection set or bbox.
 *      Hush's drawing-layer.setTool uses it for non-select sub-tools
 *      so the engine stops capturing events without dropping the
 *      user's retroactive selection.
 *  16. setChromeInteractive(bool) — toggles pointer-events on the
 *      bbox `<g>`. Used during pen+draw/erase/slice with a live
 *      retroactive selection so the chrome stays painted (visual
 *      feedback) but every pointerdown falls through to the stroke
 *      engine, leaving the user's next stroke un-intercepted.
 *  32. onLassoRegion(poly) — region handoff. When the host supplies it,
 *      a completed lasso / marquee hands its polygon up instead of
 *      running the engine's stroke-only hit test: Hush hit-tests every
 *      shape type against the same polygon (src/notebook/
 *      selection-region.ts) and pushes the result back down through
 *      setSelectedIds. The engine keeps its own hit test as the
 *      fallback for hosts that don't wire the callback.
 *  33. Rectangle marquee mode + startMarqueeAtPointer(). A single
 *      finger dragging in pen mode (stroke.js delta #33) sweeps a box
 *      instead of a freehand loop; it reuses the lasso path element
 *      (four corners, closed) so there's one region pipeline and one
 *      set of visuals.
 *  34. setExternalBounds(bbox) / setHandlesHidden(bool) — a selection
 *      can now hold shapes the engine knows nothing about (text,
 *      images, drag-areas). The host unions their bounds into the
 *      engine bbox so the chrome frames the whole selection and the
 *      bbox-grab move covers it; the resize / rotate handles hide,
 *      because those transforms only reach strokes.
 * ============================================================
 *
 * selection.js — lasso + bounding box + move/resize/delete.
 *
 * Works against the stroke engine via four methods:
 *   getStrokes(), removeStrokes(ids),
 *   previewTransform(ids, svgTransformStr), commitTransform(ids, fn)
 *
 * Uses SVG `transform` on each selected path for free live preview during
 * drag/resize, then bakes the final transform into the stored points on
 * pointerup — so the stroke engine's data model stays canonical and the
 * outline geometry doesn't need to be recomputed every frame.
 * ============================================================ */

const SVG_NS = 'http://www.w3.org/2000/svg';
// Hush delta #7: square handles (rects) instead of the reference's
// circles, matching the canvas-drawn handle style Hush uses for
// text/image/drag-area selection. HANDLE_SIZE is the side length;
// offset from the corner is HANDLE_SIZE/2 so the rect is centered
// on the bbox corner.
const HANDLE_SIZE = 10;   // comfortable touch target; slightly larger than hush's canvas 7px
const HANDLE_HALF = HANDLE_SIZE / 2;
const MIN_SCALE = 0.05;
// Rotation handle: a small circle floating off the LEFT edge of the
// bbox. ROTATE_OFFSET is the pixel gap between the bbox's left edge
// and the handle's center. Sized a touch larger than the resize
// handles so it reads as a different affordance, and far enough out
// that a finger can grab it without overlapping the left resize
// column. It used to float above the top edge, but the selection
// toolbar hovers there and kept hiding it.
const ROTATE_HANDLE_R = 8;
const ROTATE_OFFSET = 48;

const HANDLE_SPEC = [
  { name: 'nw', sx: 0, sy: 0 },
  { name: 'n',  sx: 0.5, sy: 0 },
  { name: 'ne', sx: 1, sy: 0 },
  { name: 'e',  sx: 1, sy: 0.5 },
  { name: 'se', sx: 1, sy: 1 },
  { name: 's',  sx: 0.5, sy: 1 },
  { name: 'sw', sx: 0, sy: 1 },
  { name: 'w',  sx: 0, sy: 0.5 },
];

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const intersect =
      (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function computeBBox(strokes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    const pad = s.size / 2;
    for (const p of s.points) {
      if (p.x - pad < minX) minX = p.x - pad;
      if (p.y - pad < minY) minY = p.y - pad;
      if (p.x + pad > maxX) maxX = p.x + pad;
      if (p.y + pad > maxY) maxY = p.y + pad;
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function createSelectionEngine({
  svg,
  layer,           // <g id="selectionLayer">
  getRect,
  pointToLocal,    // Hush delta #4: optional (clientPt) => localPt; mirror of stroke.js delta #1
  strokeEngine,
  isSelectable,    // (stroke) => bool — skip locked/hidden in lasso hit-test
  onExit,          // () => void — user hit Escape to leave select mode
  onLassoRegion,   // Hush delta #32: (poly: [x,y][], { marquee }) => void — host
                   //   owns the hit test for every shape type; when present the
                   //   engine skips its own stroke-only pass.
  onLassoComplete, // ({ selected: boolean }) — fires at the end of every lasso
  onSelectionDeleted, // () — fires after strokes were removed from a selection
  onDragStart,     // (kind: 'move' | 'resize' | 'rotate', ids: Set<number>) — engine-driven drag begins
  onDragMove,      // ({ kind, dx, dy }) — engine-driven drag tick (move only emits dx/dy)
  onDragEnd,       // (cancelled?: boolean) — engine-driven drag finished.
                   //   `true` = aborted by cancelActive (a gesture claimed the
                   //   burst), so the host must roll its half back too.
  onRegionCancel,  // Hush delta #33: () — an in-flight lasso / marquee was
                   //   abandoned (promoted into a multi-touch gesture). The host
                   //   uses it to hand back the brush the region gesture borrowed.
}) {
  const selectable = isSelectable || (() => true);
  const toLocal = pointToLocal || ((p) => {
    const r = getRect();
    return { x: p.x - r.left, y: p.y - r.top };
  });
  // ---------- DOM scaffolding ----------
  const lassoPath = document.createElementNS(SVG_NS, 'path');
  lassoPath.setAttribute('class', 'lasso');
  lassoPath.setAttribute('d', '');
  lassoPath.setAttribute('visibility', 'hidden');
  layer.appendChild(lassoPath);

  const bboxGroup = document.createElementNS(SVG_NS, 'g');
  bboxGroup.setAttribute('visibility', 'hidden');
  layer.appendChild(bboxGroup);

  const bboxRect = document.createElementNS(SVG_NS, 'rect');
  bboxRect.setAttribute('class', 'bbox');
  bboxGroup.appendChild(bboxRect);

  // Hush delta #34: resize / rotate handles live in their own group so
  // they can be hidden as a unit when the selection contains shapes the
  // engine can't transform (text, images, drag-areas). `visibility` —
  // not pointer-events — because it's inherited, so a hidden handle
  // can't be grabbed either.
  const handlesGroup = document.createElementNS(SVG_NS, 'g');
  bboxGroup.appendChild(handlesGroup);

  const handleNodes = {};
  for (const spec of HANDLE_SPEC) {
    const c = document.createElementNS(SVG_NS, 'rect');
    c.setAttribute('class', `handle ${spec.name}`);
    c.setAttribute('width', HANDLE_SIZE);
    c.setAttribute('height', HANDLE_SIZE);
    c.dataset.handle = spec.name;
    handlesGroup.appendChild(c);
    handleNodes[spec.name] = c;
  }

  // Rotation handle — circle hovering off the left edge with a thin
  // tether back to the bbox so it reads as part of the selection
  // chrome. Drag rotates the selected strokes around the bbox center.
  const rotateTether = document.createElementNS(SVG_NS, 'line');
  rotateTether.setAttribute('class', 'handle-tether');
  rotateTether.setAttribute('stroke', 'currentColor');
  rotateTether.setAttribute('stroke-width', '1');
  handlesGroup.appendChild(rotateTether);
  const rotateHandle = document.createElementNS(SVG_NS, 'circle');
  rotateHandle.setAttribute('class', 'handle rotate');
  rotateHandle.setAttribute('r', ROTATE_HANDLE_R);
  rotateHandle.dataset.handle = 'rotate';
  handlesGroup.appendChild(rotateHandle);

  // Hush delta #9: the red-X delete badge is hidden. Hush surfaces
  // delete through the shared selection toolbar's trash icon, so an
  // extra delete affordance attached to the engine's bbox is redundant.
  // The node stays in the tree (classifyTarget still recognizes
  // data-handle="delete") but renders at display:none so clicks can't
  // land on it.
  const deleteBtn = document.createElementNS(SVG_NS, 'g');
  deleteBtn.setAttribute('class', 'delete-btn');
  deleteBtn.dataset.handle = 'delete';
  deleteBtn.style.display = 'none';

  // ---------- state ----------
  const state = {
    active: false,               // whether the select tool is active
    mode: 'idle',                // 'idle' | 'lasso' | 'marquee' | 'move' | 'resize' | 'rotate'
    lassoPts: [],
    marqueeAnchor: null,         // Hush delta #33: { x, y } corner the box grows from
    extraBBox: null,             // Hush delta #34: host bounds for non-stroke selection
    handlesHidden: false,        // Hush delta #34: resize/rotate hidden (mixed selection)
    selectedIds: new Set(),
    bbox: null,                  // { x, y, w, h }
    dragPointerId: null,
    dragStart: null,             // { x, y } in SVG space
    resizeHandle: null,          // 'nw' | 'n' | ... when mode==='resize'
    bboxAtDragStart: null,       // bbox snapshot for resize math
    lastTransform: null,         // last applied transform (for commit)
    rotateAnchor: null,          // { x, y } center of rotation
    rotateStartAngle: 0,         // angle (rad) of cursor at rotation start
    externalDragging: false,     // true while Hush owns a drag; bbox stays hidden
    chromeHidden: false,         // true while pen+draw/erase/slice — keep ids for retro styling, hide chrome
  };

  // ---------- helpers ----------
  function clientToSvg(e) {
    return toLocal({ x: e.clientX, y: e.clientY });
  }

  function updateBBoxView() {
    // Externally-driven drag (Hush rectangle-select moving strokes)
    // hides the bbox + handles; refuse to flip them back to visible
    // even if the bridge re-runs setSelectedIds while the gesture is
    // in flight (state.shapes mutates per pointermove → the bridge
    // listens for "shapes" → would otherwise reveal the bbox here).
    if (state.externalDragging || state.chromeHidden) {
      bboxGroup.setAttribute('visibility', 'hidden');
      return;
    }
    if (!state.bbox || (state.selectedIds.size === 0 && !state.extraBBox)) {
      bboxGroup.setAttribute('visibility', 'hidden');
      return;
    }
    const { x, y, w, h } = state.bbox;
    bboxGroup.setAttribute('visibility', 'visible');
    handlesGroup.setAttribute('visibility', state.handlesHidden ? 'hidden' : 'visible');
    bboxRect.setAttribute('x', x);
    bboxRect.setAttribute('y', y);
    bboxRect.setAttribute('width', w);
    bboxRect.setAttribute('height', h);
    for (const spec of HANDLE_SPEC) {
      const hx = x + w * spec.sx;
      const hy = y + h * spec.sy;
      const n = handleNodes[spec.name];
      // Rects are positioned by top-left, so offset by half the size
      // to keep the handle centered on the bbox corner/midpoint.
      n.setAttribute('x', hx - HANDLE_HALF);
      n.setAttribute('y', hy - HANDLE_HALF);
    }
    // Rotation handle floats off the left-center edge (the top edge
    // sits under the hovering selection toolbar).
    const rcx = x - ROTATE_OFFSET;
    const rcy = y + h / 2;
    rotateHandle.setAttribute('cx', rcx);
    rotateHandle.setAttribute('cy', rcy);
    rotateTether.setAttribute('x1', x);
    rotateTether.setAttribute('y1', rcy);
    rotateTether.setAttribute('x2', rcx + ROTATE_HANDLE_R);
    rotateTether.setAttribute('y2', rcy);
    deleteBtn.setAttribute('transform', `translate(${x + w + 14}, ${y - 14})`);
  }

  function updateLassoView() {
    if (state.lassoPts.length < 2) {
      lassoPath.setAttribute('visibility', 'hidden');
      return;
    }
    let d = `M${state.lassoPts[0][0].toFixed(2)},${state.lassoPts[0][1].toFixed(2)}`;
    for (let i = 1; i < state.lassoPts.length; i++) {
      d += ` L${state.lassoPts[i][0].toFixed(2)},${state.lassoPts[i][1].toFixed(2)}`;
    }
    if (state.mode !== 'lasso') d += ' Z';
    lassoPath.setAttribute('d', d);
    lassoPath.setAttribute('visibility', 'visible');
  }

  function clearLasso() {
    state.lassoPts = [];
    state.marqueeAnchor = null;
    lassoPath.setAttribute('d', '');
    lassoPath.setAttribute('visibility', 'hidden');
  }

  /** Hush delta #33: rebuild the region polygon as the four corners of
   *  the box between the marquee anchor and the live pointer. Reusing
   *  `lassoPts` keeps one render path and one completion path. */
  function updateMarquee(p) {
    const a = state.marqueeAnchor;
    if (!a) return;
    state.lassoPts = [[a.x, a.y], [p.x, a.y], [p.x, p.y], [a.x, p.y]];
    updateLassoView();
  }

  function clearSelection() {
    state.selectedIds.clear();
    state.bbox = null;
    // Hush delta #34: the host re-pushes its non-stroke bounds on the
    // next selection notify, so dropping them here can't strand chrome
    // around shapes that are no longer selected.
    state.extraBBox = null;
    // Drop any leftover rotation transform from a previous gesture so
    // the chrome reads axis-aligned the next time a selection lands.
    bboxGroup.removeAttribute('transform');
    updateBBoxView();
  }

  function recomputeBBoxFromSelection() {
    const strokes = strokeEngine.getStrokes().filter((s) => state.selectedIds.has(s.id));
    // Hush delta #34: the host's non-stroke bounds count as selection
    // too — without them a text-only lasso would clear the chrome here
    // and leave nothing to grab.
    const ex = state.extraBBox;
    if (!strokes.length && !ex) {
      state.selectedIds.clear();
      state.bbox = null;
    } else if (!strokes.length) {
      state.bbox = { ...ex };
    } else {
      const b = computeBBox(strokes);
      state.bbox = ex ? {
        x: Math.min(b.x, ex.x),
        y: Math.min(b.y, ex.y),
        w: Math.max(b.x + b.w, ex.x + ex.w) - Math.min(b.x, ex.x),
        h: Math.max(b.y + b.h, ex.y + ex.h) - Math.min(b.y, ex.y),
      } : b;
    }
    updateBBoxView();
  }

  function selectFromLasso() {
    const poly = state.lassoPts;
    const wasMarquee = state.marqueeAnchor != null;
    // Hush delta #32: hand the region up when the host owns hit testing.
    // The host selects across every shape type and pushes the stroke
    // subset back through setSelectedIds, so we don't resolve the
    // selection ourselves — just retire the visible polygon. A
    // degenerate region (a tap) goes up too: the host reads "nothing
    // selected" as a dismissal and hands the user back their brush.
    if (onLassoRegion) {
      const region = poly.map((p) => [p[0], p[1]]);
      clearLasso();
      clearSelection();
      onLassoRegion(region, { marquee: wasMarquee });
      return;
    }
    if (poly.length < 3) {
      clearLasso();
      clearSelection();
      onLassoComplete && onLassoComplete({ selected: false });
      return;
    }
    const strokes = strokeEngine.getStrokes();
    const newSel = new Set();
    for (const s of strokes) {
      if (!selectable(s)) continue;
      for (const p of s.points) {
        if (pointInPolygon(p.x, p.y, poly)) {
          newSel.add(s.id);
          break;
        }
      }
    }
    state.selectedIds = newSel;
    clearLasso();
    recomputeBBoxFromSelection();
    onLassoComplete && onLassoComplete({ selected: newSel.size > 0 });
  }

  // ---------- event target routing ----------
  function classifyTarget(e) {
    if (!state.active) return 'none';
    let el = e.target;
    while (el && el !== svg) {
      if (el.dataset && el.dataset.handle) {
        return el.dataset.handle; // 'nw' | ... | 'delete'
      }
      if (el === bboxRect) return 'move';
      el = el.parentNode;
    }
    return 'canvas';
  }

  // ---------- drag / resize math ----------
  function applyMovePreview(dx, dy) {
    state.lastTransform = { kind: 'move', dx, dy };
    // A selection can be pure non-stroke shapes now (delta #34), and an
    // empty preview still clears the world-sized preview canvas every
    // frame — expensive for nothing on iPad (see stroke.js delta #28).
    if (state.selectedIds.size) {
      strokeEngine.previewTransform(state.selectedIds, state.lastTransform);
    }
    // update bbox view live
    const b = state.bboxAtDragStart;
    state.bbox = { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };
    updateBBoxView();
    if (onDragMove) onDragMove({ kind: 'move', dx, dy });
  }

  function applyResizePreview(handle, cursor) {
    const b = state.bboxAtDragStart;
    // Anchor is the opposite corner/edge.
    const hspec = HANDLE_SPEC.find((h) => h.name === handle);
    const ax = b.x + b.w * (1 - hspec.sx);
    const ay = b.y + b.h * (1 - hspec.sy);
    // Original handle position in page space:
    const hx0 = b.x + b.w * hspec.sx;
    const hy0 = b.y + b.h * hspec.sy;

    const locksX = hspec.sx === 0.5;
    const locksY = hspec.sy === 0.5;

    // Proportional resize: a single uniform scale factor drives both
    // axes regardless of which handle the user grabbed. For corners
    // we project the cursor onto the line from the anchor to the
    // original handle position — the natural diagonal feel. For edge
    // mid-handles, the active axis's signed scale propagates to the
    // locked axis so both grow / shrink together.
    let s;
    if (locksX && !locksY) {
      s = (cursor.y - ay) / (hy0 - ay || 1);
    } else if (locksY && !locksX) {
      s = (cursor.x - ax) / (hx0 - ax || 1);
    } else {
      const dx = cursor.x - ax, dy = cursor.y - ay;
      const ox = hx0 - ax, oy = hy0 - ay;
      const len2 = ox * ox + oy * oy;
      s = (dx * ox + dy * oy) / (len2 || 1);
    }
    // prevent pathological flips/zeroing while still allowing mirroring past the anchor
    if (Math.abs(s) < MIN_SCALE) s = s < 0 ? -MIN_SCALE : MIN_SCALE;
    const sx = s;
    const sy = s;

    state.lastTransform = { kind: 'scale', sx, sy, ax, ay };
    strokeEngine.previewTransform(state.selectedIds, state.lastTransform);

    // compute new bbox from scaled corners
    const nx0 = ax + (b.x - ax) * sx;
    const ny0 = ay + (b.y - ay) * sy;
    const nx1 = ax + (b.x + b.w - ax) * sx;
    const ny1 = ay + (b.y + b.h - ay) * sy;
    state.bbox = {
      x: Math.min(nx0, nx1),
      y: Math.min(ny0, ny1),
      w: Math.abs(nx1 - nx0),
      h: Math.abs(ny1 - ny0),
    };
    updateBBoxView();
  }

  function applyRotatePreview(cursor) {
    const a = state.rotateAnchor;
    if (!a) return;
    const cur = Math.atan2(cursor.y - a.y, cursor.x - a.x);
    const angle = cur - state.rotateStartAngle;
    state.lastTransform = { kind: 'rotate', angle, ax: a.x, ay: a.y };
    strokeEngine.previewTransform(state.selectedIds, state.lastTransform);
    // Rotate the bbox chrome (rect + handles + rotation handle) so
    // visual feedback tracks the strokes during the gesture. The
    // transform is reset on commit; the bbox itself is then recomputed
    // axis-aligned from the rotated points.
    const deg = (angle * 180) / Math.PI;
    bboxGroup.setAttribute('transform', `rotate(${deg} ${a.x} ${a.y})`);
  }

  function commitDrag() {
    const t = state.lastTransform;
    if (!t) return;
    if (!state.selectedIds.size) {
      // Non-stroke-only selection: nothing for the engine to bake, the
      // host already moved its shapes. Just resync the chrome.
      state.lastTransform = null;
      recomputeBBoxFromSelection();
      return;
    }
    if (t.kind === 'move') {
      strokeEngine.commitTransform(state.selectedIds, (x, y) => [x + t.dx, y + t.dy]);
    } else if (t.kind === 'scale') {
      const { sx, sy, ax, ay } = t;
      // Proportional resize: pass the magnitude as the size scale so
      // the engine also widens / narrows the brush stamp itself, not
      // just the point positions. sx === sy in this codepath.
      const sizeScale = Math.abs(sx);
      strokeEngine.commitTransform(state.selectedIds, (x, y) => [
        ax + (x - ax) * sx,
        ay + (y - ay) * sy,
      ], sizeScale);
    } else if (t.kind === 'rotate') {
      const { angle, ax, ay } = t;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      strokeEngine.commitTransform(state.selectedIds, (x, y) => {
        const dx = x - ax, dy = y - ay;
        return [ax + dx * cos - dy * sin, ay + dx * sin + dy * cos];
      });
    }
    state.lastTransform = null;
    recomputeBBoxFromSelection();
  }

  // ---------- pointer handlers ----------
  function onPointerDown(e) {
    if (!state.active) return;
    if (e.button !== undefined && e.button !== 0) return;
    const target = classifyTarget(e);
    if (target === 'none') return;

    try { svg.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();

    const p = clientToSvg(e);
    state.dragPointerId = e.pointerId;
    state.dragStart = p;
    state.bboxAtDragStart = state.bbox ? { ...state.bbox } : null;

    if (target === 'delete') {
      strokeEngine.removeStrokes(state.selectedIds);
      clearSelection();
      state.mode = 'idle';
      state.dragPointerId = null;
      onSelectionDeleted && onSelectionDeleted();
      return;
    }

    if (target === 'move') {
      state.mode = 'move';
      if (onDragStart) onDragStart('move', state.selectedIds);
      return;
    }

    if (target === 'rotate') {
      state.mode = 'rotate';
      const cx = state.bbox ? state.bbox.x + state.bbox.w / 2 : p.x;
      const cy = state.bbox ? state.bbox.y + state.bbox.h / 2 : p.y;
      state.rotateAnchor = { x: cx, y: cy };
      state.rotateStartAngle = Math.atan2(p.y - cy, p.x - cx);
      if (onDragStart) onDragStart('rotate', state.selectedIds);
      return;
    }

    if (HANDLE_SPEC.some((h) => h.name === target)) {
      state.mode = 'resize';
      state.resizeHandle = target;
      if (onDragStart) onDragStart('resize', state.selectedIds);
      return;
    }

    // 'canvas' → start a new lasso
    clearSelection();
    state.mode = 'lasso';
    state.lassoPts = [[p.x, p.y]];
    updateLassoView();
  }

  function onPointerMove(e) {
    if (!state.active) return;
    if (state.mode === 'idle') return;
    if (state.dragPointerId !== null && e.pointerId !== state.dragPointerId) return;

    const p = clientToSvg(e);
    if (state.mode === 'lasso') {
      // sub-pixel thinning for the lasso too
      const last = state.lassoPts[state.lassoPts.length - 1];
      const dx = p.x - last[0], dy = p.y - last[1];
      if (dx * dx + dy * dy >= 1) state.lassoPts.push([p.x, p.y]);
      updateLassoView();
      return;
    }
    if (state.mode === 'marquee') {
      updateMarquee(p);
      return;
    }
    if (state.mode === 'move') {
      applyMovePreview(p.x - state.dragStart.x, p.y - state.dragStart.y);
      return;
    }
    if (state.mode === 'resize') {
      applyResizePreview(state.resizeHandle, p);
      return;
    }
    if (state.mode === 'rotate') {
      applyRotatePreview(p);
      return;
    }
  }

  function onPointerUp(e) {
    if (!state.active) return;
    if (state.dragPointerId !== null && e.pointerId !== state.dragPointerId) return;
    try { svg.releasePointerCapture(e.pointerId); } catch {}
    const prevMode = state.mode;
    state.dragPointerId = null;

    if (prevMode === 'lasso' || prevMode === 'marquee') {
      state.mode = 'idle';
      selectFromLasso();
      return;
    }
    if (prevMode === 'move' || prevMode === 'resize' || prevMode === 'rotate') {
      state.mode = 'idle';
      commitDrag();
      state.resizeHandle = null;
      state.bboxAtDragStart = null;
      state.rotateAnchor = null;
      // Snap the chrome's rotation transform back; the points are
      // baked at their rotated positions and the bbox is recomputed
      // axis-aligned.
      bboxGroup.removeAttribute('transform');
      if (onDragEnd) onDragEnd();
      return;
    }
    state.mode = 'idle';
  }

  function onKeyDown(e) {
    if (!state.active) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedIds.size > 0) {
        e.preventDefault();
        strokeEngine.removeStrokes(state.selectedIds);
        clearSelection();
        onSelectionDeleted && onSelectionDeleted();
      }
    } else if (e.key === 'Escape') {
      clearLasso();
      clearSelection();
      onExit && onExit();
    }
  }

  svg.addEventListener('pointerdown', onPointerDown);
  document.body.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('keydown', onKeyDown);

  return {
    activate() {
      state.active = true;
    },
    deactivate() {
      state.active = false;
      state.mode = 'idle';
      state.dragPointerId = null;
      clearLasso();
      clearSelection();
    },
    // called by the long-press handoff. stroke engine already discarded its
    // aborted stroke; we start a lasso from the anchor point with the same
    // pointerId so subsequent move/up events flow straight into the lasso.
    startLassoAtPointer(pointerId, point) {
      state.active = true;
      state.mode = 'lasso';
      state.dragPointerId = pointerId;
      state.dragStart = point;
      state.bboxAtDragStart = null;
      clearSelection();
      state.lassoPts = [[point.x, point.y]];
      updateLassoView();
      try { svg.setPointerCapture(pointerId); } catch {}
    },
    // Hush delta #33: same handoff for the rectangle marquee. A single
    // finger drifting in pen mode (stroke.js) lands here with the
    // contact's anchor point; move / up events for that pointerId then
    // flow through the shared lasso path.
    startMarqueeAtPointer(pointerId, point) {
      state.active = true;
      state.mode = 'marquee';
      state.dragPointerId = pointerId;
      state.dragStart = point;
      state.bboxAtDragStart = null;
      clearSelection();
      state.marqueeAnchor = { x: point.x, y: point.y };
      state.lassoPts = [[point.x, point.y]];
      updateLassoView();
      try { svg.setPointerCapture(pointerId); } catch {}
    },
    hasSelection() {
      return state.selectedIds.size > 0;
    },
    // True while a lasso / marquee is mid-gesture. The host's selection
    // bridge checks this before pushing a selection down: an update
    // that lands now would clear the in-flight polygon.
    isRegionActive() {
      return state.mode === 'lasso' || state.mode === 'marquee';
    },
    getSelectedIds() {
      return state.selectedIds;
    },
    // Call after a retroactive mutation (size, etc.) to refresh the dashed
    // bounding box and handle positions so they track the new geometry.
    refreshBBox() {
      recomputeBBoxFromSelection();
    },
    // Abort an in-progress lasso/move/resize without mutating strokes. Called
    // by the gesture recogniser when a second touch promotes the interaction
    // from "lasso" to "multi-finger gesture".
    // Hush-side bridge: when the user selects strokes via the regular
    // Select tool (not lasso), set the engine's bbox / handles so
    // resize + rotate work without entering pen-select mode. The
    // svg is left non-capturing so empty-canvas clicks still fall
    // through to Hush's input layer; only the painted handles + bbox
    // (CSS `pointer-events: auto`) are interactive.
    setSelectedIds(ids) {
      const next = ids instanceof Set ? new Set(ids) : new Set(ids || []);
      // Filter to ids that actually exist in the engine.
      const present = new Set();
      for (const s of strokeEngine.getStrokes()) if (next.has(s.id)) present.add(s.id);
      state.selectedIds = present;
      if (present.size === 0 && !state.extraBBox) {
        clearSelection();
      } else {
        recomputeBBoxFromSelection();
      }
    },
    // Hush delta #34: bounds of the selected shapes the engine doesn't
    // own (text, images, drag-areas), in engine-local coords. Unioned
    // into the bbox so the chrome frames the whole selection and a
    // bbox grab moves all of it; pass null when the selection is pure
    // strokes. Call before setSelectedIds so one recompute sees both.
    setExternalBounds(bbox) {
      state.extraBBox = bbox ? { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h } : null;
      recomputeBBoxFromSelection();
    },
    // Hush delta #34: hide the resize + rotate handles while keeping
    // the bbox. Set when the selection reaches past what the engine can
    // transform — scaling would move the strokes and leave the text
    // shapes at their original size.
    setHandlesHidden(hidden) {
      state.handlesHidden = !!hidden;
      updateBBoxView();
    },
    // Toggle whether the bbox rect itself absorbs clicks. The handles
    // and rotate handle stay interactive regardless; this only
    // controls the dashed body. Pen-mode lasso uses bbox-as-grab to
    // move the selection (auto). Hush's regular Select tool wants the
    // bbox transparent so click-and-drag on a stroke routes through
    // Hush's normal drag handler — without this, the bbox covers the
    // strokes underneath and steals the gesture.
    setBboxClickable(enabled) {
      bboxRect.style.pointerEvents = enabled ? 'auto' : 'none';
    },
    // Hide the bbox + handles without dropping selectedIds, so the
    // engine's retroactive-style path (`hasSelection`, `getSelectedIds`)
    // keeps working while the user is in pen+draw/erase/slice. Also
    // marks the engine inactive so pointer routing falls back to
    // 'none' and gestures don't fire on invisible handles.
    setChromeHidden(hidden) {
      state.chromeHidden = !!hidden;
      if (hidden) state.active = false;
      updateBBoxView();
    },
    // Toggle whether the bbox + handles capture pointer events. When
    // disabled the chrome stays painted (the user can still see what's
    // selected) but every pointerdown falls through to the stroke
    // engine — used by pen+draw/erase/slice with a live retroactive
    // selection so the user can keep tweaking brush settings against
    // a visible selection without the handles intercepting their next
    // stroke.
    setChromeInteractive(enabled) {
      bboxGroup.style.pointerEvents = enabled ? '' : 'none';
    },
    // Softer counterpart to activate/deactivate: toggles whether the
    // engine listens for pointer events without touching the
    // selection set or bbox. Used by drawing-layer.setTool to disable
    // lasso/bbox event capture when the user picks a non-select
    // sub-tool, while leaving any retroactive selection alive so the
    // brush flyout can keep restyling it.
    setEventActive(active) {
      state.active = !!active;
      if (!active) {
        state.mode = 'idle';
        state.dragPointerId = null;
        clearLasso();
      }
    },
    // External-drag bridge: lets Hush's drag pipeline (which mutates
    // state.shapes per pointermove for non-stroke selection chrome)
    // hide the engine's bbox + handles for the duration. We hide
    // rather than track because the symmetry with engine-driven
    // drags (where Hush hides its own chrome) reads better than two
    // bboxes trying to follow the same gesture along slightly
    // different paths.
    beginExternalDrag() {
      state.externalDragging = true;
      updateBBoxView();
    },
    endExternalDrag() {
      // Hush's commit has already moved the underlying stroke points
      // via engine.commitTransform; recompute against them so the
      // bbox lines up with the strokes' final positions, then unhide.
      state.externalDragging = false;
      recomputeBBoxFromSelection();
    },
    cancelActive() {
      const wasDragging = state.mode === 'move' || state.mode === 'resize' || state.mode === 'rotate';
      const wasRegion = state.mode === 'lasso' || state.mode === 'marquee';
      if (state.mode === 'idle') return;
      // If a live preview transform is applied, undo it in the DOM.
      if (wasDragging) {
        strokeEngine.previewTransform(state.selectedIds, null);
        state.lastTransform = null;
        bboxGroup.removeAttribute('transform');
        recomputeBBoxFromSelection();
      }
      state.mode = 'idle';
      state.dragPointerId = null;
      state.resizeHandle = null;
      state.bboxAtDragStart = null;
      state.rotateAnchor = null;
      clearLasso();
      if (wasDragging && onDragEnd) onDragEnd(true);
      // A gesture stole the region before it resolved — nothing was
      // selected, so the host's transient select mode has to unwind or
      // the user is stranded out of their brush.
      if (wasRegion && onRegionCancel) onRegionCancel();
    },
  };
}
