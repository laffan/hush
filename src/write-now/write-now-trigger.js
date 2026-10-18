/**
 * Write Now's trigger — three quick taps of either Option key, with no
 * other key pressed during or between them (ui/triple-tap.js has the
 * rules; Courier's is the same gesture on Shift). The module that does
 * the work is imported only when the third tap lands.
 */
import { installTripleTap } from "../ui/triple-tap.js";

let installed = false;

export function installWriteNowTrigger(state) {
  if (installed) return;
  installed = true;
  installTripleTap("Alt", () => {
    import("./write-now.js")
      .then(({ writeNow }) => writeNow(state))
      .catch((err) => console.error("Write Now failed to start:", err));
  });
}
