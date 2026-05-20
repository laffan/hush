/**
 * macOS traffic-light hover-reveal — Tauri-only.
 *
 * The window keeps `decorations: true` + `titleBarStyle: "Overlay"`
 * (see tauri.conf.json) so the native close / minimise / zoom buttons
 * float over the editor area in the top-left. We hide them by default
 * via the Rust `set_traffic_lights_visible` command, then mount a small
 * invisible hover-zone over their normal position; pointing at it
 * reveals the buttons, leaving the zone hides them again.
 *
 * Sized + positioned to match the native cluster (~8 px left, 12 px top,
 * each button ~14 px). The zone is a bit bigger than the cluster so the
 * activation feels forgiving.
 */

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

let invokeFn = null;
let installed = false;

async function setVisible(visible) {
  if (!invokeFn) return;
  try { await invokeFn("set_traffic_lights_visible", { visible }); }
  catch (e) { console.warn("set_traffic_lights_visible failed:", e); }
}

/** Install the hover zone + initial hide. Idempotent. */
export async function setupTrafficLightsHoverReveal() {
  if (installed || !IS_TAURI) return;
  // Only macOS — the Rust command is a no-op elsewhere but we also
  // skip the DOM zone to avoid an invisible hit-target on platforms
  // that don't carry the buttons in the first place.
  if (!navigator.platform || !/Mac/i.test(navigator.platform)) return;
  installed = true;

  const core = await import("@tauri-apps/api/core");
  invokeFn = core.invoke;
  await setVisible(false);

  const zone = document.createElement("div");
  zone.className = "traffic-light-hover-zone";
  zone.setAttribute("aria-hidden", "true");
  // Sized to comfortably cover the native cluster. Keep it click-
  // through so the user's actual click on a revealed button isn't
  // intercepted — pointer-events: none on the zone itself, but each
  // pointermove on the document checks the rect manually instead.
  Object.assign(zone.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "90px",
    height: "32px",
    zIndex: "9999",
    pointerEvents: "none",
  });
  document.body.appendChild(zone);

  // Document-level pointermove so the buttons can be clicked once
  // revealed without the hover zone swallowing the click. We treat the
  // zone *and* the native button area itself as "still inside" so the
  // buttons don't flicker off the moment the cursor crosses into them.
  let revealed = false;
  const HOT_W = 90;
  const HOT_H = 32;
  function inHotZone(x, y) {
    return x >= 0 && x <= HOT_W && y >= 0 && y <= HOT_H;
  }
  document.addEventListener("pointermove", (e) => {
    const hot = inHotZone(e.clientX, e.clientY);
    if (hot && !revealed) { revealed = true; setVisible(true); }
    else if (!hot && revealed) { revealed = false; setVisible(false); }
  }, { passive: true });
  // Cursor leaving the window entirely → make sure they hide again.
  document.addEventListener("pointerleave", () => {
    if (revealed) { revealed = false; setVisible(false); }
  });
}
