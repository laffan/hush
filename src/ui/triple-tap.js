/**
 * Three quick taps of one modifier key — Shift, Option, Command or
 * Control — optionally with one other modifier held down throughout
 * (⇧ held while ⌘ is tapped), and no other key pressed during or between
 * them. The gesture behind Courier, Write Now, Campfire Cursor and Edge
 * Lights; which does what is the user's (triple-tap-gestures.js,
 * triple-tap-triggers.js).
 *
 * Installed once per window at boot, as a capture-phase listener pair on
 * `window`, so it hears the keys before any surface does: the main
 * editor, a pane, a canvas, the Zen overlay. It never cancels anything —
 * a lone modifier does nothing anywhere in the app, so the taps cost the
 * surface underneath nothing. (Holding ⌘ does — the PDF reading crop,
 * the touch bar's held-⌘ sliders — but a tap is over in under
 * TAP_MAX_MS, before any of them wakes.)
 *
 * A tap is a press and release under TAP_MAX_MS; consecutive taps must
 * start within GAP_MAX_MS of the previous release, with the same
 * modifiers held. Anything else — a held key, a key-repeat, a change in
 * what is held, any other key (Option-↑ included), the window losing
 * focus — starts the count over. The left and right keys both count, and
 * may be mixed; both at once is a chord, not a tap.
 *
 * **Double taps** ride the same detector, for the gestures the caller
 * names (`doubles`: ⌘ ×2 opens the To-do list). Two taps can't fire on
 * the second release — that release is also the middle of a triple — so
 * a double waits out the GAP_MAX_MS a third tap would have to start in,
 * and the third tap's press cancels it. The cost is that wait, once, on
 * a double; a triple is never delayed and never also fires its double.
 */

const TAP_MAX_MS = 350;
const GAP_MAX_MS = 450;
const TAPS = 3;

/** Each tappable key's own event flag, in gesture-name order. */
const KEYS = [
  ["Shift", "shiftKey"],
  ["Alt", "altKey"],
  ["Control", "ctrlKey"],
  ["Meta", "metaKey"],
];
const FLAG = Object.fromEntries(KEYS);

/** The gesture a tap of `key` makes with what else is held: "Meta", or
 *  "Shift+Meta" for ⌘ tapped with ⇧ down. */
function gestureOf(key, e) {
  const held = KEYS.filter(([k, f]) => k !== key && e[f]).map(([k]) => k);
  return [...held, key].join("+");
}

/** Call `onGesture(gesture)` on the third quick tap of a modifier, and
 *  `onDouble(gesture)` on a second tap no third one follows, for the
 *  gestures `doubles()` returns. */
export function installTripleTap(onGesture, { doubles = () => [], onDouble = null } = {}) {
  let gesture = "";
  let key = "";
  let taps = 0;
  let lastUp = 0;
  let downAt = 0;
  let down = false;
  let doubleTimer = 0;
  const cancelDouble = () => { clearTimeout(doubleTimer); doubleTimer = 0; };
  const reset = () => { cancelDouble(); taps = 0; down = false; gesture = ""; key = ""; };

  window.addEventListener("keydown", (e) => {
    cancelDouble();
    if (!FLAG[e.key]) { reset(); return; }
    // Pressing the key that is to be held starts nothing yet; the taps
    // that follow carry it in their own flags.
    if (e.repeat) { if (e.key === key) reset(); return; }
    if (down) { down = false; taps = 0; }
    const g = gestureOf(e.key, e);
    const now = performance.now();
    if (g !== gesture || now - lastUp > GAP_MAX_MS) taps = 0;
    gesture = g;
    key = e.key;
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
    if (taps === 2 && onDouble && doubles().includes(gesture)) {
      const g = gesture;
      doubleTimer = setTimeout(() => {
        doubleTimer = 0;
        if (taps !== 2 || gesture !== g || down) return;
        taps = 0;
        onDouble(g);
      }, GAP_MAX_MS);
    }
    if (taps < TAPS) return;
    const fired = gesture;
    taps = 0;
    onGesture(fired);
  }, true);

  // A pointer press while the key is down makes it a modifier-click
  // (⌥-click adds a cursor, ⇧-click extends a selection), not a tap —
  // three quick ⌥-clicks would otherwise run Write Now.
  window.addEventListener("pointerdown", reset, true);
  window.addEventListener("blur", reset);
}
