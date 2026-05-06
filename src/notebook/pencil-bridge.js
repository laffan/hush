/**
 * iOS pencil bridge — wires the `tauri-plugin-pencil` native plugin
 * (Rust shell + Swift `PencilPlugin`) into Hush's drawing layer.
 *
 * Two responsibilities:
 *
 *   1. Pencil-only mode. iPadOS routinely delivers Apple Pencil
 *      contacts as `pointerType === "pen"` and finger contacts as
 *      `"touch"`, so the gating itself is done in `engine/stroke.js`
 *      via the `setPencilOnly` flag — this module just flips the flag
 *      on once the native plugin reports it has loaded. (We wait for
 *      the native handshake so the flag isn't enabled on a build that
 *      shipped without the plugin, e.g. macOS dev or a release where
 *      the iOS bridge silently failed.)
 *
 *   2. Apple Pencil double-tap. The Pencil 2nd gen / Pencil Pro
 *      delivers a hardware double-tap event that has no PointerEvent
 *      equivalent — it's a pure `UIPencilInteraction` signal. The
 *      Swift plugin forwards it as a `double-tap` plugin event; this
 *      module flips the active notebook's `drawingSubTool` between
 *      `"draw"` and `"erase"` whenever it fires.
 *
 * Failure mode: if the plugin isn't registered (non-iOS build, or the
 * runtime threw before `load()` completed) the listener registration
 * rejects silently and pencil-only stays off, so the user keeps the
 * existing finger-as-pen behaviour. Nothing else in Hush depends on
 * this module.
 */

import { setNotebookPencilOnly, getActiveNotebookState } from "./notes-canvas";

const IS_TAURI =
  typeof window !== "undefined" &&
  window.__TAURI_INTERNALS__ != null;

let _initialised = false;

export async function initPencilBridge() {
  if (_initialised) return;
  _initialised = true;
  if (!IS_TAURI) return;

  let addPluginListener;
  try {
    ({ addPluginListener } = await import("@tauri-apps/api/core"));
  } catch (_) {
    // SDK missing — non-Tauri build.
    return;
  }

  // The plugin's "loaded" event fires ~500 ms after the Swift `load()`
  // method runs, which is our cue that the native side is wired up
  // and dispatching touches. Until that happens we leave pencil-only
  // off so a build without the plugin doesn't strand finger users.
  let loaded = false;

  try {
    await addPluginListener("pencil", "loaded", () => {
      if (loaded) return;
      loaded = true;
      setNotebookPencilOnly(true);
    });
  } catch (_) {
    // Plugin not registered. macOS / Linux / Windows fall here.
    return;
  }

  // `touch` arrives on every UITouch.began with `data.type === "pencil" | "finger"`.
  // We don't strictly need it (PointerEvent.pointerType already
  // separates pen from touch on iPadOS), but having a confirmed signal
  // from the Swift side makes the bridge useful for future heuristics
  // and helps debug pointerType regressions on older iPadOS releases.
  try {
    await addPluginListener("pencil", "touch", (e) => {
      const kind = e?.payload?.type ?? e?.type;
      if (kind === "pencil" || kind === "finger") {
        if (typeof window !== "undefined") window.__hushLastTouchKind = kind;
      }
    });
  } catch (_) { /* non-fatal */ }

  try {
    await addPluginListener("pencil", "double-tap", () => {
      const state = getActiveNotebookState();
      if (!state) return;
      // Toggle between active brush and eraser. If the user is mid-
      // selection or wasn't on a stroke sub-tool, treat the tap as
      // "go back to drawing" so the gesture also serves as a quick
      // re-entry into pen mode.
      const sub = state.drawingSubTool;
      const next = sub === "erase" ? "draw" : "erase";
      if (typeof state.setDrawingSubTool === "function") {
        state.setDrawingSubTool(next);
      } else {
        state.drawingSubTool = next;
        state.notify("drawingSubTool");
      }
      // The engine only listens when `state.tool === "pen"`, so flip
      // there too — otherwise the toggle is invisible until the user
      // picks pen on the bottom toolbar themselves.
      if (state.tool !== "pen") {
        state.tool = "pen";
        state.notify("tool");
      }
    });
  } catch (_) { /* non-fatal */ }
}
