/**
 * Boot preamble, extracted from `main.js` to keep `init()` under the
 * project's 700-line cap (same reason as `main-modes.js` /
 * `main-listeners.js`).
 *
 * Everything here runs *before* the app has a surface to show: the window
 * identifies itself, the activity log and the window/screen trail start
 * recording, iOS re-acquires its security-scoped desk folders, `AppState`
 * reads settings + the library, and the appearance CSS variables land on
 * `<html>`. It ends with the document painted in the user's own colours,
 * and returns the live `AppState` for `init()` to build on.
 *
 * Every step is wrapped in a `phase()` so Settings → Debug → Startup Time
 * can attribute the launch; see `startup-trace.js` for why the recording
 * is unconditional.
 */

import { AppState } from "./state/state.js";
import { applyAppearance, isIOS, isPhone } from "./settings/settings-ui.js";
import { applyFontFamily, updatePrivateBoxColor, installIOSChromeRepaint } from "./theme-colors.js";
import { applyFocusModeOpacity } from "./style-application.js";
import { installActivityCapture, configureActivityLog, logActivity } from "./activity-log.js";
import { installWindowDiagnostics, logWindowSnapshot } from "./window-diagnostics.js";
import { getInitialFileFromHash, getInitialDeskFromHash, getCurrentWindowLabel } from "./multi-window.js";
import { phase, phaseSync } from "./startup-trace.js";

/** Bring `AppState` up and paint the shell. Returns the live state. */
export async function bootAppState(IS_TAURI) {
  const state = new AppState();

  if (IS_TAURI) {
    try {
      const label = await phase("window label", () => getCurrentWindowLabel());
      state.isSecondaryWindow = label !== "main";
    } catch (_) { /* fall back to main-window behaviour */ }
  }
  // Register the wikilink open hook before state.init so cmd-clicks on
  // an auto-opened notebook resolve immediately.
  if (typeof window !== "undefined") {
    const { openWikilink, openWikilinkAsPane } = await phase("wikilink hooks", () => import("./links/wikilink-index.js"));
    window.__hushOpenWikilink = (title) => { void openWikilink(state, title); };
    window.__hushOpenWikilinkAsPane = (title) => { void openWikilinkAsPane(state, title); };
  }
  // Start the activity log before anything can go wrong — boot is the
  // stretch we most often need a trail for, and it's the stretch no
  // console is watching.
  installActivityCapture();
  if (IS_TAURI) {
    try {
      configureActivityLog({
        windowLabel: await getCurrentWindowLabel(),
        deskName: () => (state.fileTree || []).find(
          (n) => n.type === "desk" && n.id === state.settings?.activeDeskId,
        )?.name || "",
      });
    } catch (_) { /* defaults are fine */ }
  }
  // Window / screen trail — installed here rather than with the rest of
  // the multi-window wiring further down, because a boot that dies
  // before it gets there is the boot whose geometry we most want.
  try {
    installWindowDiagnostics({ label: IS_TAURI ? await getCurrentWindowLabel() : "main" });
  } catch (_) { /* diagnostics must never fail a boot */ }

  // **Before** the tree is read: on iOS a local desk's folder is only
  // reachable through a security-scoped bookmark, and until it's resolved
  // every `std::fs` call against that folder fails. `load_forest` skips a
  // desk it can't read, so a boot that ran ahead of this saw a forest
  // with the local desks missing — and then repaired, re-registered and
  // saved that short forest as if the desks were gone. This has to happen
  // first; the rest of the desk-roots lifecycle can stay where it is.
  if (IS_TAURI && isIOS()) {
    await phase("re-open local desk folders (iOS bookmarks)", async () => {
      try {
        const m = await import("./sync/desk-roots.js");
        await m.acquireLocalDeskAccess(state);
      } catch (e) {
        logActivity("desks", "error", "Could not re-open local desk folders before boot", { error: String(e) });
      }
    });
  }

  const initialFile = state.isSecondaryWindow ? getInitialFileFromHash() : null;
  const initialDesk = state.isSecondaryWindow ? getInitialDeskFromHash() : null;
  await phase("AppState.init", () => state.init({ initialFile, initialDesk }));
  if (typeof window !== "undefined") window.__hushState__ = state;
  logActivity("boot", "info", "Window initialised", {
    desks: (state.fileTree || []).filter((n) => n.type === "desk").map((n) => n.name),
    activeDeskId: state.settings?.activeDeskId || null,
    secondary: state.isSecondaryWindow,
  });
  // The baseline every later geometry line is a diff against.
  logWindowSnapshot("boot", { secondary: state.isSecondaryWindow });

  // Drop any bundled style presets the user hasn't seen yet into the
  // styles list so they show up as normal entries in the rail. Each
  // preset is tracked by filename so deleting one keeps it gone.
  await phase("seed style presets", async () => {
    try {
      const { seedStylePresets } = await import("./sidebar/style-presets.js");
      await seedStylePresets(state);
    } catch (e) { console.warn("seedStylePresets failed:", e); }
  });

  phaseSync("apply appearance", () => {
    // On iOS, set html background to prevent black bars behind the webview
    if (isIOS()) document.documentElement.classList.add("ios");
    if (isPhone()) document.documentElement.classList.add("phone");

    applyAppearance(state.settings.appearance || "dark");
    document.documentElement.style.setProperty("--font-size", state.settings.fontSize + "px");
    document.documentElement.style.setProperty("--line-height", state.settings.lineHeight);
    applyFontFamily(state.settings.fontFamily);
    applyFocusModeOpacity(state);
    updatePrivateBoxColor(state);
    installIOSChromeRepaint(state); // display-change half of the same repaint
  });

  return state;
}
