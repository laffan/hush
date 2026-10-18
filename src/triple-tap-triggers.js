/**
 * The three triple-tap gestures, installed once per window from main.js:
 * Shift for Courier, Option for Write Now, Command for Edge Lights. Each
 * trigger module holds its own rules for what the tap does; the tap
 * itself is ui/triple-tap.js.
 */
import { installCourierTrigger } from "./courier/courier-trigger.js";
import { installWriteNowTrigger } from "./write-now/write-now-trigger.js";
import { installEdgeLightsTrigger } from "./edge-lights/edge-lights-trigger.js";

export function installTripleTapTriggers(state) {
  installCourierTrigger(state);
  installWriteNowTrigger(state);
  installEdgeLightsTrigger(state);
}
