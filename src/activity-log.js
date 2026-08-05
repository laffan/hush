/**
 * App activity log — the permanent, cross-window record behind
 * Settings → Debug → Activity Log.
 *
 * A browser console dies with its webview, and Hush routinely runs
 * several: the main window, every "Open in new window" child, the
 * settings window, plus Rust-side work no console ever sees. When a desk
 * quietly reshaped itself between launches there was nothing to read
 * afterwards. This is the console that survives.
 *
 * Usage:
 *
 *     import { logActivity } from "../activity-log.js";
 *     logActivity("desks", "warn", "Absorbed a stray skeleton", { deskId });
 *
 * `source` is the subsystem ("desks", "sync", "editor", …) so the viewer
 * can say which process was responsible, the way a devtools console
 * attributes a line to a file.
 *
 * Entries are buffered and flushed on a short timer — a busy pass costs
 * one IPC round trip, not one per line — and flushed eagerly on `error`
 * and on page hide, so a crash or a swipe-away doesn't take the trail
 * with it. Everything here soft-fails: diagnostics must never be able to
 * break the thing they were describing.
 */

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

const FLUSH_MS = 1500;
/** Hard cap on the in-memory buffer, in case a flush can't land (no
 *  backend, disk full). Oldest entries drop first. */
const BUFFER_LIMIT = 500;

let _buffer = [];
let _timer = null;
let _windowLabel = "main";
let _deskFor = () => "";
let _installed = false;

/** Tell the logger which window it's in and how to name the desk in view,
 *  so interleaved multi-window activity stays readable. Called once from
 *  main.js after the window registers; safe to skip (defaults are fine). */
export function configureActivityLog({ windowLabel, deskName } = {}) {
  if (windowLabel) _windowLabel = windowLabel;
  if (typeof deskName === "function") _deskFor = deskName;
}

/** Record one line. `detail` is any JSON-serialisable extra context. */
export function logActivity(source, level, message, detail) {
  let desk = "";
  try { desk = _deskFor() || ""; } catch (_) { /* never let this throw */ }
  _buffer.push({
    t: Date.now(),
    level: level || "info",
    source: source || "app",
    window: _windowLabel,
    desk,
    message: String(message ?? ""),
    detail: stringifyDetail(detail),
  });
  if (_buffer.length > BUFFER_LIMIT) _buffer.splice(0, _buffer.length - BUFFER_LIMIT);
  // Mirror to the real console so live debugging is unchanged.
  const line = `[${source}] ${message}`;
  if (level === "error") console.error(line, detail ?? "");
  else if (level === "warn") console.warn(line, detail ?? "");
  if (level === "error") { void flushActivityLog(); return; }
  if (_timer == null) _timer = setTimeout(() => { void flushActivityLog(); }, FLUSH_MS);
}

function stringifyDetail(detail) {
  if (detail == null) return "";
  if (typeof detail === "string") return detail;
  try {
    const json = JSON.stringify(detail);
    // Keep one entry from swallowing the whole trail.
    return json.length > 4000 ? json.slice(0, 4000) + "…(truncated)" : json;
  } catch (_) {
    return String(detail);
  }
}

/** Push whatever is buffered to disk. Awaited by the flush timer and by
 *  the settings viewer before it reads. */
export async function flushActivityLog() {
  if (_timer != null) { clearTimeout(_timer); _timer = null; }
  if (!IS_TAURI || _buffer.length === 0) return;
  const entries = _buffer.splice(0);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("activity_log_append", { entries });
  } catch (_) {
    // Put them back (bounded) so a transient failure doesn't lose the
    // trail — the next flush retries.
    _buffer = [...entries, ..._buffer].slice(-BUFFER_LIMIT);
  }
}

/** Read the stored log back, oldest first. */
export async function readActivityLog(limit = 0) {
  if (!IS_TAURI) return [];
  await flushActivityLog();
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke("activity_log_read", { limit }) || [];
  } catch (_) {
    return [];
  }
}

export async function clearActivityLog() {
  _buffer = [];
  if (!IS_TAURI) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("activity_log_clear");
  } catch (_) { /* nothing to do */ }
}

/**
 * Capture the things a developer console would have shown anyway:
 * `console.warn` / `console.error`, uncaught exceptions, and unhandled
 * promise rejections. `console.log` is deliberately left alone — it's
 * high-volume and mostly noise, and the point of this log is a signal
 * trail you can still read a week later.
 *
 * Idempotent, so multiple windows and the settings webview can each call
 * it at boot.
 */
export function installActivityCapture() {
  if (_installed || typeof window === "undefined") return;
  _installed = true;

  for (const level of ["warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      try {
        const [first, ...rest] = args;
        // Re-entrancy guard: logActivity mirrors to console itself.
        if (typeof first === "string" && first.startsWith("[")) return;
        _buffer.push({
          t: Date.now(),
          level,
          source: "console",
          window: _windowLabel,
          desk: safeDesk(),
          message: args.map(describe).join(" "),
          detail: rest.length ? stringifyDetail(rest.map(describe)) : "",
        });
        if (_timer == null) _timer = setTimeout(() => { void flushActivityLog(); }, FLUSH_MS);
      } catch (_) { /* logging must never throw */ }
    };
  }

  window.addEventListener("error", (e) => {
    logActivity("uncaught", "error", e?.message || "Uncaught error", {
      source: e?.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
      stack: e?.error?.stack,
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e?.reason;
    logActivity("uncaught", "error", `Unhandled rejection: ${reason?.message || reason}`, {
      stack: reason?.stack,
    });
  });
  // A swipe-away on iPad never runs `beforeunload`; visibilitychange is
  // the only reliable "we might not come back" signal there.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushActivityLog();
  });
  window.addEventListener("pagehide", () => { void flushActivityLog(); });
}

function safeDesk() {
  try { return _deskFor() || ""; } catch (_) { return ""; }
}

function describe(v) {
  if (typeof v === "string") return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}
