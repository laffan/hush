/**
 * The timer ring's drag. A press that travels `DRAG_SLOP` moves the ring
 * and, on release, keeps it there (`settings.timer.ring`, measured from
 * the left and bottom edges, with the size of the window it was put down
 * in); one that doesn't is a click. Until it is first dragged, the ring
 * sits at its stylesheet default — as far from the left edge as from the
 * bottom, the bottom inset including the iPad's reserved band.
 *
 * Wherever it was put, it is kept wholly on screen: in a window of
 * another size — an iPad turned round, a smaller display — it keeps to
 * its corner and inside the window (ui/keep-on-screen.js).
 */
import { ringPosition, setRingPosition } from "./timer-store.js";
import { fitSpot, onScreenChange, windowSize } from "../ui/keep-on-screen.js";

const DRAG_SLOP = 4;
/** Room kept between the ring and the window's edges. */
const EDGE = 6;

/** `{ left, bottom }` for a ring stored at `pos` ({ left, bottom, vw?,
 *  vh? }) in the window as it is now. */
function clampTo(ring, pos) {
  const w = ring.offsetWidth || 30, h = ring.offsetHeight || 30;
  // Its top-left in the window it was put down in (this one, when that
  // size wasn't kept).
  const vh = pos.vh > 0 ? pos.vh : window.innerHeight;
  const { x, y } = fitSpot({ x: pos.left, y: vh - pos.bottom - h, vw: pos.vw, vh: pos.vh }, w, h, EDGE);
  return { left: x, bottom: Math.round(window.innerHeight - y - h) };
}

/** @returns {() => void} uninstall */
export function installRingDrag(ring, state, onClick) {
  function apply() {
    if (drag) return;
    const pos = ringPosition(state);
    if (!pos) { ring.style.left = ""; ring.style.bottom = ""; return; }
    const c = clampTo(ring, pos);
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
    const c = clampTo(ring, { left: drag.left + dx, bottom: drag.bottom - dy });
    ring.style.left = `${c.left}px`;
    ring.style.bottom = `${c.bottom}px`;
    drag.at = c;
  });
  const end = (e, cancelled) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    ring.classList.remove("dragging");
    if (d.moved && d.at) void setRingPosition(state, { ...d.at, ...windowSize() });
    else if (!cancelled) onClick();
  };
  ring.addEventListener("pointerup", (e) => end(e, false));
  ring.addEventListener("pointercancel", (e) => end(e, true));
  // Keyboard activation still arrives as a click with no pointer behind it.
  ring.addEventListener("click", (e) => { if (e.detail === 0) onClick(); });

  apply();
  state.on("settings-changed", apply);
  state.on("remote-settings-merged", apply);
  const offScreen = onScreenChange(apply);
  return () => {
    state.off("settings-changed", apply);
    state.off("remote-settings-merged", apply);
    offScreen();
  };
}
