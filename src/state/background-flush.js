/**
 * Write everything unsaved when the app is going away.
 *
 * Every editing surface in Hush persists on a timer — the doc autosave,
 * the notebook bridge's 2 s tick, floating panes, stack columns — and
 * each of those timers stops the moment iPadOS backgrounds the app. What
 * happens next is not up to us: iPadOS reclaims the WKWebView content
 * process of a backgrounded app whenever it wants the memory, and a
 * proofread notebook (fifty full-page rasters) is the hungriest thing
 * Hush puts on screen, so it is first in the queue. Returning to the app
 * then shows a few seconds of black while the page **reloads from
 * scratch** and restores from disk — and everything since the last
 * timer tick that actually landed is gone. That is the "it rebuilt
 * itself and my last few strokes are missing" report, and it is also why
 * a notebook came back at the wrong pan and zoom: the camera rides the
 * same envelope.
 *
 * The reload isn't preventable. Losing work to it is. This runs on the
 * way out and forces each surface to write:
 *
 *  - **Forced, not scheduled.** The notebook's quiet-moment gate and its
 *    camera-only cap exist so a multi-megabyte serialize can't land
 *    mid-stroke or mid-pan. There is no stroke and no pan once the user
 *    has switched apps, so the gate is bypassed (`forceSnapshot`).
 *  - **Sequential.** Each surface writes in turn rather than all at
 *    once: these are main-thread encodes, and racing them just means
 *    everything is half-done when the process is frozen. The notebook
 *    goes first — it is the one carrying the most unsaved work. (Panes
 *    are the exception: `autosaveAllPanes` is the existing fire-and-
 *    forget entry point and there may be several, so they overlap each
 *    other but not the notebook.)
 *  - **Not awaited by the event handler.** iPadOS gives a backgrounded
 *    app a short grace period, not a guarantee. Starting the writes
 *    immediately is what matters; blocking the handler buys nothing.
 *
 * `visibilitychange: hidden` is the signal that fires on an app switch;
 * `pagehide` covers a real teardown. Both can fire for one departure, so
 * the flush coalesces — and the surfaces themselves no-op when clean, so
 * a second pass over a flushed app costs nothing anyway.
 */

import { logActivity, flushActivityLog } from "../activity-log.js";

/** Ignore a second trigger this close behind the first — `pagehide` and
 *  `visibilitychange` routinely arrive together for one departure. Long
 *  enough to cover that pair, short enough that a genuine second
 *  departure (switch away, back, away again) still flushes. */
const COALESCE_MS = 1500;

let _lastFlushAt = 0;
let _inFlight = null;

/**
 * Force every surface holding unsaved work to write. Safe to call at any
 * time; returns when the last write settles. Individual failures are
 * swallowed — one surface that can't save must not stop the others.
 */
export async function flushEverythingNow(state, reason) {
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    const wrote = [];
    // Logged before the work as well as after, and the log is flushed
    // explicitly at the end: if only the "started" line survives, the
    // process was frozen mid-flush, and that is exactly what you want to
    // know when work has gone missing.
    logActivity("files", "info", "Flushing unsaved work on the way out", { reason });
    // Notebook first: the biggest envelope, the most unsaved work, and
    // the surface whose loss the user actually notices. Goes through
    // `runtime.flushNotebook` (main-modes.js) so the save keeps its
    // external-store push and its cross-window broadcast.
    try {
      if (state.currentNotebookFileId && state.runtime.flushNotebook) {
        await state.runtime.flushNotebook({ forceSnapshot: true });
        wrote.push("notebook");
      }
    } catch (e) { logActivity("files", "warn", "Background flush: notebook", { error: String(e) }); }

    try {
      if (state.dirty) { await state.saveCurrentFile(); wrote.push("document"); }
    } catch (e) { logActivity("files", "warn", "Background flush: document", { error: String(e) }); }

    try {
      const m = await import("../pane/pane-content.js");
      m.autosaveAllPanes();
      wrote.push("panes");
    } catch (e) { logActivity("panes", "warn", "Background flush: panes", { error: String(e) }); }

    // Stack columns are separate files on their own timers, and the
    // `.hushstack` carries each column's scroll offset and notebook
    // camera — so a stack left mid-edit loses both halves without this.
    try {
      if (state.currentStackFileId) {
        const m = await import("../stack/stack-bridge.js");
        await m.flushStack();
        wrote.push("stack");
      }
    } catch (e) { logActivity("files", "warn", "Background flush: stack", { error: String(e) }); }

    logActivity("files", "info", "Flushed unsaved work on the way out", {
      reason, surfaces: wrote.join(",") || "none",
    });
    // The activity log's own `hidden` handler registered first and has
    // already been and gone, so both lines above are sitting in its
    // buffer. Push them.
    try { await flushActivityLog(); } catch (_) {}
  })();
  try { await _inFlight; } finally { _inFlight = null; }
}

/** Wire the flush to the signals that mean "this app may not get another
 *  frame". Idempotent per window. */
export function installBackgroundFlush(state) {
  if (typeof document === "undefined") return;
  const go = (reason) => {
    const now = Date.now();
    if (now - _lastFlushAt < COALESCE_MS) return;
    _lastFlushAt = now;
    void flushEverythingNow(state, reason);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") go("hidden");
  });
  // `persisted` means the page went into the back/forward cache and is
  // expected back intact; anything else is a teardown.
  window.addEventListener("pagehide", (e) => { if (!e.persisted) go("pagehide"); });
  // Desktop only in practice — iOS never runs it — but harmless there
  // and it is the signal that fires on a macOS quit.
  window.addEventListener("beforeunload", () => go("beforeunload"));
}
