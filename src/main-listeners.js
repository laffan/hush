/**
 * App-level listener wiring extracted from main.js's init() to keep that file
 * under the line limit. Each installer takes the live AppState and registers
 * its own event listeners; nothing here closes over other init() locals.
 */

import { applyAppearance } from "./settings/settings-ui.js";
import { applyActiveStyle } from "./style-application.js";
import { applyNotebookSettings } from "./notebook/notebook-bridge.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

/** Keep the notebook canvas in sync with settings/style/theme, and — when
 *  appearance is "auto" — re-apply appearance + active style whenever the
 *  system light/dark preference flips (covering the iOS/iPadOS WKWebView case
 *  where the matchMedia "change" event is missed while backgrounded). */
export function installNotebookAppearanceSync(state) {
  function syncNotebookIfActive() {
    if (state.currentNotebookFileId) applyNotebookSettings(state);
  }
  state.on("settings-changed", syncNotebookIfActive);
  state.on("style-changed", syncNotebookIfActive);
  state.on("theme-changed", syncNotebookIfActive);

  let lastSystemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  function refreshAutoAppearance() {
    if (state.settings.appearance !== "auto") return;
    const nowDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    lastSystemDark = nowDark;
    applyAppearance("auto");
    // Unconditional — the Default style is a style too. The old
    // `if (activeStyleId)` guard skipped the editor repaint for the
    // Default style while the sidebar's colours still refreshed,
    // which is exactly the "sidebar out of sync after the app was
    // backgrounded" bug. applyActiveStyle repaints editor + sidebar
    // in one synchronous pass and emits theme-changed itself (which
    // also re-syncs an open notebook canvas).
    applyActiveStyle(state);
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refreshAutoAppearance);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (state.settings.appearance !== "auto") return;
    const nowDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (nowDark !== lastSystemDark) refreshAutoAppearance();
  });
  window.addEventListener("focus", () => {
    if (state.settings.appearance !== "auto") return;
    const nowDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (nowDark !== lastSystemDark) refreshAutoAppearance();
  });
}

