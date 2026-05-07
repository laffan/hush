/**
 * iOS pencil bridge — gates strokes to Apple Pencil only on iPad.
 *
 * Iteration history: an earlier version of this module wired the
 * `tauri-plugin-pencil` native plugin (Swift `PencilPlugin`) to flip
 * `setPencilOnly` on a `loaded` event from the iOS side, and to route
 * Apple Pencil double-tap into a draw / erase toggle. Loading the
 * plugin coincided with iPad drawing breaking entirely (likely
 * because the Swift `UIGestureRecognizer` attached to the WKWebView
 * scrollView interfered with how the page receives touches), so the
 * Cargo dep + capability + plugin registration are currently backed
 * out. The bridge module stays in place because the gating itself
 * doesn't need the plugin: iPad WKWebView reliably reports Apple
 * Pencil as `pointerType === "pen"` and finger as `"touch"`, so
 * detecting iOS and flipping `setNotebookPencilOnly(true)` once at
 * startup is sufficient.
 *
 * Pencil double-tap remains a TODO — that *does* require the native
 * plugin since UIPencilInteraction has no PointerEvent equivalent.
 */

import { setNotebookPencilOnly } from "./notes-canvas";

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
}
