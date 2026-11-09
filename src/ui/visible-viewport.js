/**
 * The part of the window the user can actually see, in the coordinates
 * `position: fixed` uses (the layout viewport).
 *
 * On an iPhone the on-screen keyboard does not shrink the layout
 * viewport — `innerHeight` still reports the whole screen — it shrinks
 * the *visual* viewport. A popup that flips above its anchor only when
 * it would cross `innerHeight` therefore opened straight under the
 * keyboard, and a `[[` search typed near the middle of the screen looked
 * like it had never appeared. Everything that places a popup against
 * the caret measures against this instead.
 */
export function visibleViewport() {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (!vv) return { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
  return {
    top: vv.offsetTop,
    bottom: vv.offsetTop + vv.height,
    left: vv.offsetLeft,
    right: vv.offsetLeft + vv.width,
  };
}

/**
 * Place a fixed popup `el` under (or, failing that, over) `rect`, inside
 * the visible viewport. When neither side has room for its natural
 * height it takes the roomier side and its `max-height` is capped to
 * fit — it scrolls rather than slipping under the keyboard.
 * `maxWidth` is the popup's widest CSS width, used to keep it on screen
 * horizontally. Call after the popup's content is rendered.
 */
export function placePopupAgainst(el, rect, { margin = 4, maxWidth = 360, edge = 8 } = {}) {
  const vp = visibleViewport();
  el.style.left = `${Math.max(vp.left + edge, Math.min(rect.left, vp.right - Math.min(maxWidth, vp.right - vp.left - edge * 2) - edge))}px`;
  el.style.maxHeight = "";
  const natural = el.getBoundingClientRect().height;
  const below = vp.bottom - edge - (rect.bottom + margin);
  const above = (rect.top - margin) - (vp.top + edge);
  if (natural <= below || below >= above) {
    el.style.top = `${rect.bottom + margin}px`;
    if (natural > below) el.style.maxHeight = `${Math.max(60, below)}px`;
  } else {
    const h = Math.min(natural, above);
    if (natural > above) el.style.maxHeight = `${Math.max(60, above)}px`;
    el.style.top = `${rect.top - margin - h}px`;
  }
}
