/* ============================================================
 * HUSH FORK DELTA LOG (vs. temp-drawing-demo reference):
 *   5. createGestures({ pointToLocal }) — optional resolver used by
 *      clientToLocal. Same contract as stroke.js delta #1.
 *  10. Two-finger drag is now a pan gesture. When two fingers are
 *      down inside the engine surface (where stroke.js would normally
 *      own the touch), a drift above PAN_START_2 promotes the burst
 *      into pan mode and fires onPanStart / onPanMove (client-space
 *      midpoint deltas) / onPanEnd so the notebook camera can track.
 *      Without this, users on iPad couldn't pan while a brush slot
 *      was selected.
 * ============================================================
 *
 * gestures.js — two-/three-finger tap recogniser + two-finger pan.
 *
 * Listens on pointerType === 'touch' only; pen and mouse flow straight
 * through to the stroke / selection engines untouched.
 *
 * Policy for mediating with an in-flight stroke:
 *   1. A touch landing alone starts (or continues) a normal stroke.
 *   2. If a second touch lands within SIMULTANEITY_MS while the first
 *      touch hasn't moved far, we assume this is a gesture, call
 *      strokeEngine.cancelActiveStroke() to discard the nascent stroke,
 *      and from then on treat all active touches as gesture candidates.
 *   3. While in gesture mode with ≥2 fingers, a drift past PAN_START_2
 *      flips us into pan mode for the duration of the burst. Pan mode
 *      skips tap evaluation on release — a pan is never also an undo.
 *   4. On pointerup (not in pan mode), each touch is scored as a "tap"
 *      if it was short, still, and not too wide (palm). When every
 *      touch has lifted we examine the buffer of recently-ended taps:
 *         - 2 taps within range and within simultaneity → onUndo
 *         - 3 taps within range and within simultaneity → onRedo
 *
 * Width-based palm rejection uses pointer event's `width`/`height` —
 * iPadOS Safari reports these in CSS pixels for touch contacts.
 * ============================================================ */

const SIMULTANEITY_MS = 180;       // max time between the first and last contact landing
const TAP_MAX_MS = 280;            // max duration from down to up for a tap
const MOVE_TOLERANCE_2 = 64;       // (8 CSS px)^2 — any contact that drifts more is not a tap
// Promotion threshold from "candidate tap" into "pan". Slightly above
// MOVE_TOLERANCE_2 so a two-finger tap with a bit of shake still lands
// as an undo.
const PAN_START_2 = 144;           // (12 CSS px)^2
const MIN_PAIR_DIST = 25;          // min distance between two fingertips (prevents accidental doubles)
const MAX_PAIR_DIST = 320;         // max distance (rejects spread palm contacts)
// iPadOS reports contact ellipses larger than iPhone: ~40–80 CSS px for
// a fingertip vs ~20–40 on the phone. 90 comfortably accepts an iPad
// fingertip while still rejecting a palm (typically 140+).
const MAX_CONTACT_SIZE = 90;

