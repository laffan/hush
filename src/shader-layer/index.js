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
//   { id, name, family: "css" | "canvas2d" | "webgl2", load: () => Promise<Module> }
// Each loaded module must export:
//   default function mount(host, ctx) → returns { update?, dispose }
// `host` is the shared overlay div. `ctx` is { intensity, dpr, onResize, onVisible }.
export const SHADER_LAYERS = [
  { id: "css-vignette-scanlines", name: "Vignette + Scanlines (CSS)",
    family: "css",
    load: () => import("./layers/css-vignette-scanlines.js") },
  { id: "canvas-dust-flicker", name: "Dust + Film Flicker (2D Canvas)",
    family: "canvas2d",
    load: () => import("./layers/canvas-dust-flicker.js") },
  { id: "webgl-crt", name: "CRT — Scanlines + Curvature (WebGL2)",
    family: "webgl2",
    load: () => import("./layers/webgl-crt.js") },
];

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
      "contain:strict",
    ].join(";");
    wantContainer.appendChild(host);
  } else {
    // Fullscreen — covers writing surfaces, stays below sidebar (200) and
    // every modal layer. pointer-events: none so the editor still
    // receives clicks even when an opaque layer sits on top.
    host.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:100",
      "pointer-events:none",
      "overflow:hidden",
      "contain:strict",
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
 *  + container just updates intensity; a different layer or container
 *  tears down + mounts fresh.
 *
 *  `container` is optional — pass an element to scope the shader to that
 *  element (used for in-modal previews). Default is fullscreen overlay. */
export async function applyShaderLayer({ layerId, intensity, container }) {
  const reg = findLayer(layerId);
  if (!reg) { unmountShaderLayer(); return; }

  const wantContainer = container || null;

  // Same layer + same container — just push the new intensity through.
  if (_state && _state.layerId === layerId && _hostContainer === wantContainer) {
    _state.instance?.update?.({ intensity: clampIntensity(intensity) });
    return;
  }

  // Different layer or container — wipe and rebuild.
  unmountShaderLayer();
  const host = ensureHost(wantContainer);
  const mod = await reg.load();
  const ctx = buildCtx(host, intensity);
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
function buildCtx(host, intensity) {
  const ctx = {
    intensity: clampIntensity(intensity),
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
