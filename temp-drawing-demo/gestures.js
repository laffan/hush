/* ============================================================
 * gestures.js — two- and three-finger tap recogniser.
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
 *   3. On pointerup, each touch is scored as a "tap" if it was short,
 *      still, and not too wide (palm). When every touch has lifted we
 *      examine the buffer of recently-ended taps:
 *         - 2 taps within range and within simultaneity → onUndo
 *         - 3 taps within range and within simultaneity → onRedo
 *
 * Width-based palm rejection uses pointer event's `width`/`height` —
 * iPadOS Safari reports these in CSS pixels for touch contacts.
 * ============================================================ */

const SIMULTANEITY_MS = 180;       // max time between the first and last contact landing
const TAP_MAX_MS = 280;            // max duration from down to up for a tap
const MOVE_TOLERANCE_2 = 64;       // (8 CSS px)^2 — any contact that drifts more is not a tap
const MIN_PAIR_DIST = 25;          // min distance between two fingertips (prevents accidental doubles)
const MAX_PAIR_DIST = 320;         // max distance (rejects spread palm contacts)
// iPadOS reports contact ellipses larger than iPhone: ~40–80 CSS px for
// a fingertip vs ~20–40 on the phone. 90 comfortably accepts an iPad
// fingertip while still rejecting a palm (typically 140+).
const MAX_CONTACT_SIZE = 90;

export function createGestures({
  getRect,
  strokeEngine,
  selectionEngine,
  onUndo,
  onRedo,
}) {
  // Active (finger currently down) touches.
  const active = new Map();        // pointerId -> record
  // Recently-ended (finger lifted but still in simultaneity window) tap records.
  const endedTaps = [];
  // First-contact timestamp of the current "gesture window". Reset when active empties.
  let windowStart = 0;
  // True once we've decided the current touch burst is a gesture rather than a stroke.
  let gestureMode = false;

  function now() { return performance.now(); }

  function clientToLocal(e) {
    const r = getRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function isTouch(e) { return e.pointerType === 'touch'; }

  function resetBurst() {
    active.clear();
    endedTaps.length = 0;
    windowStart = 0;
    gestureMode = false;
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
    if ((e.width || 0) > MAX_CONTACT_SIZE || (e.height || 0) > MAX_CONTACT_SIZE) {
      rec.tooBig = true;
    }
    // If we're already in gesture mode and a finger drifts far, the whole
    // burst stops being a tap — but we still wait for all fingers to lift
    // before resetting, so we don't mis-feed the stroke engine mid-drag.
  }

  function onPointerUp(e) {
    if (!isTouch(e)) return;
    const rec = active.get(e.pointerId);
    if (!rec) return;
    rec.up = now();
    active.delete(e.pointerId);

    if (gestureMode && qualifiesAsTap(rec)) {
      endedTaps.push(rec);
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
