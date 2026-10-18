/**
 * Courier's trigger — three quick taps of either Shift key, with no other
 * key pressed during or between them (ui/triple-tap.js has the rules).
 * The sheet module is imported only when the third tap lands.
 */
import { installTripleTap } from "../ui/triple-tap.js";

let installed = false;

export function installCourierTrigger(state) {
  if (installed) return;
  installed = true;
  installTripleTap("Shift", () => {
    import("./courier-sheet.js")
      .then(({ toggleCourier }) => toggleCourier(state))
      .catch((err) => console.error("Courier failed to open:", err));
  });
}
