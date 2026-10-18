/**
 * Edge Lights' trigger — three quick taps of either Command key, with no
 * other key pressed during or between them (ui/triple-tap.js has the
 * rules; Courier's is the same gesture on Shift, Write Now's on Option).
 * It turns the lights on with the settings last used, or off, without
 * the modal; the module that does it is imported on the third tap.
 */
import { installTripleTap } from "../ui/triple-tap.js";

let installed = false;

export function installEdgeLightsTrigger(state) {
  if (installed) return;
  installed = true;
  installTripleTap("Meta", () => {
    import("./edge-lights.js")
      .then(({ toggleEdgeLights }) => toggleEdgeLights(state))
      .catch((err) => console.error("Edge Lights failed to toggle:", err));
  });
}
