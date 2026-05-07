/**
 * iOS pencil bridge — gates strokes to Apple Pencil only on iPad and
 * routes the Apple Pencil 2nd-gen / Pencil Pro hardware double-tap
 * into a draw / erase toggle on the active notebook.
 *
 * Iteration history: an earlier version of this module loaded the
 * `tauri-plugin-pencil` native plugin to also flip touch-type
 * detection on a per-touch basis. That path attached a passive
 * `UIGestureRecognizer` to the WKWebView's scrollView which broke
 * iPad drawing entirely (the scrollView gesture chain interfered
 * with how the page received touches), so the Swift side now runs
 * `UIPencilInteraction` only — that interaction sits on the webview
 * itself, not the scrollView, and never observes touch delivery.
 * Touch-type gating remains pure-JS via `PointerEvent.pointerType`,
 * which iPad WKWebView reports reliably as `"pen"` for Apple Pencil
 * and `"touch"` for finger.
 *
 * The double-tap routes through the plugin because
 * `UIPencilInteraction` is the only iOS API that surfaces the
 * squeeze-sensor gesture — there is no `PointerEvent` equivalent.
 */
/* global console */

import { setNotebookPencilOnly, toggleNotebookEraser } from "./notes-canvas";

const IS_TAURI =
  typeof window !== "undefined" &&
  window.__TAURI_INTERNALS__ != null;

/** iPadOS 13+ reports `MacIntel` for `navigator.platform`, so the UA
 *  string check alone misses iPad. Also accept `Mac` + a positive
 *  `maxTouchPoints` (real Macs report 0). */
function isIOS() {
  if (typeof navigator === "undefined") return false;
  if (/iPad|iPhone|iPod/.test(navigator.userAgent || "")) return true;
  const tp = typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0;
  return /Mac/i.test(navigator.platform || "") && tp > 0;
}

let _initialised = false;

export function initPencilBridge() {
  if (_initialised) return;
  _initialised = true;
  if (!IS_TAURI) return;
  if (!isIOS()) return;
  setNotebookPencilOnly(true);

  // Subscribe to the native plugin's `double-tap` event. The plugin
  // permissions toml allows registerListener / removeListener; the
  // capability config grants `pencil:default`. Failures here are
  // non-fatal — pencil-only gating still works without the listener.
  import("@tauri-apps/api/core")
    .then(({ addPluginListener }) => {
      if (typeof addPluginListener !== "function") return;
      return addPluginListener("pencil", "double-tap", () => {
        toggleNotebookEraser();
      });
    })
    .catch((err) => {
      console.warn("[pencil-bridge] failed to register double-tap listener:", err);
    });
}