export function createGestures({
  getRect,
  pointToLocal,    // optional (clientPt) => localPt; see createStrokeEngine
  strokeEngine,
  selectionEngine,
  onUndo,
  onRedo,
  onPanStart,      // () => void — two-finger drift crossed PAN_START_2
  onPanMove,       // (dx, dy) => void — midpoint delta from pan-start, in client px
  onPanEnd,        // () => void — every touch has lifted after a pan
}) {
  const toLocal = pointToLocal || ((p) => {
    const r = getRect();
    return { x: p.x - r.left, y: p.y - r.top };
  });
  // Active (finger currently down) touches.
  const active = new Map();        // pointerId -> record
  // Recently-ended (finger lifted but still in simultaneity window) tap records.
  const endedTaps = [];
  // First-contact timestamp of the current "gesture window". Reset when active empties.
  let windowStart = 0;
  // True once we've decided the current touch burst is a gesture rather than a stroke.
  let gestureMode = false;
  // True once the two-finger drift has crossed PAN_START_2. Pan and
  // tap are mutually exclusive for a single burst.
  let panning = false;
  // Client-space midpoint snapshot at pan-start, used as the frame of
  // reference for subsequent onPanMove deltas.
  let panStartMid = null;

  function now() { return performance.now(); }

  function clientToLocal(e) {
    return toLocal({ x: e.clientX, y: e.clientY });
  }

  function isTouch(e) { return e.pointerType === 'touch'; }

  function resetBurst() {
    active.clear();
    endedTaps.length = 0;
    windowStart = 0;
    gestureMode = false;
    panning = false;
    panStartMid = null;
  }

  /** Average clientX/clientY of currently-active contacts. Returns
   *  null when the map is empty. */
  function midClient() {
    if (active.size === 0) return null;
    let sx = 0, sy = 0;
    for (const r of active.values()) { sx += r.clientX; sy += r.clientY; }
    return { x: sx / active.size, y: sy / active.size };
  }

  function qualifiesAsTap(rec) {
    if (rec.tooBig) return false;
    if (rec.moved2 > MOVE_TOLERANCE_2) return false;
    if (rec.up - rec.down > TAP_MAX_MS) return false;
    return true;
  }

  function pairwiseInRange(records) {
    for (let i = 0; i < records.length; i++) {
      for (let j = i + 1; j < records.length; j++) {
        const dx = records[i].x - records[j].x;
        const dy = records[i].y - records[j].y;
        const d2 = dx * dx + dy * dy;
        if (d2 < MIN_PAIR_DIST * MIN_PAIR_DIST) return false;
        if (d2 > MAX_PAIR_DIST * MAX_PAIR_DIST) return false;
      }
    }
    return true;
  }

  function evaluateBurst() {
    // Called when active map empties. Decide whether the accumulated
    // endedTaps form a recognised gesture.
    if (endedTaps.length < 2) { resetBurst(); return; }

    // All contacts must have landed within the simultaneity window.
    let firstDown = Infinity, lastDown = -Infinity;
    for (const r of endedTaps) {
      if (r.down < firstDown) firstDown = r.down;
      if (r.down > lastDown) lastDown = r.down;
    }
    if (lastDown - firstDown > SIMULTANEITY_MS) { resetBurst(); return; }

    if (!pairwiseInRange(endedTaps)) { resetBurst(); return; }

    if (endedTaps.length === 2) {
      onUndo && onUndo();
    } else if (endedTaps.length === 3) {
      onRedo && onRedo();
    }
    // 4+ fingers: ignore (could be a bigger gesture someday).
    resetBurst();
  }

  function onPointerDown(e) {
    if (!isTouch(e)) return;
    const t = now();
    const p = clientToLocal(e);
    const big = (e.width || 0) > MAX_CONTACT_SIZE || (e.height || 0) > MAX_CONTACT_SIZE;

    if (active.size === 0) {
      windowStart = t;
      gestureMode = false;
    }

    const isFollowup = active.size >= 1 && (t - windowStart) <= SIMULTANEITY_MS;

    active.set(e.pointerId, {
      id: e.pointerId,
      x: p.x,
      y: p.y,
      startX: p.x,
      startY: p.y,
      clientX: e.clientX,
      clientY: e.clientY,
      down: t,
      up: 0,
      moved2: 0,
      tooBig: big,
    });

    // Second+ contact within the simultaneity window → we're in a gesture.
    // Swallow the event so stroke.js never sees it (and doesn't start a
    // stroke on the follow-up finger) and discard any touch-started stroke
    // that was spawned when finger #1 landed.
    if (isFollowup) {
      e.stopImmediatePropagation();
      if (!gestureMode) {
        gestureMode = true;
        strokeEngine.cancelActiveStroke();
        if (selectionEngine && selectionEngine.cancelActive) selectionEngine.cancelActive();
      }
    }
  }

  function onPointerMove(e) {
    if (!isTouch(e)) return;
    const rec = active.get(e.pointerId);
    if (!rec) return;
    const p = clientToLocal(e);
    const dx = p.x - rec.startX, dy = p.y - rec.startY;
    const d2 = dx * dx + dy * dy;
    if (d2 > rec.moved2) rec.moved2 = d2;
    rec.clientX = e.clientX;
    rec.clientY = e.clientY;
    if ((e.width || 0) > MAX_CONTACT_SIZE || (e.height || 0) > MAX_CONTACT_SIZE) {
      rec.tooBig = true;
    }
    // Promote to pan the first time any two-finger contact drifts past
    // the pan threshold. The drift check uses engine-local coords (it's
    // fine — we just need "did fingers move meaningfully?"); pan
    // deltas themselves are computed in client space so the notebook
    // camera translates 1:1 with the user's finger motion.
    if (gestureMode && !panning && active.size >= 2) {
      let trigger = false;
      for (const r of active.values()) {
        if (r.moved2 > PAN_START_2) { trigger = true; break; }
      }
      if (trigger) {
        panning = true;
        panStartMid = midClient();
        onPanStart && onPanStart();
      }
    }
    if (panning) {
      const mid = midClient();
      if (mid && panStartMid) {
        onPanMove && onPanMove(mid.x - panStartMid.x, mid.y - panStartMid.y);
      }
    }
  }

  function onPointerUp(e) {
    if (!isTouch(e)) return;
    const rec = active.get(e.pointerId);
    if (!rec) return;
    rec.up = now();
    active.delete(e.pointerId);

    // Panning disqualifies the whole burst from being any tap gesture —
    // we don't want a long two-finger drag to also fire an undo.
    if (!panning && gestureMode && qualifiesAsTap(rec)) {
      endedTaps.push(rec);
    }
    // Pan ends on the first lift: remaining fingers fall back to no
    // gesture (stroke/selection engines won't reactivate mid-burst
    // because stroke.js keys off its own pointerdown, which we've
    // already swallowed). The user can start a new pan by lifting all
    // fingers and re-landing two.
    if (panning) {
      panning = false;
      panStartMid = null;
      onPanEnd && onPanEnd();
    }

    if (active.size === 0) {
      if (gestureMode) evaluateBurst();
      else resetBurst();
    }
  }

  function onPointerCancel(e) {
    if (!isTouch(e)) return;
    active.delete(e.pointerId);
    if (active.size === 0) resetBurst();
  }

  // Use capture phase so we observe every touch regardless of which
  // element ends up the target. We don't preventDefault — the stroke
  // and selection engines still need to see these events.
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', onPointerCancel, true);

  return {
    isGesturing: () => gestureMode,
  };
}
