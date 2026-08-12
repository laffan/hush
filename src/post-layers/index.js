/**
 * Post-processing layer stack — the effects painted over the whole
 * window (or, in the style modal, over the preview pane).
 *
 * Same shape as `background-layers/`: an ordered array of layers, index
 * 0 at the back, each with its own blend mode, mounted lazily. The whole
 * module tree is `import()`ed from style-application.js only when a
 * style actually has enabled post layers, so a user who never turns one
 * on pays nothing — no DOM, no listeners, no chunk.
 *
 * Public surface:
 *   - applyPostLayers({ layers, container })
 *   - unmountPostLayers()
 *   - setScopedPreviewLock(bool)
 *   - panicCleanup()
 *
 * **The slots are siblings, not children of one host.** A single
 * positioned host would be its own stacking context, and both
 * `mix-blend-mode` and `backdrop-filter` inside it would then sample the
 * host's empty backdrop rather than the page — every effect would render
 * as a no-op or a black wash. Each layer therefore gets its own
 * fixed-position element appended straight to `<body>`, stacked by
 * z-index above the app (and above the modal backdrop at 500, below
 * modal content at 510, so the style editor stays legible while you tune
 * an effect).
 */
import { mountPostEffect, scrubPostArtifacts } from "./effects.js";

export { POST_EFFECTS, findPostEffect, resolvePostOptions, defaultPostLayer } from "./registry.js";

const SLOT_CLASS = "post-layer-slot";
// Fullscreen band. 7 effect types means at most a handful of slots, so
// the whole stack fits between the modal backdrop and modal content.
const BASE_Z = 501;
const SCOPED_BASE_Z = 20;

let _state = null;
// _state: { container, signature, slots: [{ layer, el, inst }] }

// While the style modal owns a scoped preview, editor-context applies
// (triggered by the modal's own live saves emitting `style-changed`) are
// ignored so they can't steal the stack back to fullscreen mid-edit. The
// modal clears the lock before its final unmount.
let _scopedLock = false;
export function setScopedPreviewLock(v) { _scopedLock = !!v; }

function signatureOf(layers, container) {
  return layers.map(l => `${l.id}:${l.type}`).join("|") + "@" + (container ? "scoped" : "window");
}

function makeSlot(container, index) {
  const el = document.createElement("div");
  el.className = SLOT_CLASS;
  el.style.cssText = container
    ? `position:absolute;inset:0;pointer-events:none;z-index:${SCOPED_BASE_Z + index}`
    : `position:fixed;inset:0;pointer-events:none;z-index:${BASE_Z + index}`;
  (container || document.body).appendChild(el);
  return el;
}

export function applyPostLayers({ layers, container }) {
  if (_scopedLock && !container) return;
  const enabled = (layers || []).filter(l => l && l.enabled !== false);
  if (!enabled.length) { teardown(); return; }

  const wantContainer = container || null;
  const signature = signatureOf(enabled, wantContainer);

  // In-place update only when the structure matches AND the slots are
  // still in the live container — a modal re-render recreates the
  // preview pane and orphans them, so identity and connectedness must
  // both hold.
  if (_state && _state.signature === signature && _state.container === wantContainer
      && _state.slots.every(s => s.el.isConnected)) {
    for (let i = 0; i < enabled.length; i++) {
      try { _state.slots[i]?.inst?.update?.(enabled[i]); } catch (e) { console.warn("post layer update failed", e); }
    }
    return;
  }

  teardown();

  const ctx = {
    container: wantContainer,
    // Glow's rule scope: the element whose subtree carries the text the
    // effect reaches into.
    scope: wantContainer || document.body,
  };

  const slots = [];
  enabled.forEach((layer, i) => {
    const el = makeSlot(wantContainer, i);
    let inst = null;
    try { inst = mountPostEffect(el, layer, ctx); } catch (e) { console.warn("post layer mount failed", e); }
    slots.push({ layer, el, inst });
  });

  _state = { container: wantContainer, signature, slots };
}

export function unmountPostLayers() {
  if (_scopedLock) return;
  teardown();
}

function teardown() {
  if (!_state) {
    // Belt and braces: a hot reload or an interrupted mount can leave
    // slots behind with no tracked state.
    document.querySelectorAll("." + SLOT_CLASS).forEach(el => el.remove());
    return;
  }
  // Reverse order so a reach-out effect that restored something a later
  // one also touched unwinds last-in-first-out.
  for (let i = _state.slots.length - 1; i >= 0; i--) {
    const s = _state.slots[i];
    try { s.inst?.dispose?.(); } catch (e) { console.warn("post layer dispose failed", e); }
    s.el.remove();
  }
  _state = null;
}

/**
 * Pull the plug. Each effect's dispose() already scrubs what it added,
 * but if something glitched mid-mount this finds every artifact still on
 * the page and removes it. Safe to call any time; idempotent. Exposed on
 * window for use from the dev console:
 *     window.__hushPostLayerPanicCleanup()
 */
export function panicCleanup() {
  _state = null;
  _scopedLock = false;
  document.querySelectorAll("." + SLOT_CLASS).forEach(el => el.remove());
  scrubPostArtifacts();
}

if (typeof window !== "undefined") {
  window.__hushPostLayerPanicCleanup = panicCleanup;
  // Historical name, kept so the muscle memory in the dev console (and
  // in older notes) still finds it.
  window.__hushShaderPanicCleanup = panicCleanup;
}
