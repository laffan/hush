/**
 * Courier's trigger — three quick taps of either Shift key, with no other
 * key pressed during or between them.
 *
 * Installed once per window at boot, as a capture-phase listener on
 * `window`, so it hears the keys before any surface does: the main
 * editor, a pane, a canvas, the Zen overlay. It never cancels anything —
 * a lone Shift does nothing anywhere in the app, so the taps cost the
 * surface underneath nothing, and the sheet itself is imported only when
 * the third tap lands.
 *
 * A tap is a press and release under TAP_MAX_MS; consecutive taps must
 * start within GAP_MAX_MS of the previous release. Anything else — a
 * held Shift, a key-repeat, a modifier chord, any other key, the window
 * losing focus — starts the count over. Left and right Shift both count,
 * and may be mixed; both at once is a chord, not a tap.
 */

const TAP_MAX_MS = 350;
const GAP_MAX_MS = 450;
const TAPS = 3;

let installed = false;

export function installCourierTrigger(state) {
  if (installed) return;
  installed = true;

  let taps = 0;
  let lastUp = 0;
  let downAt = 0;
  let shiftDown = false;
  const reset = () => { taps = 0; shiftDown = false; };

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Shift") { reset(); return; }
    if (e.repeat || shiftDown || e.metaKey || e.ctrlKey || e.altKey) { reset(); return; }
    const now = performance.now();
    if (taps > 0 && now - lastUp > GAP_MAX_MS) taps = 0;
    shiftDown = true;
    downAt = now;
  }, true);

  window.addEventListener("keyup", (e) => {
    if (e.key !== "Shift" || !shiftDown) return;
    shiftDown = false;
    const now = performance.now();
    if (now - downAt > TAP_MAX_MS) { taps = 0; return; }
    taps += 1;
    lastUp = now;
    if (taps < TAPS) return;
    taps = 0;
    import("./courier-sheet.js")
      .then(({ toggleCourier }) => toggleCourier(state))
      .catch((err) => console.error("Courier failed to open:", err));
  }, true);

  window.addEventListener("blur", reset);
}
