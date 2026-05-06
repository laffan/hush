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
 *  12. Two-finger pinch fires onPinchStart / onPinchMove / onPinchEnd
 *      with client-space midpoint + spread distance. Runs alongside
 *      pan so the user can pan and zoom in the same gesture.
 *  13. Followup gating fires on any second contact (palms are filtered
 *      out before the active map even sees them, see below) so
 *      2-finger pan / pinch can engage while the user is actively
 *      drawing — cancelling the in-flight stroke on landing, since the
 *      gesture is the more recent intent. SIMULTANEITY_MS bumped from
 *      180→600 ms because natural fast 2-finger taps on iPad routinely
 *      have ~250 ms inter-finger lag.
 *  17. Palms (`width|height > MAX_CONTACT_SIZE`) are NOT added to the
 *      active map. iPad palm rejection sometimes drops the pointerup
 *      for a contact the system has already won, leaving a phantom
 *      entry that broke `active.size === 0` resets and inflated
 *      gesture-detection counts. Plus a stale-entry sweep on every
 *      pointerdown drops any contact older than STALE_ENTRY_MS as a
 *      backstop against missed lifts.
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

// Hush delta #13: SIMULTANEITY_MS bumped from 180→350 ms (and now to
// 600 ms for the inter-landing window only — the gestureMode trigger
// no longer requires it, see header).
const SIMULTANEITY_MS = 600;       // max time between the first and last contact landing.
                                   // Was 180 — too tight: a natural fast 2-finger tap on iPad
                                   // routinely has 200–500 ms of inter-finger lag, and the gap
                                   // landed each finger's pointerdown as a separate stroke
                                   // (the user saw a tiny line drawn instead of an undo).
const TAP_MAX_MS = 280;            // max duration from down to up for a tap
const MOVE_TOLERANCE_2 = 64;       // (8 CSS px)^2 — any contact that drifts more is not a tap
// Hush delta #10: promotion threshold from "candidate tap" into "pan".
// Slightly above MOVE_TOLERANCE_2 so a two-finger tap with a bit of
// shake still lands as an undo.
const PAN_START_2 = 144;           // (12 CSS px)^2
// Minimum change in finger-spread distance (CSS px) before we promote
// the burst into pinch-zoom mode. Mirrors PAN_START in spirit — a
// little hand jitter shouldn't fire a zoom.
const PINCH_START = 12;
const MIN_PAIR_DIST = 25;          // min distance between two fingertips (prevents accidental doubles)
const MAX_PAIR_DIST = 320;         // max distance (rejects spread palm contacts)
// iPadOS reports contact ellipses larger than iPhone: ~40–80 CSS px for
// a fingertip vs ~20–40 on the phone. 90 comfortably accepts an iPad
// fingertip while still rejecting a palm (typically 140+).
const MAX_CONTACT_SIZE = 90;
// Stale-entry cutoff: any tracked contact older than this on a fresh
// pointerdown is treated as orphaned (palm rejection sometimes drops
// the corresponding pointerup/cancel) and pruned before the new
// contact is processed. 5 s is well past any legitimate gesture
// window — even a slow 3-finger redo lands within ~1 s.
const STALE_ENTRY_MS = 5000;

