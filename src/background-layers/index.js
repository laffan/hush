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
 * painted with the surface's own background via `background: inherit`
 * so per-layer mix-blend-modes composite against the real page colour
 * instead of a transparent backdrop.
 */
import { mountImageLayer } from "./layer-image.js";
import { mountGradientLayer } from "./layer-gradient.js";
import { mountWebglLayer } from "./layer-webgl.js";
import { acquireCaretSource, releaseCaretSource } from "./caret-tracker.js";

export { WEBGL_BG_EFFECTS, CARET_EFFECTS, resolveEffectOptions, defaultGradientNodes } from "./effects-registry.js";

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

function ensureHost(container) {
  const parent = container || editorParent();
  if (!parent) return null;
  if (_state && _state.host.parentElement === parent) return _state.host;
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = [
    "position:absolute",
    "inset:0",
    "z-index:0",
    "pointer-events:none",
    "overflow:hidden",
    "background:inherit",
  ].join(";");
  parent.insertBefore(host, parent.firstChild);
  return host;
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

function layerSignature(layers, container) {
  // Caret-effect on/off joins the signature: turning it on must rebuild
  // the layer so it mounts with a live caret source (a layer mounted
  // without one holds the inert placeholder source).
  return layers.map(l =>
    `${l.id}:${l.type}${l.type === "webgl" && l.caretEffect && l.caretEffect !== "none" ? ":caret" : ""}`
  ).join("|") + "@" + (container ? "scoped" : "editor");
}

async function doApply({ layers, appearance, container, getEditorView }) {
  const enabled = (layers || []).filter(l => l && l.enabled !== false);
  if (!enabled.length) { teardown(); return; }

  const wantContainer = container || null;
  const signature = layerSignature(enabled, wantContainer);

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
  const host = ensureHost(wantContainer);
  if (!host) return;

  const needsCaret = enabled.some(l => l.type === "webgl" && l.caretEffect && l.caretEffect !== "none");
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
      else if (layer.type === "webgl") inst = await mountWebglLayer(child, layer, appearance, ctx, caretSource);
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
