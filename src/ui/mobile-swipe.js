/**
 * Mobile edge-swipe gestures (phone only).
 *
 * A horizontal swipe that starts near a screen edge opens the matching
 * sidebar — the iOS-native idiom, and starting from the edge keeps the
 * gesture clear of content interactions (editor text selection, notebook
 * canvas panning) which own touches that begin in the body.
 *
 *   • Swipe left → right  : open the files sidebar (left panel).
 *   • Swipe right → left  : open the outline sidebar or shelf — the
 *                           `toggle-outline-panel` handler in main.js
 *                           already routes to the doc outline, notebook
 *                           shelf, PDF annotation shelf, or stack sidebar
 *                           depending on the active file type.
 *
 * The opposite swipe closes whichever panel the user just opened, so the
 * pair reads as a natural open/close toggle.
 */

import { isPhone } from "../settings/settings-ui.js";

// Gesture thresholds. The swipe must start within EDGE_ZONE of a screen
// edge, travel at least MIN_DISTANCE horizontally, stay under MAX_VERTICAL
// of vertical drift (so a diagonal scroll isn't caught), and finish inside
// MAX_DURATION so a slow content drag doesn't register.
const EDGE_ZONE = 36;
const MIN_DISTANCE = 60;
const MAX_VERTICAL = 50;
const MAX_DURATION = 600;

export function initMobileSwipe(state) {
  if (!isPhone()) return;

  let tracking = null;

  function onStart(e) {
    if (e.touches && e.touches.length > 1) { tracking = null; return; }
    const t = e.touches ? e.touches[0] : e;
    const fromLeftEdge = t.clientX <= EDGE_ZONE;
    const fromRightEdge = t.clientX >= window.innerWidth - EDGE_ZONE;
    if (!fromLeftEdge && !fromRightEdge) { tracking = null; return; }
    tracking = {
      x: t.clientX,
      y: t.clientY,
      time: Date.now(),
      fromLeftEdge,
      fromRightEdge,
    };
  }

  function onEnd(e) {
    if (!tracking) return;
    const start = tracking;
    tracking = null;
    const t = (e.changedTouches && e.changedTouches[0]) || e;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Date.now() - start.time > MAX_DURATION) return;
    if (Math.abs(dy) > MAX_VERTICAL) return;
    if (Math.abs(dx) < MIN_DISTANCE) return;

    if (dx > 0 && start.fromLeftEdge) {
      // Left edge, swiped right → open files sidebar.
      openLeftPanel(state);
    } else if (dx < 0 && start.fromRightEdge) {
      // Right edge, swiped left → open outline / shelf by file type.
      openRightPanel(state);
    }
  }

  document.addEventListener("touchstart", onStart, { passive: true });
  document.addEventListener("touchend", onEnd, { passive: true });
  document.addEventListener("touchcancel", () => { tracking = null; }, { passive: true });
}

function openLeftPanel(state) {
  const po = document.getElementById("panel-overlay");
  const hidden = !po || po.classList.contains("hidden");
  if (hidden) state.emit("show-files-panel");
}

function openRightPanel(state) {
  // If the files panel is open, a right→left swipe reads as "put it away"
  // first; otherwise reveal the outline / shelf for the active surface.
  const po = document.getElementById("panel-overlay");
  if (po && !po.classList.contains("hidden")) {
    state.emit("hide-panel");
    return;
  }
  state.emit("toggle-outline-panel");
}
