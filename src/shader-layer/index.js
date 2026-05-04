/**
 * Optional post-processing shader layer mounted over the writing surfaces.
 *
 * The whole module — and every layer module under ./layers/ — is loaded
 * lazily via `import()` so a user with no shader configured pays nothing:
 * the bundle is its own Vite chunk, no DOM is added, no canvas/WebGL
 * context is created, no listeners are installed.
 *
 * Public surface used from style-application.js is exactly two functions:
 *   - applyShaderLayer(config) — mount the requested layer (or swap it)
 *   - unmountShaderLayer()      — tear it down completely
 *
 * `config` shape: { layerId: string, intensity: number (0..1) }
 *
 * The layer registry maps id → { name, family, load }. `load` is itself a
 * dynamic import so picking "CRT" doesn't pull in the dust / vignette code.
 */

const HOST_ID = "shader-layer-host";
// Tracks the container the host was last appended to. When the caller
// asks for a different container (e.g. modal preview pane) we tear the
// host down and rebuild it scoped to the new parent.
let _hostContainer = null;

// Registry of every shipped layer. Shape:
//   { id, name, family, load, settings }
// `settings` is a small per-layer schema (kept here, not in the layer
// module, so the modal can render knobs without needing to import the
// layer code first). Each setting:
//   { id, label, type: "range" | "color", min?, max?, step?, default }
// The user's chosen values live on draft.shaderLayer.options keyed by
// setting id and are passed into the layer's mount/update via
// ctx.options.
export const SHADER_LAYERS = [
  {
    id: "css-vignette-scanlines",
    name: "Vignette + Scanlines (CSS)",
    family: "css",
    load: () => import("./layers/css-vignette-scanlines.js"),
    settings: [
      { id: "vignetteStrength", label: "Vignette darkness", type: "range", min: 0, max: 1, step: 0.01, default: 0.5 },
      { id: "scanlineOpacity", label: "Scanline opacity", type: "range", min: 0, max: 1, step: 0.01, default: 0.15 },
      { id: "scanlineColor", label: "Scanline color", type: "color", default: "#000000" },
    ],
  },
  {
    id: "css-phosphor-scanlines",
    name: "Phosphor Scanlines (CSS)",
    family: "css",
    load: () => import("./layers/css-phosphor-scanlines.js"),
    settings: [
      { id: "glow", label: "Text glow (sharp)", type: "range", min: 0, max: 1, step: 0.01, default: 0.4 },
      { id: "halo", label: "Text halo (soft)", type: "range", min: 0, max: 1, step: 0.01, default: 0.6 },
      { id: "scanlineOpacity", label: "Scanline opacity", type: "range", min: 0, max: 1, step: 0.01, default: 0.2 },
      { id: "scanlineColor", label: "Scanline color", type: "color", default: "#000000" },
    ],
  },
  {
    id: "webgl-neon-bloom",
    name: "Neon Bloom (WebGL2)",
    family: "webgl2",
    load: () => import("./layers/webgl-neon-bloom.js"),
    settings: [
      { id: "brightness", label: "Bloom brightness", type: "range", min: 0, max: 1, step: 0.01, default: 0.55 },
      { id: "speed", label: "Drift speed", type: "range", min: 0, max: 1, step: 0.01, default: 0.4 },
      { id: "color1", label: "Bloom color 1", type: "color", default: "#f334a6" },
      { id: "color2", label: "Bloom color 2", type: "color", default: "#34c4f4" },
      { id: "color3", label: "Bloom color 3", type: "color", default: "#8c4ce8" },
    ],
  },
];

/** Resolve full options for a layer: defaults from registry overlaid by
 *  user-supplied values. Used by both applyShaderLayer and the modal. */
export function resolveLayerOptions(layerId, userOptions) {
  const reg = findLayer(layerId);
  if (!reg) return {};
  const out = {};
  for (const s of (reg.settings || [])) {
    out[s.id] = (userOptions && s.id in userOptions) ? userOptions[s.id] : s.default;
  }
  return out;
}

let _state = null;
// _state shape when active:
//   { layerId, host, instance, dispose, resizeObs, visHandler, focusHandler }

function ensureHost(container) {
  // `container` null/undefined → fullscreen overlay (default).
  // `container` element → host appended into it as an absolutely-positioned
  //   overlay (used by the style modal to scope the preview to the
  //   preview pane).
  const wantContainer = container || null;
  let host = document.getElementById(HOST_ID);
  if (host && _hostContainer === wantContainer) return host;

  if (host) host.remove(); // container changed — rebuild

  host = document.createElement("div");
  host.id = HOST_ID;
  if (wantContainer) {
    // Scoped — fill the parent. The parent must be position: relative or
    // similar; the modal preview pane already is.
    host.style.cssText = [
      "position:absolute",
      "inset:0",
      "z-index:1",
      "pointer-events:none",
      "overflow:hidden",
    ].join(";");
    wantContainer.appendChild(host);
  } else {
    // Fullscreen — covers all UI chrome including the floating sidebar
    // toggle (which lives at --z-modal: 500). Modal *content*
    // (--z-modal-content: 510) stays above the shader so style modal,
    // settings, etc. remain visually clean and interactive while open.
    // pointer-events: none means the host never intercepts clicks —
    // every chrome element beneath remains interactive even when
    // visually under the shader.
    host.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:501",
      "pointer-events:none",
      "overflow:hidden",
    ].join(";");
    document.body.appendChild(host);
  }
  _hostContainer = wantContainer;
  return host;
}

function findLayer(id) {
  return SHADER_LAYERS.find(l => l.id === id) || null;
}

