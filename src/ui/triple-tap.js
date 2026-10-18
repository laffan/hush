/**
 * Three quick taps of one modifier key, with no other key pressed during
 * or between them — the gesture behind Courier (Shift), Write Now
 * (Option) and Edge Lights (Command). `installTripleTapTriggers` (in
 * triple-tap-triggers.js) installs all three.
 *
 * Installed once per window at boot, as a capture-phase listener pair on
 * `window`, so it hears the keys before any surface does: the main
 * editor, a pane, a canvas, the Zen overlay. It never cancels anything —
 * a lone Shift, Option or Command does nothing anywhere in the app, so
 * the taps cost the surface underneath nothing. (Holding ⌘ does — the
 * PDF reading crop, the touch bar's held-⌘ sliders — but a tap is over
 * in under TAP_MAX_MS, before any of them wakes.)
 *
 * A tap is a press and release under TAP_MAX_MS; consecutive taps must
 * start within GAP_MAX_MS of the previous release. Anything else — a
 * held key, a key-repeat, a chord with any other modifier, any other key
 * (Option-↑ included), the window losing focus — starts the count over.
 * The left and right keys both count, and may be mixed; both at once is
 * a chord, not a tap.
 */

const TAP_MAX_MS = 350;
const GAP_MAX_MS = 450;
const TAPS = 3;

/** The event flag each tappable key sets on its own keydown, which is
 *  not a chord; every other modifier flag is. */
const OWN_FLAG = { Shift: "shiftKey", Alt: "altKey", Meta: "metaKey" };
const MOD_FLAGS = ["shiftKey", "altKey", "metaKey", "ctrlKey"];

/** Call `onTrigger` on the third quick tap of `key` (`"Shift"`, `"Alt"`
 *  or `"Meta"`, as `KeyboardEvent.key` names them). */
export function installTripleTap(key, onTrigger) {
  const others = MOD_FLAGS.filter((f) => f !== OWN_FLAG[key]);
  let taps = 0;
  let lastUp = 0;
  let downAt = 0;
  let down = false;
  const reset = () => { taps = 0; down = false; };

  window.addEventListener("keydown", (e) => {
    if (e.key !== key) { reset(); return; }
    if (e.repeat || down || others.some((f) => e[f])) { reset(); return; }
    const now = performance.now();
    if (taps > 0 && now - lastUp > GAP_MAX_MS) taps = 0;
    down = true;
    downAt = now;
  }, true);

  window.addEventListener("keyup", (e) => {
    if (e.key !== key || !down) return;
    down = false;
    const now = performance.now();
    if (now - downAt > TAP_MAX_MS) { taps = 0; return; }
    taps += 1;
    lastUp = now;
    if (taps < TAPS) return;
    taps = 0;
    onTrigger();
  }, true);

  window.addEventListener("blur", reset);
}
