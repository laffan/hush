/**
 * The timer ring's drag. A press that travels `DRAG_SLOP` moves the ring
 * and, on release, keeps it there (`settings.timer.ring`, measured from
 * the left and bottom edges so it stays in its corner as the window
 * resizes); one that doesn't is a click. Until it is first dragged, the
 * ring sits at its stylesheet default — as far from the left edge as
 * from the bottom, the bottom inset including the iPad's reserved band.
 */
import { ringPosition, setRingPosition } from "./timer-store.js";

const DRAG_SLOP = 4;
/** How much of the ring must stay on screen. */
const KEEP = 12;

function clampTo(ring, left, bottom) {
  const w = ring.offsetWidth || 30, h = ring.offsetHeight || 30;
  return {
    left: Math.round(Math.min(Math.max(left, KEEP - w), window.innerWidth - KEEP)),
    bottom: Math.round(Math.min(Math.max(bottom, KEEP - h), window.innerHeight - KEEP)),
  };
}

/** @returns {() => void} uninstall */
export function installRingDrag(ring, state, onClick) {
  function apply() {
    if (drag) return;
    const pos = ringPosition(state);
    if (!pos) { ring.style.left = ""; ring.style.bottom = ""; return; }
    const c = clampTo(ring, pos.left, pos.bottom);
    ring.style.left = `${c.left}px`;
    ring.style.bottom = `${c.bottom}px`;
  }

  let drag = null;
  ring.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // Keep the caret where it is — the ring is chrome, not a place to type.
    e.preventDefault();
    const r = ring.getBoundingClientRect();
    drag = {
      id: e.pointerId, x: e.clientX, y: e.clientY, moved: false,
      left: r.left, bottom: window.innerHeight - r.bottom,
    };
    try { ring.setPointerCapture(e.pointerId); } catch (_) {}
  });
  ring.addEventListener("mousedown", (e) => e.preventDefault());
  ring.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && dx * dx + dy * dy < DRAG_SLOP * DRAG_SLOP) return;
    drag.moved = true;
    ring.classList.add("dragging");
    const c = clampTo(ring, drag.left + dx, drag.bottom - dy);
    ring.style.left = `${c.left}px`;
    ring.style.bottom = `${c.bottom}px`;
    drag.at = c;
  });
  const end = (e, cancelled) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    ring.classList.remove("dragging");
    if (d.moved && d.at) void setRingPosition(state, d.at);
    else if (!cancelled) onClick();
  };
  ring.addEventListener("pointerup", (e) => end(e, false));
  ring.addEventListener("pointercancel", (e) => end(e, true));
  // Keyboard activation still arrives as a click with no pointer behind it.
  ring.addEventListener("click", (e) => { if (e.detail === 0) onClick(); });

  apply();
  state.on("settings-changed", apply);
  state.on("remote-settings-merged", apply);
  window.addEventListener("resize", apply);
  return () => {
    state.off("settings-changed", apply);
    state.off("remote-settings-merged", apply);
    window.removeEventListener("resize", apply);
  };
}
