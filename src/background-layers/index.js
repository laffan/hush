/**
 * Composite background layers behind the writing surface — the
 * Photoshop-style layer stack that replaced the single Background
 * Image. Each layer is an image, a gradient, or a WebGL2 effect; every
 * layer carries its own blend mode; array order is paint order (index 0
 * at the back).
 *
 * Like shader-layer/, the whole module tree is `import()`ed lazily from
 * style-application.js only when a style actually has enabled layers,
 * so users without them pay nothing.
 *
 * Public surface:
 *   - applyBackgroundLayers({ layers, appearance, container, getEditorView })
 *   - unmountBackgroundLayers()
 *
 * The host is a single absolutely-positioned div inserted *inside* the
 * editor element (or the given container, for the style modal preview),
 * painted with the surface's resolved background colour so per-layer
 * mix-blend-modes composite against the real page colour. The colour is
 * passed in explicitly (`backdropColor`) rather than picked up with
 * `background: inherit`: the editor element is transparent under some
 * theme/style combinations, and blending against a transparent backdrop
 * silently turns every blend mode into a no-op or a black wash.
 */
import { mountImageLayer } from "./layer-image.js";
import { mountGradientLayer } from "./layer-gradient.js";
import { mountWebglLayer } from "./layer-webgl.js";
import { mountCaretLayer } from "./layer-caret.js";
import { acquireCaretSource, releaseCaretSource } from "./caret-tracker.js";

export { WEBGL_BG_EFFECTS, CARET_PRESETS, resolveEffectOptions, defaultGradientNodes } from "./effects-registry.js";

const HOST_ID = "background-layers-host";

let _state = null;
// _state: { host, container, signature, children: [{ id, inst }],
//           resizeObs, visHandler, focusHandler, blurHandler,
//           caretMode: "editor"|"synthetic"|null, syntheticSource }

let _queue = Promise.resolve();

// While the style modal owns a scoped preview, editor-context applies
// (triggered by the modal's own live saves emitting `style-changed`)
// are ignored so they can't steal the layers back to fullscreen
// mid-edit. The modal clears the lock before its final unmount.
let _scopedLock = false;
export function setScopedPreviewLock(v) { _scopedLock = !!v; }

/** Serialized apply — modal sliders can fire faster than async layer
 *  mounts resolve; the queue keeps mounts/updates in call order. */
export function applyBackgroundLayers(cfg) {
  _queue = _queue.then(() => {
    if (_scopedLock && !cfg.container) return;
    return doApply(cfg);
  }).catch(e => console.warn("background layers apply failed", e));
  return _queue;
}

export function unmountBackgroundLayers() {
  _queue = _queue.then(() => { if (!_scopedLock) teardown(); }).catch(() => {});
  return _queue;
}

function editorParent() {
  return document.querySelector("#editor-container .cm-editor")
    || document.getElementById("editor-container");
}

function ensureHost(container, backdropColor) {
  const parent = container || editorParent();
  if (!parent) return null;
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = [
    "position:absolute",
    "inset:0",
    // A stacking context, so the layers' blend modes are isolated to
    // this host and can't reach the chrome painted behind the surface.
    "z-index:0",
    "pointer-events:none",
    "overflow:hidden",
  ].join(";");
  host.style.background = backdropColor || "inherit";
  parent.insertBefore(host, parent.firstChild);
  return host;
}

/** The colour blend modes composite against. Callers pass the surface's
 *  resolved background; falling back to the parent's computed colour
 *  keeps a caller that can't resolve one from blending into the void. */
function resolveBackdrop(container, backdropColor) {
  if (backdropColor) return backdropColor;
  const parent = container || editorParent();
  if (!parent) return null;
  let el = parent;
  while (el) {
    const c = getComputedStyle(el).backgroundColor;
    if (c && c !== "transparent" && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(c)) return c;
    el = el.parentElement;
  }
  return null;
}

/** A stand-in caret source for scoped previews (no editor caret there):
 *  follows the pointer over the container, and drifts in a slow orbit
 *  around the centre when the pointer has been away for a couple of
 *  seconds so caret effects stay visible in the preview pane. */
