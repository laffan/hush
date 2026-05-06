/**
 * iOS pencil bridge — wires the `tauri-plugin-pencil` native plugin
 * (Rust shell + Swift `PencilPlugin`) into Hush's drawing layer.
 *
 * What this module owns today:
 *
 *   1. Apple Pencil double-tap. The Pencil 2nd gen / Pencil Pro
 *      delivers a hardware double-tap event that has no PointerEvent
 *      equivalent — it's a pure `UIPencilInteraction` signal. The
 *      Swift plugin forwards it as a `double-tap` plugin event; this
 *      module flips the active notebook's `drawingSubTool` between
 *      `"draw"` and `"erase"` whenever it fires.
 *
 *   2. Touch-kind monitoring. Swift fires a `touch` event on every
 *      `UITouch.began` with `data.type === "pencil" | "finger"`. We
 *      stash the most recent value on `window.__hushLastTouchKind`
 *      so future heuristics (e.g. an opt-in pencil-only setting) have
 *      a confirmed signal to lean on independent of `PointerEvent.
 *      pointerType`, which on this Tauri WKWebView build appears to
 *      mis-classify Apple Pencil as `"touch"`.
 *
 * Crucially this module does NOT auto-enable `setPencilOnly(true)`
 * anymore. Older versions of this file flipped the flag on the Swift
 * plugin's `loaded` ping, but that locked finger AND pencil touches
 * out on iPad whenever pointerType wasn't reliably reporting the
 * Pencil — which appears to be the case on the current Tauri build.
 * The hook stays in `engine/stroke.js` (delta #18) so a future
 * settings toggle or correlated touch-kind gate can flip it on
 * deliberately.
 *
 * Failure mode: if the plugin isn't registered (non-iOS build, or the
 * runtime threw before `load()` completed) the listener registration
 * rejects silently. Nothing else in Hush depends on this module.
 */

import { getActiveNotebookState } from "./notes-canvas";

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
    return;
  }

  // `touch` arrives on every UITouch.began with `data.type === "pencil" | "finger"`.
  // Stash on window so future code (or the dev console while debugging)
  // can sanity-check what input the user is actually using.
  try {
    await addPluginListener("pencil", "touch", (e) => {
      const kind = e?.payload?.type ?? e?.type;
      if (kind === "pencil" || kind === "finger") {
        if (typeof window !== "undefined") window.__hushLastTouchKind = kind;
      }
    });
  } catch (_) {
    // Plugin not registered (macOS / Linux / Windows). Bail before
    // the double-tap subscription so we don't log noise; everything
    // already works without the bridge on those platforms.
    return;
  }

  try {
    await addPluginListener("pencil", "double-tap", () => {
      const state = getActiveNotebookState();
      if (!state) return;
      // Toggle between active brush and eraser.
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
