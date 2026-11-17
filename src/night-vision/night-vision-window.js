/**
 * Night Vision in the standalone Settings window (macOS), which is its
 * own webview with no AppState: it reads the settings it was opened
 * with, and re-reads them whenever any window writes settings (every
 * write broadcasts `cross-window-state-changed`, the event sibling main
 * windows merge from). On iPad, Settings is a modal inside the main
 * window and is covered by the main window's layers.
 */
import { isNightVisionActive } from "./night-vision-mode.js";
import { mountNightVision, unmountNightVision } from "./night-vision-veil.js";

let endTimer = null;

function paint(settings) {
  const on = isNightVisionActive(settings);
  if (on) mountNightVision();
  else unmountNightVision();
  if (endTimer) { clearTimeout(endTimer); endTimer = null; }
  if (on) {
    const wait = settings.nightVisionUntil - Date.now();
    endTimer = setTimeout(() => { endTimer = null; paint(settings); }, Math.max(0, wait) + 250);
  }
}

export async function installNightVisionWindow(initialSettings) {
  let latest = initialSettings || {};
  paint(latest);
  const recheck = () => { if (document.visibilityState !== "hidden") paint(latest); };
  document.addEventListener("visibilitychange", recheck);
  window.addEventListener("focus", recheck);
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return;
  try {
    const [{ listen }, { invoke }] = await Promise.all([
      import("@tauri-apps/api/event"),
      import("@tauri-apps/api/core"),
    ]);
    await listen("cross-window-state-changed", async (event) => {
      if (event?.payload?.kind !== "settings") return;
      try {
        latest = await invoke("get_settings");
        paint(latest);
      } catch (_) { /* window closing */ }
    });
  } catch (_) { /* no event bridge: the state at opening stands */ }
}