function createSyntheticCaretSource(container) {
  const pos = { x: 0, y: 0, t: 0, valid: true };
  let lastPointer = 0;
  const onMove = (e) => {
    pos.x = e.clientX;
    pos.y = e.clientY;
    pos.t = lastPointer = performance.now();
  };
  container.addEventListener("pointermove", onMove);
  return {
    get() {
      const now = performance.now();
      if (now - lastPointer > 2000) {
        const r = container.getBoundingClientRect();
        const t = now / 1000;
        pos.x = r.left + r.width * (0.5 + 0.25 * Math.cos(t * 0.7));
        pos.y = r.top + r.height * (0.5 + 0.25 * Math.sin(t * 0.9));
        pos.t = now;
      }
      return pos;
    },
    dispose() { container.removeEventListener("pointermove", onMove); },
  };
}

function layerSignature(layers, container, backdrop) {
  return layers.map(l => `${l.id}:${l.type}`).join("|")
    + "@" + (container ? "scoped" : "editor")
    + "#" + (backdrop || "");
}

async function doApply({ layers, appearance, container, getEditorView, backdropColor }) {
  const enabled = (layers || []).filter(l => l && l.enabled !== false);
  if (!enabled.length) { teardown(); return; }

  const wantContainer = container || null;
  const backdrop = resolveBackdrop(wantContainer, backdropColor);
  const signature = layerSignature(enabled, wantContainer, backdrop);

  // In-place update only when the structure matches AND the host is
  // still attached to the same live container — a modal re-render
  // recreates the preview pane, orphaning the old host, so identity +
  // connectedness must both hold.
  if (_state && _state.signature === signature
      && _state.container === wantContainer && _state.host.isConnected) {
    for (let i = 0; i < enabled.length; i++) {
      await _state.children[i]?.inst?.update?.(enabled[i], appearance);
    }
    return;
  }

  teardown();
  const host = ensureHost(wantContainer, backdrop);
  if (!host) return;

  const needsCaret = enabled.some(l => l.type === "caret");
  let caretMode = null;
  let syntheticSource = null;
  let caretSource = { get: () => ({ x: 0, y: 0, t: 0, valid: false }) };
  if (needsCaret) {
    if (wantContainer) {
      syntheticSource = createSyntheticCaretSource(wantContainer);
      caretSource = syntheticSource;
      caretMode = "synthetic";
    } else {
      caretSource = acquireCaretSource(() => getEditorView?.() || null);
      caretMode = "editor";
    }
  }

  const ctx = {
    width: host.clientWidth || window.innerWidth,
    height: host.clientHeight || window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  };

  const children = [];
  for (const layer of enabled) {
    const child = document.createElement("div");
    child.className = "bg-layer-slot";
    child.style.cssText = "position:absolute;inset:0;pointer-events:none";
    host.appendChild(child);
    let inst = null;
    try {
      if (layer.type === "image") inst = mountImageLayer(child, layer, appearance);
      else if (layer.type === "gradient") inst = mountGradientLayer(child, layer, appearance, ctx);
      else if (layer.type === "webgl") inst = await mountWebglLayer(child, layer, appearance, ctx);
      else if (layer.type === "caret") inst = mountCaretLayer(child, layer, appearance, ctx, caretSource);
    } catch (e) { console.warn("background layer mount failed", e); }
    children.push({ id: layer.id, inst, el: child });
  }

  const resizeObs = new ResizeObserver(() => {
    const w = host.clientWidth || window.innerWidth;
    const h = host.clientHeight || window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    for (const c of children) c.inst?.resize?.(w, h, dpr);
  });
  resizeObs.observe(host);

  const setVisible = (v) => { for (const c of children) c.inst?.setVisible?.(v); };
  const visHandler = () => setVisible(!document.hidden && document.hasFocus());
  const focusHandler = () => setVisible(!document.hidden);
  const blurHandler = () => setVisible(false);
  document.addEventListener("visibilitychange", visHandler);
  window.addEventListener("focus", focusHandler);
  window.addEventListener("blur", blurHandler);

  _state = {
    host, container: wantContainer, signature, children,
    resizeObs, visHandler, focusHandler, blurHandler,
    caretMode, syntheticSource,
  };
}

function teardown() {
  if (!_state) {
    // Belt and braces: a hot-reload or interrupted mount can leave the
    // host without tracked state.
    document.getElementById(HOST_ID)?.remove();
    return;
  }
  for (const c of _state.children) {
    try { c.inst?.dispose?.(); } catch (e) { console.warn("background layer dispose failed", e); }
  }
  _state.resizeObs.disconnect();
  document.removeEventListener("visibilitychange", _state.visHandler);
  window.removeEventListener("focus", _state.focusHandler);
  window.removeEventListener("blur", _state.blurHandler);
  if (_state.caretMode === "editor") releaseCaretSource();
  _state.syntheticSource?.dispose?.();
  _state.host.remove();
  _state = null;
}
