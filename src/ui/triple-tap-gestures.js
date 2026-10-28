/**
 * The triple-tap gestures and what each one does — Settings → Shortcuts
 * → Triple taps assigns them; triple-tap-triggers.js runs them. Pure data,
 * so the settings window can import it without the app.
 *
 * A gesture is the tapped modifier, optionally with one other modifier
 * held down throughout: "Meta" is ⌘ tapped three times; "Shift+Meta" is
 * ⇧ held while ⌘ is tapped three times (ui/triple-tap.js).
 *
 * Stored as `settings.tripleTaps`, action → gesture ("" = none). Each
 * gesture belongs to one action at most.
 */

export const TRIPLE_TAP_GESTURES = [
  { id: "Shift", label: "⇧ Shift ×3" },
  { id: "Alt", label: "⌥ Option ×3" },
  { id: "Meta", label: "⌘ Command ×3" },
  { id: "Control", label: "⌃ Control ×3" },
  { id: "Shift+Meta", label: "⇧ + ⌘ Command ×3" },
  { id: "Shift+Alt", label: "⇧ + ⌥ Option ×3" },
  { id: "Alt+Meta", label: "⌥ + ⌘ Command ×3" },
];

export const TRIPLE_TAP_ACTIONS = [
  { id: "courier", label: "Courier" },
  { id: "writeNow", label: "Write Now" },
  { id: "campfire", label: "Campfire Cursor" },
  { id: "edgeLights", label: "Edge Lights" },
];

export const DEFAULT_TRIPLE_TAPS = Object.freeze({
  courier: "Shift",
  writeNow: "Alt",
  campfire: "Meta",
  edgeLights: "Shift+Meta",
});

const KNOWN = new Set(TRIPLE_TAP_GESTURES.map((g) => g.id));

/** Every action's gesture, stored values over the defaults; a gesture
 *  claimed twice stays with the first action that has it. */
export function readTripleTaps(settings) {
  const raw = settings?.tripleTaps && typeof settings.tripleTaps === "object" ? settings.tripleTaps : {};
  const out = {};
  const used = new Set();
  for (const { id } of TRIPLE_TAP_ACTIONS) {
    let g = typeof raw[id] === "string" ? raw[id] : DEFAULT_TRIPLE_TAPS[id];
    if (g && (!KNOWN.has(g) || used.has(g))) g = "";
    if (g) used.add(g);
    out[id] = g;
  }
  return out;
}

/** Assign `gesture` to `action`, taking it from whichever action had it. */
export function assignTripleTap(settings, action, gesture) {
  const next = { ...readTripleTaps(settings) };
  if (gesture) for (const k of Object.keys(next)) if (next[k] === gesture) next[k] = "";
  next[action] = gesture || "";
  return next;
}