/** Mount the requested layer. Idempotent: a re-call with the same layer
 *  + container just updates intensity / options; a different layer or
 *  container tears down + mounts fresh.
 *
 *  `container` is optional — pass an element to scope the shader to that
 *  element (used for in-modal previews). Default is fullscreen overlay.
 *  `options` is the per-layer knob values; missing keys fall back to
 *  the registry defaults. */
export async function applyShaderLayer({ layerId, intensity, container, options }) {
  const reg = findLayer(layerId);
  if (!reg) { unmountShaderLayer(); return; }

  const wantContainer = container || null;
  const fullOptions = resolveLayerOptions(layerId, options);

  // Same layer + same container — just push the new values through.
  if (_state && _state.layerId === layerId && _hostContainer === wantContainer) {
    _state.instance?.update?.({
      intensity: clampIntensity(intensity),
      options: fullOptions,
    });
    return;
  }

  // Different layer or container — wipe and rebuild.
  unmountShaderLayer();
  const host = ensureHost(wantContainer);
  const mod = await reg.load();
  const ctx = buildCtx(host, intensity, fullOptions);
  const instance = await mod.default(host, ctx);

  _state = {
    layerId,
    host,
    instance,
    dispose: instance?.dispose,
    resizeObs: ctx._resizeObs,
    visHandler: ctx._visHandler,
    focusHandler: ctx._focusHandler,
    blurHandler: ctx._blurHandler,
  };
}

export function unmountShaderLayer() {
  if (!_state) return;
  try { _state.dispose?.(); } catch (e) { console.warn("shader dispose failed", e); }
  if (_state.resizeObs) _state.resizeObs.disconnect();
  if (_state.visHandler) document.removeEventListener("visibilitychange", _state.visHandler);
  if (_state.focusHandler) window.removeEventListener("focus", _state.focusHandler);
  if (_state.blurHandler) window.removeEventListener("blur", _state.blurHandler);
  const host = document.getElementById(HOST_ID);
  if (host) host.remove();
  _state = null;
  _hostContainer = null;
}

/** Belt-and-suspenders cleanup. Each layer's dispose() should already
 *  scrub everything it added, but if something glitched mid-mount or a
 *  caller forced a teardown via dev tools, this finds and removes any
 *  shader-layer-* artifacts still lingering on the page.
 *
 *  Safe to call any time; idempotent. Exposed on window for "pull the
 *  plug" use from the dev console:
 *      window.__hushShaderPanicCleanup()
 */
export function panicCleanup() {
  // Drop any active state without trying to call into a layer that
  // might already be in a bad shape.
  _state = null;
  _hostContainer = null;
  // Remove the host element regardless of state tracking.
  document.getElementById(HOST_ID)?.remove();
  // Remove any injected stylesheets shipped by layers (their ids all
  // start with "shader-layer-").
  document.querySelectorAll('style[id^="shader-layer-"]').forEach(el => el.remove());
  // Strip any scope classes the layers might have added.
  document.querySelectorAll('[class*="shader-layer-"]').forEach(el => {
    const classes = Array.from(el.classList).filter(c => c.startsWith("shader-layer-"));
    classes.forEach(c => el.classList.remove(c));
  });
  // Clear any custom properties set on documentElement / body / known
  // scope candidates. We can't enumerate per-element setProperty values
  // generically, but layers set them on body or modal preview pane,
  // both of which we can scrub directly.
  for (const el of [document.documentElement, document.body]) {
    for (const prop of Array.from(el.style)) {
      if (prop.startsWith("--shader-layer-")) el.style.removeProperty(prop);
    }
  }
}

if (typeof window !== "undefined") {
  window.__hushShaderPanicCleanup = panicCleanup;
}

function clampIntensity(v) {
  if (typeof v !== "number" || Number.isNaN(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

/** Build the per-mount ctx that gets handed to layer modules. The layer
 *  doesn't have to wire its own visibility / focus / resize plumbing — we
 *  do it once here and let the layer subscribe through callbacks.
 *
 *  This is the gate that keeps "on" cheap: animated layers only run their
 *  rAF loop while the page is visible AND the window is focused. Static
 *  layers ignore the visibility callbacks entirely. */
function buildCtx(host, intensity, options) {
  const ctx = {
    intensity: clampIntensity(intensity),
    options: options || {},
    dpr: window.devicePixelRatio || 1,
    width: host.clientWidth || window.innerWidth,
    height: host.clientHeight || window.innerHeight,
    _onResize: null,
    _onVisible: null,
  };

  // Resize plumbing — observe the host (which fills the viewport) so DPR
  // changes from a window drag between displays are picked up.
  const resizeObs = new ResizeObserver(() => {
    ctx.dpr = window.devicePixelRatio || 1;
    ctx.width = host.clientWidth || window.innerWidth;
    ctx.height = host.clientHeight || window.innerHeight;
    ctx._onResize?.(ctx);
  });
  resizeObs.observe(host);
  ctx._resizeObs = resizeObs;

  // Visibility / focus plumbing.
  const visHandler = () => ctx._onVisible?.(!document.hidden && document.hasFocus());
  const focusHandler = () => ctx._onVisible?.(!document.hidden);
  const blurHandler = () => ctx._onVisible?.(false);
  document.addEventListener("visibilitychange", visHandler);
  window.addEventListener("focus", focusHandler);
  window.addEventListener("blur", blurHandler);
  ctx._visHandler = visHandler;
  ctx._focusHandler = focusHandler;
  ctx._blurHandler = blurHandler;

  // The setters layers actually use — set these on first mount, then we
  // call them on every change.
  Object.defineProperty(ctx, "onResize", {
    set(fn) { ctx._onResize = fn; },
  });
  Object.defineProperty(ctx, "onVisible", {
    set(fn) { ctx._onVisible = fn; },
  });

  return ctx;
}