export function createGestures({
  getRect,
  pointToLocal,    // Hush delta #5: optional (clientPt) => localPt; mirror of stroke.js delta #1
  strokeEngine,
  selectionEngine,
  onUndo,
  onRedo,
  onPanStart,      // Hush delta #10: () => void — two-finger drift crossed PAN_START_2
  onPanMove,       // Hush delta #10: (dx, dy) => void — midpoint delta from pan-start, in client px
  onPanEnd,        // Hush delta #10: () => void — every touch has lifted after a pan
  onPinchStart,    // Hush delta #12: (mid, dist) => void — finger spread changed past PINCH_START
  onPinchMove,     // Hush delta #12: (mid, dist) => void — current midpoint + spread (client px)
  onPinchEnd,      // Hush delta #12: () => void — every touch has lifted after a pinch
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
  // True once the finger-spread has changed past PINCH_START. Pinch
  // runs in parallel with pan — the user is typically doing both — so
  // we don't gate one on the other; both fire while two fingers move.
  let pinching = false;
  // Spread distance at pinch-start; the client of onPinchMove computes
  // its own ratio against the start dist it captured in onPinchStart.
  let pinchStartDist = 0;

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
    pinching = false;
    pinchStartDist = 0;
  }

  /** Average clientX/clientY of currently-active contacts. Returns
   *  null when the map is empty. */
  function midClient() {
    if (active.size === 0) return null;
    let sx = 0, sy = 0;
    for (const r of active.values()) { sx += r.clientX; sy += r.clientY; }
    return { x: sx / active.size, y: sy / active.size };
  }

  /** Distance between the first two active contacts (the only two we
   *  care about for pinch). Returns 0 if fewer than 2 fingers down. */
  function pairDistClient() {
    if (active.size < 2) return 0;
    const it = active.values();
    const a = it.next().value, b = it.next().value;
    const dx = a.clientX - b.clientX, dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
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

    // Prune any orphaned entries before deciding what kind of contact
    // this is. iPad palm rejection occasionally drops the pointerup /
    // pointercancel for a touch the system has already "won", which
    // strands its record in `active` and breaks every gesture that
    // depends on `active.size === 0` to reset state. After 5 s without
    // a follow-up event the contact is definitely stale.
    if (active.size > 0) {
      for (const [pid, rec] of active) {
        if (t - rec.down > STALE_ENTRY_MS) active.delete(pid);
      }
      if (active.size === 0) {
        // Whole map was stale — fall through to the fresh-burst reset
        // below as if nothing had been tracked.
        gestureMode = false;
        panning = false;
        panStartMid = null;
        pinching = false;
        pinchStartDist = 0;
        endedTaps.length = 0;
      }
    }

    // Palms (`big`) are intentionally excluded from `active` entirely.
    // Tracking them here would (a) inflate `active.size` so a subsequent
    // single-finger pan would look like a 2-finger gesture, and (b)
    // strand state when the system cancels the palm without firing
    // pointerup. They still flow through to stroke.js's bubble-phase
    // listener, where its own MAX_CONTACT_SIZE check rejects them.
    if (big) return;

    if (active.size === 0) {
      windowStart = t;
      gestureMode = false;
    }

    // Followup (= "this is part of a multi-touch gesture") fires whenever
    // a second small contact lands while another is already down — even
    // mid-stroke. The original gate also required the first finger to
    // be still, so 2-finger pan couldn't engage while the user was
    // actively drawing; this version drops that to enable pan-during-
    // draw, accepting that a deliberate second finger cancels the
    // in-flight stroke (the user's gesture is the more recent intent).
    // We deliberately don't gate on SIMULTANEITY_MS here — that window
    // covers the *evaluation* step (see evaluateBurst). Plenty of
    // users tap with 400–500 ms of inter-finger lag; a strict pre-gate
    // dropped those.
    const isFollowup = active.size >= 1;

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
      tooBig: false,
    });

    // Second+ contact while finger #1 is stable → we're in a gesture.
    // Swallow the event so stroke.js never sees it (and doesn't start a
    // stroke on the follow-up finger) and discard any touch-started stroke
    // that was spawned when finger #1 landed. Once gestureMode is on,
    // every subsequent finger also gets swallowed for the duration of
    // the burst so a 3-finger redo doesn't accidentally land a third
    // stroke when the third finger arrives later.
    if (isFollowup || gestureMode) {
      e.stopImmediatePropagation();
      if (!gestureMode) {
        gestureMode = true;
        strokeEngine.cancelActiveStroke();
        if (selectionEngine && selectionEngine.cancelActive) selectionEngine.cancelActive();
      } else {
        // Already in gesture mode; make sure no stroke leaked in
        // between fingers (e.g. after my own onPointerDown ran for
        // an earlier finger that wasn't yet known to be a gesture).
        strokeEngine.cancelActiveStroke();
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

    // Pinch: kicks in once the spread has drifted past PINCH_START.
    // Captures the start distance the first time it fires so callers
    // can compute their own scale factor. Runs alongside pan — a
    // typical iPad zoom is "spread + drift" simultaneously.
    if (gestureMode && active.size >= 2) {
      const dist = pairDistClient();
      if (!pinching) {
        // Need a non-trivial reference so the ratio is meaningful;
        // pairDistClient is recomputed each move so we don't latch a
        // start distance until two fingers have separated a bit.
        if (dist > 0) {
          // Latch the very first non-zero spread reading as the
          // baseline. Subsequent moves measure their drift against it.
          if (pinchStartDist === 0) pinchStartDist = dist;
          if (Math.abs(dist - pinchStartDist) > PINCH_START) {
            pinching = true;
            const mid = midClient();
            onPinchStart && onPinchStart(mid, pinchStartDist);
          }
        }
      }
      if (pinching) {
        const mid = midClient();
        onPinchMove && onPinchMove(mid, dist);
      }
    }
  }

  function onPointerUp(e) {
    if (!isTouch(e)) return;
    const rec = active.get(e.pointerId);
    if (!rec) return;
    rec.up = now();
    active.delete(e.pointerId);

    // Panning / pinching disqualifies the whole burst from being any
    // tap gesture — we don't want a long two-finger drag or a pinch
    // zoom to also fire an undo.
    if (!panning && !pinching && gestureMode && qualifiesAsTap(rec)) {
      endedTaps.push(rec);
    }
    // Pan / pinch end on the first lift: remaining fingers fall back
    // to no gesture (stroke/selection engines won't reactivate
    // mid-burst because stroke.js keys off its own pointerdown, which
    // we've already swallowed). The user can start a new pan/pinch by
    // lifting all fingers and re-landing two.
    if (panning) {
      panning = false;
      panStartMid = null;
      onPanEnd && onPanEnd();
    }
    if (pinching) {
      pinching = false;
      pinchStartDist = 0;
      onPinchEnd && onPinchEnd();
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
