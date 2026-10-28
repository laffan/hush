/**
 * The triple-tap gestures, installed once per window from main.js. One
 * detector (ui/triple-tap.js) reports each gesture; Settings → Shortcuts
 * decides which action it runs (`settings.tripleTaps`,
 * ui/triple-tap-gestures.js). By default:
 *
 *   ⇧ ×3        Courier
 *   ⌥ ×3        Write Now
 *   ⌘ ×3        Campfire Cursor, on with this desk's last settings, or off
 *   ⇧ + ⌘ ×3    Edge Lights, on with this desk's last settings, or off
 *
 * Each action's module is imported only when its gesture lands.
 */
import { installTripleTap } from "./ui/triple-tap.js";
import { readTripleTaps } from "./ui/triple-tap-gestures.js";

const ACTIONS = {
  courier: async (state) => (await import("./courier/courier-sheet.js")).toggleCourier(state),
  writeNow: async (state) => (await import("./write-now/write-now.js")).writeNow(state),
  campfire: async (state) => (await import("./campfire/campfire.js")).toggleCampfire(state),
  edgeLights: async (state) => (await import("./edge-lights/edge-lights.js")).toggleEdgeLights(state),
};

let installed = false;

export function installTripleTapTriggers(state) {
  if (installed) return;
  installed = true;
  installTripleTap((gesture) => {
    const taps = readTripleTaps(state.settings);
    const action = Object.keys(taps).find((a) => taps[a] === gesture);
    if (!action) return;
    ACTIONS[action](state).catch((err) => console.error(`Triple tap (${action}) failed:`, err));
  });
}
