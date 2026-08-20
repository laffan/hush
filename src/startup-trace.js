/**
 * Startup trace — one row per boot phase, from the moment the document's
 * markup is parsed to the moment the first surface is on screen.
 *
 * Why it exists: Hush's window is `transparent: true`, so every
 * millisecond between process launch and first paint is a black window
 * (see the splash note in `index.html`). "It takes five seconds to open"
 * is not a bug anyone can act on until the five seconds are broken into
 * named pieces, and the pieces that matter — the whole-library read in
 * `list_files`, the module graph the entry point drags in — are invisible
 * from the outside.
 *
 * The recording itself is unconditional and costs two `performance.now()`
 * calls plus one object per phase, which is nothing next to the work each
 * phase is measuring. The `trackStartupTiming` setting gates only whether
 * the run is *persisted* for Settings → Debug to read; the settings window
 * is a separate webview and can't see this one's memory, so the numbers
 * have to go through disk (or through the capture request below, which is
 * how flipping the toggle on shows the launch you're already in rather
 * than making you relaunch).
 *
 * Phases nest: `phase()` inside `phase()` records a deeper `depth`, and
 * the flat array stays in start order, so the panel can indent without
 * reassembling a tree. The depth counter is a plain module global, which
 * is only correct because boot is strictly serial — two phases started
 * concurrently would each claim the other's depth. Time concurrent work
 * as one phase around the `Promise.all`, not one per branch.
 */

import { logActivity } from "./activity-log.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

/** @type {{ name: string, depth: number, startMs: number, ms: number }[]} */
const phases = [];
let depth = 0;
let finished = null;

/** Time an async step. Returns whatever `fn` returns. */
export async function phase(name, fn) {
  const rec = { name, depth, startMs: performance.now(), ms: 0 };
  phases.push(rec);
  depth++;
  try {
    return await fn();
  } finally {
    depth--;
    rec.ms = performance.now() - rec.startMs;
  }
}

/** Time a synchronous step. Same contract as `phase`. */
export function phaseSync(name, fn) {
  const rec = { name, depth, startMs: performance.now(), ms: 0 };
  phases.push(rec);
  depth++;
  try {
    return fn();
  } finally {
    depth--;
    rec.ms = performance.now() - rec.startMs;
  }
}

/**
 * The document's own cost, before `init()` ran: parse of `index.html` and
 * its render-blocking stylesheet, then fetch, parse, compile *and*
 * top-level evaluation of everything `main.js` statically imports.
 * `__hushSplashAt` is stamped by the inline script in `index.html`; this
 * module's body runs inside the entry chunk, and ES modules evaluate
 * depth-first, so the clock read here lands after the bulk of the graph
 * has run — which is the number that matters.
 */
const moduleReadyAt = performance.now();
const documentAt = typeof window !== "undefined" && window.__hushSplashAt != null
  ? window.__hushSplashAt
  : 0;

/** Native (Rust) phases, fetched once at the end of boot. */
let nativeTrace = null;

async function readNativeTrace() {
  if (!IS_TAURI) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const trace = await invoke("get_startup_native_timings");
    if (!trace) return null;
    // `sinceLaunchMs` is measured inside the call; subtracting this
    // webview's own clock leaves the stretch before it started
    // navigating — the launch cost no JS timer can see.
    trace.processToWebviewMs = Math.max(
      0,
      Math.round(trace.sinceLaunchMs - performance.now()),
    );
    return trace;
  } catch (_) {
    // Older binary, or the command isn't there yet — the webview half of
    // the trace is still worth having on its own.
    return null;
  }
}

/** The trace as the Debug panel wants it. Safe to call at any point. */
export function getStartupTrace() {
  const totalMs = finished != null ? finished : performance.now();
  return {
    capturedAt: Date.now(),
    documentMs: documentAt,
    bundleMs: moduleReadyAt - documentAt,
    phases: phases.map((p) => ({ ...p })),
    native: nativeTrace ? nativeTrace.phases : [],
    // How long the native process had already been alive when the webview
    // started navigating — i.e. the launch cost the webview can't see.
    processToWebviewMs: nativeTrace ? nativeTrace.processToWebviewMs : null,
    totalMs,
  };
}

/**
 * Close the trace: stamp the total, pick up the native half, log one line,
 * and persist when tracking is on. Called once, from `main.js`, at the
 * point the user can actually see the app.
 */
export async function finishStartupTrace(state) {
  if (finished != null) return;
  finished = performance.now();
  logActivity("boot", "info", `Startup finished in ${Math.round(finished)} ms`, {
    document: Math.round(documentAt),
    bundle: Math.round(moduleReadyAt - documentAt),
  });
  nativeTrace = await readNativeTrace();
  if (state?.settings?.trackStartupTiming) await persist(state);
}

async function persist(state) {
  // Per-window keys are the main window's to write (README-TECHNICAL,
  // "Multi-window"): a secondary window persisting its own boot would
  // overwrite the launch the user is actually asking about.
  if (state.isSecondaryWindow || !IS_TAURI) return;
  const timings = getStartupTrace();
  state.settings.startupTimings = timings;
  try {
    // Straight to `patch_settings` rather than through
    // `AppState.updateSettings`: nothing in the app reacts to this value,
    // and `updateSettings` would emit `settings-changed` and broadcast to
    // every sibling window — a fan-out of relayout work, fired by a
    // diagnostic, on every launch.
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("patch_settings", { patch: { startupTimings: timings } });
  } catch (e) {
    console.warn("startup trace persist failed:", e);
  }
}

/**
 * Settings → Debug asks for a capture when the toggle is switched on, so
 * the panel can show the launch already in progress instead of demanding a
 * relaunch first. Settings lives in its own webview and has no access to
 * this window's marks, hence the round trip.
 */
export function installStartupTraceBridge(state) {
  if (!IS_TAURI) return;
  void (async () => {
    try {
      const { listen, emit } = await import("@tauri-apps/api/event");
      await listen("hush-startup-timing-capture", async () => {
        if (state.isSecondaryWindow) return;
        if (finished == null) return; // still booting; the finish will persist it
        if (!nativeTrace) nativeTrace = await readNativeTrace();
        await persist(state);
        await emit("hush-startup-timing-captured");
      });
    } catch (e) {
      console.warn("startup trace bridge failed:", e);
    }
  })();
}
