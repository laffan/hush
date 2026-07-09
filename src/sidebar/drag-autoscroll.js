/**
 * Drag auto-scroll for the files panel. While a row drag is in flight,
 * holding the pointer near the top or bottom edge of the panel's scroll
 * area (`.panel-overlay-body`) scrolls it — so a drag that started deep
 * inside a long folder can travel back up to a target above the fold.
 *
 * Runs its own rAF loop: pointermove events stop while the pointer
 * holds still, but the scroll should keep flowing as long as the
 * pointer sits in the edge zone. Callers feed the latest clientY via
 * `updateDragAutoScroll` on every move and must call
 * `stopDragAutoScroll` when the gesture ends.
 */

const EDGE_ZONE = 48; // px from the panel edge where scrolling engages
const MAX_SPEED = 14; // px per frame at the very edge

let _raf = null;
let _lastX = null;
let _lastY = null;

function scrollHost() {
  return document.querySelector("#panel-overlay .panel-overlay-body")
    || document.querySelector(".panel-overlay-body");
}

function tick() {
  _raf = null;
  if (_lastY == null) return;
  const host = scrollHost();
  if (!host) return;
  const rect = host.getBoundingClientRect();
  // Only engage while the pointer is horizontally over the panel (with a
  // little slack) — a cmd-drag headed out to the editor shouldn't scroll
  // the file list underneath it.
  if (_lastX != null && (_lastX < rect.left - 40 || _lastX > rect.right + 40)) return;
  let delta = 0;
  if (_lastY < rect.top + EDGE_ZONE) {
    const t = Math.min(1, (rect.top + EDGE_ZONE - _lastY) / EDGE_ZONE);
    delta = -Math.ceil(t * MAX_SPEED);
  } else if (_lastY > rect.bottom - EDGE_ZONE) {
    const t = Math.min(1, (_lastY - (rect.bottom - EDGE_ZONE)) / EDGE_ZONE);
    delta = Math.ceil(t * MAX_SPEED);
  }
  if (delta !== 0) {
    const before = host.scrollTop;
    host.scrollTop = before + delta;
    // Keep looping while the pointer holds in the zone and there's
    // still runway to scroll.
    if (host.scrollTop !== before) {
      _raf = requestAnimationFrame(tick);
      return;
    }
  }
  // Out of the zone (or pinned at an end) — idle until the next move.
}

/** Feed the latest pointer position of an in-flight drag. */
export function updateDragAutoScroll(clientX, clientY) {
  _lastX = clientX;
  _lastY = clientY;
  if (_raf == null) _raf = requestAnimationFrame(tick);
}

/** End-of-gesture cleanup. */
export function stopDragAutoScroll() {
  _lastX = null;
  _lastY = null;
  if (_raf != null) {
    cancelAnimationFrame(_raf);
    _raf = null;
  }
}
