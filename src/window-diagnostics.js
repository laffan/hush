/**
 * Window and screen diagnostics — the trail for "what was the window
 * doing when that happened?"
 *
 * iPad is the reason this exists. A window there can be resized by Split
 * View, handed a different display by Stage Manager, suspended in the app
 * switcher, or torn down entirely — and all of it happens with no console
 * attached and, quite often, no chance to run cleanup code afterwards.
 * When Hush comes back the only evidence left is what it wrote down
 * (`activity-log.js`), so this module writes down the shape of the window
 * and the screen it is on, and every transition between shapes.
 *
 * What it records, all under the `window` source:
 *
 *  - **A boot snapshot** — window label, whether it is a secondary
 *    window, screen and viewport geometry, device pixel ratio, safe-area
 *    insets, and the app's display mode. This is the baseline every later
 *    line is a diff against.
 *  - **Geometry changes** — `resize`, `orientationchange`, visual
 *    viewport changes, and (separately, because it is the interesting
 *    one) a change of `devicePixelRatio` or of the screen the window
 *    reports. Coalesced on a short trailing timer: dragging a Stage
 *    Manager window fires resize continuously, and a line per frame is
 *    not a trail, it is a flood. Only fields that actually moved are
 *    logged.
 *  - **Lifecycle** — visibility, focus/blur, `pagehide`, `freeze` /
 *    `resume`. A log that stops at "hidden" and picks up at a fresh boot
 *    says the OS reclaimed the app; one that stops mid-sentence says it
 *    crashed. Those are different bugs and this is how they are told
 *    apart.
 *  - **The window registry** — the set of live Hush windows, whenever it
 *    changes.
 *
 * Nothing here is on a hot path: every listener does a handful of
 * property reads and drops out early when nothing changed.
 */

import { logActivity } from "./activity-log.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

/** Trailing coalesce for geometry bursts. Long enough to swallow a Stage
 *  Manager drag or a rotation animation, short enough that the line still
 *  lands next to whatever it explains. */
const GEOMETRY_SETTLE_MS = 400;

let _installed = false;
let _label = "main";
let _lastGeometry = null;
let _settleTimer = null;
let _lastRegistry = "";

/** Round to whole pixels — sub-pixel viewport jitter is not a change
 *  anybody needs a log line about. */
function px(n) {
  return typeof n === "number" && isFinite(n) ? Math.round(n) : null;
}

/** Read the `env(safe-area-inset-*)` values the CSS actually resolves to.
 *  There is no JS API for them, so they are round-tripped through a
 *  throwaway element. iPadOS does NOT report its own reserved bands here
 *  (see the `--ipad-safe-top/bottom` tokens in base.css) — this is the
 *  notch/home-indicator set only. */
function safeAreaInsets() {
  if (typeof document === "undefined" || !document.body) return null;
  const probe = document.createElement("div");
  probe.style.cssText = [
    "position:absolute", "visibility:hidden", "pointer-events:none",
    "top:env(safe-area-inset-top)", "right:env(safe-area-inset-right)",
    "bottom:env(safe-area-inset-bottom)", "left:env(safe-area-inset-left)",
  ].join(";");
  document.body.appendChild(probe);
  try {
    const cs = getComputedStyle(probe);
    return {
      top: px(parseFloat(cs.top)),
      right: px(parseFloat(cs.right)),
      bottom: px(parseFloat(cs.bottom)),
      left: px(parseFloat(cs.left)),
    };
  } catch (_) {
    return null;
  } finally {
    probe.remove();
  }
}

/** Everything about this window's box and the screen behind it.
 *  Deliberately flat and JSON-safe: it is compared field by field
 *  against the previous reading and diffed into the log. */
export function readWindowGeometry() {
  if (typeof window === "undefined") return {};
  const s = window.screen || {};
  const vv = window.visualViewport;
  const g = {
    innerWidth: px(window.innerWidth),
    innerHeight: px(window.innerHeight),
    outerWidth: px(window.outerWidth),
    outerHeight: px(window.outerHeight),
    screenWidth: px(s.width),
    screenHeight: px(s.height),
    screenAvailWidth: px(s.availWidth),
    screenAvailHeight: px(s.availHeight),
    colorDepth: typeof s.colorDepth === "number" ? s.colorDepth : null,
    dpr: typeof window.devicePixelRatio === "number"
      ? Math.round(window.devicePixelRatio * 100) / 100
      : null,
    orientation: s.orientation?.type || null,
    visualWidth: vv ? px(vv.width) : null,
    visualHeight: vv ? px(vv.height) : null,
    visualScale: vv && typeof vv.scale === "number"
      ? Math.round(vv.scale * 100) / 100
      : null,
  };
  const insets = safeAreaInsets();
  if (insets) g.safeArea = `${insets.top},${insets.right},${insets.bottom},${insets.left}`;
  return g;
}

/** Fields in `next` whose value differs from `prev`, as
 *  `{ field: "before → after" }`. Returns null when nothing moved. */
function geometryDiff(prev, next) {
  if (!prev) return null;
  const out = {};
  for (const key of Object.keys(next)) {
    if (prev[key] !== next[key]) out[key] = `${prev[key]} → ${next[key]}`;
  }
  return Object.keys(out).length ? out : null;
}

/** The environment that doesn't change while the window is alive. */
function staticEnvironment() {
  const nav = typeof navigator !== "undefined" ? navigator : {};
  return {
    label: _label,
    userAgent: (nav.userAgent || "").slice(0, 180),
    platform: nav.platform || "",
    maxTouchPoints: typeof nav.maxTouchPoints === "number" ? nav.maxTouchPoints : null,
    standalone: typeof window !== "undefined"
      && !!window.matchMedia?.("(display-mode: standalone)")?.matches,
    fullscreenMedia: typeof window !== "undefined"
      && !!window.matchMedia?.("(display-mode: fullscreen)")?.matches,
  };
}

