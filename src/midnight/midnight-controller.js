/**
 * Midnight mode — turning it on and off, choosing between it and the
 * other three appearances, and keeping every window in step. The model
 * (what it paints, when it ends) is `midnight-mode.js`.
 *
 * On: `settings.midnightUntil` is set to the next 8am and `style-changed`
 * repaints everything through the ordinary style pipeline, which reads
 * the model. Off: the field goes back to null and the same pulse puts the
 * style's own colours and the user's own appearance back. Nothing about
 * the style, the desk or the appearance setting is ever written, which
 * is what makes it temporary.
 *
 * Three ways it ends besides the command: the 8am timer below; a window
 * that wakes after 8am (laptop opened in the morning — sleeping timers
 * fire late, so focus and visibility re-check the clock); and quitting
 * the app, which Rust handles by clearing the field at launch.
 */
import { isMidnightActive, nextMidnightEnd, MIDNIGHT_FG } from "./midnight-mode.js";
import { applyAppearance } from "../settings/settings-ui.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

/** Whether this window last painted with midnight mode on — so a sibling
 *  window's settings echo only repaints when the mode actually changed. */
let paintedActive = false;
let endTimer = null;

/** Repaint every surface for the current state of the mode: the main
 *  editor and chrome (main.js's `style-changed` handler runs
 *  applyActiveStyle), panes, the cursor, the line indicator and an open
 *  notebook all listen for the same pulse. */
function repaint(state) {
  paintedActive = isMidnightActive(state.settings);
  state.emit("style-changed");
  scheduleEnd(state);
}

/** Arm (or clear) the timer that switches midnight mode off at 8am. */
function scheduleEnd(state) {
  if (endTimer) { clearTimeout(endTimer); endTimer = null; }
  if (!isMidnightActive(state.settings)) return;
  const wait = state.settings.midnightUntil - Date.now();
  // At most ~24 h away by construction, well inside setTimeout's range.
  endTimer = setTimeout(() => { endTimer = null; checkExpiry(state); }, Math.max(0, wait) + 250);
}

/** Midnight mode's end has passed (or the field is stale): take it off. */
function checkExpiry(state) {
  const until = state.settings?.midnightUntil;
  if (until == null) {
    if (paintedActive) repaint(state);
    return;
  }
  if (isMidnightActive(state.settings)) { scheduleEnd(state); return; }
  void setMidnightMode(state, false);
}

/** Turn midnight mode on or off. Paints at once (the settings object is
 *  updated synchronously inside `updateSettings`) and lets the key-scoped
 *  write and the cross-window broadcast follow. */
export async function setMidnightMode(state, on) {
  const midnightUntil = on ? nextMidnightEnd() : null;
  const write = state.updateSettings({ midnightUntil });
  repaint(state);
  await write;
}

export function toggleMidnightMode(state) {
  return setMidnightMode(state, !isMidnightActive(state.settings));
}

/** The appearance the user has chosen, as one of four: `light`, `dark`,
 *  `auto` (System) or `midnight`. Midnight is a fourth appearance that
 *  happens to also take over the background and text colours, so it is
 *  shown and chosen alongside the other three — and, like them, it is
 *  app-wide: one setting, not a per-desk or per-style choice. */
export function currentAppearanceChoice(settings) {
  if (isMidnightActive(settings)) return "midnight";
  return settings?.appearance || "auto";
}

/** Choose one of the four appearances. Every appearance control goes
 *  through here (the palette's rows, the style editor's toggle), which
 *  is what guarantees midnight mode never sits under a light appearance:
 *  choosing Light, Dark or System always ends it, even when that
 *  appearance is already the stored one — "Light" picked while the page
 *  is midnight black is a request for light. Choosing Midnight leaves
 *  the stored appearance alone, so the one underneath comes back when
 *  it ends. */
export async function chooseAppearance(state, choice) {
  if (choice === "midnight") {
    if (!isMidnightActive(state.settings)) await setMidnightMode(state, true);
    return;
  }
  const midnight = isMidnightActive(state.settings);
  if (!midnight && (state.settings?.appearance || "auto") === choice) return;
  const patch = { appearance: choice };
  if (midnight || state.settings?.midnightUntil != null) patch.midnightUntil = null;
  const write = state.updateSettings(patch);
  applyAppearance(choice);
  paintedActive = false;
  scheduleEnd(state);
  state.emit("style-changed");
  state.emit("theme-changed");
  await write;
}

/** Wire midnight mode up for this window. Called once from main.js. */
export function installMidnightMode(state) {
  document.documentElement.style.setProperty("--midnight-fg", MIDNIGHT_FG);
  // Outside Tauri there is no Rust launch to clear the field, and the
  // browser build keeps settings in localStorage — clear it here so a
  // reload behaves like a relaunch.
  if (!IS_TAURI && state.settings?.midnightUntil != null) {
    void state.updateSettings({ midnightUntil: null });
  }
  paintedActive = isMidnightActive(state.settings);
  // A stale end moment (the app was left open overnight in another
  // window that has since closed) is tidied away rather than carried.
  checkExpiry(state);
  // A sibling window toggling it — or choosing another appearance —
  // arrives as a settings merge.
  state.on("remote-settings-merged", () => {
    if (isMidnightActive(state.settings) !== paintedActive) repaint(state);
    else scheduleEnd(state);
  });
  const recheck = () => {
    if (document.visibilityState === "hidden") return;
    checkExpiry(state);
  };
  document.addEventListener("visibilitychange", recheck);
  window.addEventListener("focus", recheck);
}
