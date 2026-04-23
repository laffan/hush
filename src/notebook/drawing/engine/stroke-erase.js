/* ============================================================
 * stroke-erase.js (stamped) — slice + whole-stroke eraser.
 *
 * The eraser is a disc. `sliceStrokesAt` splits each touched stroke into
 * the sub-strokes that lie outside the disc; `eraseStrokesAt` drops any
 * stroke whose outline passes within the disc. Both mutate the stroke
 * list in place and rebake only the affected tiles through the renderer.
 *
 * History aggregation: at eraser pointerdown the glue calls
 * beginSliceSession() to snapshot the stroke list; at pointerup
 * endSliceSession() diffs that snapshot against the live list and emits
 * one onStrokesSliced event so the whole drag is a single undo step.
 * ============================================================ */

import {
  bboxIntersectsDisc,
  pointToSegmentDist2,
  sliceStrokePoints,
} from './stroke-geometry.js';

export function createEraseController({ getStrokes, allocId, renderer, onStrokesSliced, isProtected }) {
  let sliceSession = null;
  const protectedFn = isProtected || (() => false);

  // Make a sub-stroke record from a parent stroke and a points array.
  function makeSubStroke(parent, points) {
    return {
      id: allocId(),
      tool: 'draw',
      color: parent.color,
      size: parent.size,
      brush: parent.brush,
      layerId: parent.layerId,
      isPen: parent.isPen,
      points,
    };
  }

  // Whole-stroke eraser: drops any stroke whose outline passes within the
  // eraser disc. Same session/diff pipeline as the slicer (onStrokesSliced
  // with an empty `added` list on commit). This is the classic eraser
  // behavior kept as a separate tool from slice.
  function eraseStrokesAt(cx, cy, eraserR) {
    const strokes = getStrokes();
    const dirty = new Set();
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      if (protectedFn(s)) continue;
      const hit = eraserR + s.size / 2;
      if (!bboxIntersectsDisc(s.bbox, cx, cy, hit)) continue;
      const hit2 = hit * hit;
      const pts = s.points;
      let touched = false;
      if (pts.length === 1) {
        const dx = pts[0].x - cx, dy = pts[0].y - cy;
        touched = (dx * dx + dy * dy) < hit2;
      } else {
        for (let j = 1; j < pts.length; j++) {
          if (pointToSegmentDist2(cx, cy, pts[j - 1].x, pts[j - 1].y, pts[j].x, pts[j].y) < hit2) {
            touched = true;
            break;
          }
        }
      }
      if (!touched) continue;
      if (s.tiles) for (const k of s.tiles) dirty.add(k);
      renderer.removeFromIndex(s);
      strokes.splice(i, 1);
    }
    if (dirty.size) renderer.rebakeTiles(dirty);
  }

  // Slice every stroke whose bbox intersects the eraser disc. Mutates
  // the stroke list + tile index in place; rebakes only the affected tiles.
  // Diffs against the active slice session (if any) are picked up on commit.
  function sliceStrokesAt(cx, cy, eraserR) {
    const strokes = getStrokes();
    const dirty = new Set();
    let i = 0;
    while (i < strokes.length) {
      const s = strokes[i];
      if (protectedFn(s)) { i++; continue; }
      if (!bboxIntersectsDisc(s.bbox, cx, cy, eraserR + s.size / 2)) {
        i++;
        continue;
      }
      const subs = sliceStrokePoints(s, cx, cy, eraserR);
      if (subs === null) {
        i++;
        continue;
      }
      // Stroke was touched. Drop it; insert each sub at the same position.
      if (s.tiles) for (const k of s.tiles) dirty.add(k);
      renderer.removeFromIndex(s);
      strokes.splice(i, 1);
      for (let j = 0; j < subs.length; j++) {
        const child = makeSubStroke(s, subs[j]);
        strokes.splice(i + j, 0, child);
        renderer.addToIndex(child);
        for (const k of child.tiles) dirty.add(k);
      }
      i += subs.length;
    }
    if (dirty.size) renderer.rebakeTiles(dirty);
  }

  function beginSliceSession() {
    const strokes = getStrokes();
    const map = new Map();
    for (let i = 0; i < strokes.length; i++) {
      const s = strokes[i];
      map.set(s.id, { stroke: s, index: i });
    }
    sliceSession = { originalById: map };
  }

  // Diff snapshot against current; emit one onStrokesSliced event. Returns
  // true if any change was committed (caller may want to suppress side-effects
  // when nothing happened).
  function endSliceSession() {
    const sess = sliceSession;
    sliceSession = null;
    if (!sess) return false;
    const strokes = getStrokes();
    const { originalById } = sess;
    const currentIds = new Set();
    const added = [];
    for (let i = 0; i < strokes.length; i++) {
      const s = strokes[i];
      currentIds.add(s.id);
      if (!originalById.has(s.id)) added.push({ stroke: s, finalIndex: i });
    }
    const removed = [];
    for (const [id, entry] of originalById) {
      if (!currentIds.has(id)) removed.push({ stroke: entry.stroke, originalIndex: entry.index });
    }
    if (!removed.length && !added.length) return false;
    removed.sort((a, b) => a.originalIndex - b.originalIndex);
    added.sort((a, b) => a.finalIndex - b.finalIndex);
    if (onStrokesSliced) onStrokesSliced({ removed, added });
    return true;
  }

  function discardSliceSession() {
    sliceSession = null;
  }

  return {
    eraseStrokesAt,
    sliceStrokesAt,
    beginSliceSession,
    endSliceSession,
    discardSliceSession,
  };
}