/** A full picture in one line: static environment plus current geometry
 *  plus whatever the caller wants to say about why it is asking. Used at
 *  boot, from the Debug tab's button, and any time an unexplained
 *  transition wants a fresh baseline. */
export function logWindowSnapshot(reason, extra) {
  const geometry = readWindowGeometry();
  _lastGeometry = geometry;
  logActivity("window", "info", `Window snapshot (${reason})`, {
    ...staticEnvironment(),
    ...geometry,
    visibility: typeof document !== "undefined" ? document.visibilityState : null,
    hasFocus: typeof document !== "undefined" && typeof document.hasFocus === "function"
      ? document.hasFocus()
      : null,
    ...(extra || {}),
  });
}

/** Compare against the last reading and log the difference, if any.
 *  `trigger` names the event that prompted the look. */
function checkGeometry(trigger) {
  const next = readWindowGeometry();
  const diff = geometryDiff(_lastGeometry, next);
  _lastGeometry = next;
  if (!diff) return;
  // A change of pixel ratio or of screen size means the window is on a
  // different display — the transition every canvas backing store in the
  // app gets reallocated across, and the one worth finding in the log.
  const movedDisplay = "dpr" in diff || "screenWidth" in diff || "screenHeight" in diff;
  logActivity(
    "window",
    movedDisplay ? "warn" : "info",
    movedDisplay ? "Window changed display" : "Window geometry changed",
    { label: _label, trigger, ...diff },
  );
}

function scheduleGeometryCheck(trigger) {
  if (_settleTimer) clearTimeout(_settleTimer);
  _settleTimer = setTimeout(() => {
    _settleTimer = null;
    checkGeometry(trigger);
  }, GEOMETRY_SETTLE_MS);
}

/** Log a lifecycle transition. These are cheap and rare, so each one
 *  gets its own line rather than being coalesced. */
function logLifecycle(event, detail) {
  logActivity("window", "info", `Window ${event}`, { label: _label, ...(detail || {}) });
}

/**
 * Install the listeners. Idempotent, and safe to call from any webview
 * (the settings window included). `label` is this window's Tauri label so
 * interleaved multi-window lines can be told apart — the activity log
 * stamps it too, but having it in the payload keeps a copied fragment
 * self-describing.
 */
export function installWindowDiagnostics({ label } = {}) {
  if (_installed || typeof window === "undefined") return;
  _installed = true;
  if (label) _label = label;
  _lastGeometry = readWindowGeometry();

  window.addEventListener("resize", () => scheduleGeometryCheck("resize"));
  window.addEventListener("orientationchange", () => scheduleGeometryCheck("orientationchange"));
  window.visualViewport?.addEventListener("resize", () => scheduleGeometryCheck("visualViewport"));

  // A pixel-ratio change has no event of its own. `matchMedia` on the
  // *current* ratio does: the query stops matching the instant the ratio
  // moves, so re-arming it after each fire tracks the value indefinitely.
  // This is the only signal that fires when a window is dragged between
  // displays of equal size but different scale.
  const watchPixelRatio = () => {
    const dpr = window.devicePixelRatio || 1;
    let mql;
    try {
      mql = window.matchMedia(`(resolution: ${dpr}dppx)`);
    } catch (_) {
      return; // older WebKit without `resolution` support
    }
    const onChange = () => {
      mql.removeEventListener?.("change", onChange);
      checkGeometry("devicePixelRatio");
      watchPixelRatio();
    };
    mql.addEventListener?.("change", onChange);
  };
  watchPixelRatio();

  document.addEventListener("visibilitychange", () => {
    logLifecycle(`visibility: ${document.visibilityState}`);
    // Coming back can be coming back onto a different screen.
    if (document.visibilityState === "visible") scheduleGeometryCheck("visible");
  });
  window.addEventListener("focus", () => logLifecycle("focused"));
  window.addEventListener("blur", () => logLifecycle("blurred"));
  // `persisted` distinguishes "into the back/forward cache" from "gone".
  window.addEventListener("pagehide", (e) => logLifecycle("pagehide", { persisted: !!e.persisted }));
  window.addEventListener("pageshow", (e) => logLifecycle("pageshow", { persisted: !!e.persisted }));
  // Page Lifecycle API — WebKit fires these when the system freezes a
  // backgrounded tab/scene. A freeze immediately before the log goes
  // quiet is the OS reclaiming us, not a crash.
  document.addEventListener("freeze", () => logLifecycle("frozen"));
  document.addEventListener("resume", () => logLifecycle("resumed"));

  // The set of live Hush windows, whenever the registry revises it. The
  // event fires on every window, so each window's log carries its own
  // view of the group — which is exactly what you want when one of them
  // has stopped heartbeating.
  if (IS_TAURI) {
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        await listen("windows-updated", (event) => {
          const list = Array.isArray(event.payload) ? event.payload : [];
          const summary = list
            .map((w) => `${w.number}:${w.label}${w.fileType ? `(${w.fileType})` : ""}`)
            .join(" ");
          if (summary === _lastRegistry) return; // our own echo of an unchanged list
          _lastRegistry = summary;
          logActivity("window", "info", "Window registry changed", {
            label: _label,
            count: list.length,
            windows: summary,
          });
        });
      } catch (_) { /* event bridge unavailable — diagnostics are optional */ }
    })();
  }
}
