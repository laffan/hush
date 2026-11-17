/**
 * Night Vision — turning it on and off, its 8am end, and keeping every
 * window in step. The model is `night-vision-mode.js`; the layers that
 * do the work are `night-vision-veil.js`.
 *
 * The same mechanism as Midnight mode (`midnight/midnight-controller.js`),
 * deliberately: on writes `settings.nightVisionUntil` (the next 8am),
 * off writes null, and Rust clears it at launch. It ends on its own at
 * 8am (a timer, plus a re-check when the window comes back, since a
 * sleeping laptop's timers fire late) or when the app quits.
 *
 * It is independent of the appearance: choosing Light, Dark, System or
 * Midnight leaves it on, and turning it off leaves the appearance as it
 * was. Nothing about a style, a desk or the appearance is written.
 */
import { isNightVisionActive, nextNightVisionEnd } from "./night-vision-mode.js";
import { mountNightVision, unmountNightVision } from "./night-vision-veil.js";
import { isMidnightActive } from "../midnight/midnight-mode.js";
import { setMidnightMode } from "../midnight/midnight-controller.js";
import { updatePrivateBoxColor } from "../theme-colors.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

/** Whether this window last painted with Night Vision on — a sibling's
 *  settings echo only repaints when the mode actually flipped. */
let paintedActive = false;
let endTimer = null;

/** Put the layers up or take them down for the current state, and
 *  repaint the colours painted natively under the page (iOS), which the
 *  layers can't reach — `updatePrivateBoxColor` sends them through
 *  `nightVisionHex` while the mode is on. */
function paint(state) {
  paintedActive = isNightVisionActive(state.settings);
  if (paintedActive) mountNightVision();
  else unmountNightVision();
  try { updatePrivateBoxColor(state); } catch (_) { /* boot not finished */ }
  scheduleEnd(state);
}

function scheduleEnd(state) {
  if (endTimer) { clearTimeout(endTimer); endTimer = null; }
  if (!isNightVisionActive(state.settings)) return;
  const wait = state.settings.nightVisionUntil - Date.now();
  // At most ~24 h away by construction, well inside setTimeout's range.
  endTimer = setTimeout(() => { endTimer = null; checkExpiry(state); }, Math.max(0, wait) + 250);
}

/** The end has passed (or the field is stale): take it off. */
function checkExpiry(state) {
  const until = state.settings?.nightVisionUntil;
  if (until == null) {
    if (paintedActive) paint(state);
    return;
  }
  if (isNightVisionActive(state.settings)) { scheduleEnd(state); return; }
  void setNightVision(state, false);
}

/** Turn Night Vision on or off. Paints at once; the write and the
 *  cross-window broadcast follow. */
export async function setNightVision(state, on) {
  const nightVisionUntil = on ? nextNightVisionEnd() : null;
  const write = state.updateSettings({ nightVisionUntil });
  paint(state);
  await write;
}

export function toggleNightVision(state) {
  return setNightVision(state, !isNightVisionActive(state.settings));
}

/** Night Vision over Midnight mode: black, and text in a dim red. Turns
 *  on whichever of the two is off; each still ends on its own (8am, or
 *  its pinned Deactivate row). */
export async function setMidnightNightVision(state) {
  if (!isMidnightActive(state.settings)) await setMidnightMode(state, true);
  if (!isNightVisionActive(state.settings)) await setNightVision(state, true);
}

/** Wire Night Vision up for this window. Called once from main.js. */
export function installNightVision(state) {
  // Outside Tauri there is no Rust launch to clear the field (the browser
  // build keeps settings in localStorage) — clear it so a reload behaves
  // like a relaunch.
  if (!IS_TAURI && state.settings?.nightVisionUntil != null) {
    void state.updateSettings({ nightVisionUntil: null });
  }
  if (isNightVisionActive(state.settings)) paint(state);
  checkExpiry(state);
  state.on("remote-settings-merged", () => {
    if (isNightVisionActive(state.settings) !== paintedActive) paint(state);
    else scheduleEnd(state);
  });
  const recheck = () => {
    if (document.visibilityState === "hidden") return;
    checkExpiry(state);
  };
  document.addEventListener("visibilitychange", recheck);
  window.addEventListener("focus", recheck);
}
