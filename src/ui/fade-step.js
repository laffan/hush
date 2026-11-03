/**
 * A value stepped from script, frame by frame, for fades a CSS opacity
 * animation must not run: a running opacity animation lifts its element
 * onto a compositing layer, and WebKit repaints the text as it drops back
 * off at the end — the blink Focus Mode's sentence fade had under Zen.
 * Callers write the value into a custom property their CSS reads.
 *
 * Used for the entrance and exit of Focus Mode (editor/plugins/
 * focus-mode.js, `--fm-in`) and Campfire Cursor (campfire/campfire.js,
 * `--cf-in`), at the sentence fade's 300 ms.
 */

export const FADE_MS = 300;

export function prefersReducedMotion() {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/**
 * Step from `from` to `to`, calling `onStep(value)` at once with `from`
 * and then every frame, and `onDone()` once `to` is reached. A partial
 * distance takes its share of `ms`, so a fade turned round half way
 * back takes half as long. Under reduced motion it jumps straight to
 * `to`. Returns a function that stops it where it is (no `onDone`).
 */
export function stepFade(from, to, onStep, onDone, ms = FADE_MS) {
  const span = Math.abs(to - from);
  if (span < 1e-3 || prefersReducedMotion()) {
    onStep(to);
    onDone?.();
    return () => {};
  }
  const dur = ms * Math.min(1, span);
  const start = performance.now();
  let frame = 0;
  onStep(from);
  const tick = () => {
    const t = Math.min(1, (performance.now() - start) / dur);
    onStep(from + (to - from) * ease(t));
    if (t < 1) { frame = requestAnimationFrame(tick); return; }
    frame = 0;
    onDone?.();
  };
  frame = requestAnimationFrame(tick);
  return () => { if (frame) cancelAnimationFrame(frame); frame = 0; };
}
