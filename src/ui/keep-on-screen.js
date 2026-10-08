/**
 * Keeping a thing that floats over the window — the wall clock, the
 * timer's ring — on screen when the window changes under it: a resize,
 * an iPad turned on its side, a window moved to a smaller display, a
 * spot dragged on a big screen arriving on a small one with the settings.
 *
 * A spot is stored as the thing's top-left in the window it was put in,
 * along with that window's size (`vw`, `vh`). In a window of another
 * size it keeps its distance from the edges nearest it there — one
 * dragged into the lower right stays in the lower right, rather than
 * being pushed against whichever edge its old coordinates now overshoot
 * — and it is then held wholly inside the window, clear of the iPad's
 * reserved bands at the top and bottom. A spot stored without the
 * window's size (from before it was kept) is only held inside.
 *
 * Nothing is written back: turn the iPad round again and the thing is
 * where it was put.
 */

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** The window's size, less the bands the iPad reserves (base.css). */
function screenArea() {
  const cs = getComputedStyle(document.documentElement);
  const px = (name) => parseFloat(cs.getPropertyValue(name)) || 0;
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    top: px("--ipad-safe-top"),
    bottom: px("--ipad-safe-bottom"),
  };
}

/** The window's size, to store beside a spot as it is put down. */
export function windowSize() {
  return { vw: window.innerWidth, vh: window.innerHeight };
}

/**
 * Where a `w` × `h` thing stored at `spot` ({ x, y, vw?, vh? }, its
 * top-left) goes in the window as it is now, `edge` px in from every
 * side. Returns `{ x, y }`.
 */
export function fitSpot(spot, w, h, edge = 4) {
  const area = screenArea();
  let { x, y } = spot;
  if (spot.vw > 0 && spot.vw !== area.width && x + w / 2 > spot.vw / 2) x = area.width - (spot.vw - x);
  if (spot.vh > 0 && spot.vh !== area.height && y + h / 2 > spot.vh / 2) y = area.height - (spot.vh - y);
  const minY = edge + area.top;
  return {
    x: Math.round(clamp(x, edge, Math.max(edge, area.width - w - edge))),
    y: Math.round(clamp(y, minY, Math.max(minY, area.height - h - edge - area.bottom))),
  };
}

/**
 * Call `fn` whenever the window may have changed size: a resize, a turn
 * of the iPad, and the app coming back to the front (it may have been
 * turned while it was away). An orientation change can report the old
 * size while the turn is still under way, so it is checked again a
 * moment later. Returns the uninstall.
 */
export function onScreenChange(fn) {
  let again = 0;
  const twice = () => {
    fn();
    clearTimeout(again);
    again = setTimeout(fn, 300);
  };
  const visible = () => { if (document.visibilityState === "visible") twice(); };
  window.addEventListener("resize", fn);
  window.addEventListener("orientationchange", twice);
  document.addEventListener("visibilitychange", visible);
  return () => {
    clearTimeout(again);
    window.removeEventListener("resize", fn);
    window.removeEventListener("orientationchange", twice);
    document.removeEventListener("visibilitychange", visible);
  };
}
