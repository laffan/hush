/**
 * CSS-family layer: phosphor scanlines + text glow that reaches the
 * actual editor and modal preview text.
 *
 * Inspired by https://github.com/cakenggt/hyperatompunk and
 * https://ittysockets.com/status — both put soft phosphor glow directly
 * on the rendered glyphs rather than as a screen-wide overlay.
 *
 * Mechanism: this layer goes beyond the pure-overlay model the other
 * layers use and reaches editor text via:
 *
 *   1. A scope class added to either <body> (fullscreen apply) or the
 *      modal preview pane (in-modal preview).
 *   2. An injected <style> in <head> with rules targeting `.cm-content`
 *      (CodeMirror's editable area) and `.style-preview-content` (the
 *      modal preview pane's text). Rules read CSS custom properties
 *      that intensity-driven JS sets on the scope element so a slider
 *      drag retunes the glow without re-rendering anything.
 *   3. A scanline overlay painted as the host element's background,
 *      independent of the text effect.
 *
 * Cleanup invariant: dispose() removes the class, the custom properties,
 * the injected <style>, and the host's inline styles. After dispose
 * there should be NO trace of this layer anywhere — that's the
 * "pull the plug" guarantee.
 *
 * Idle cost: zero JS frames. text-shadow is GPU-composited; scanline
 * overlay is a single repeating gradient. No animation.
 */

const RULES_ID = "shader-layer-phosphor-rules";
const SCOPE_CLASS = "shader-layer-phosphor-active";
const VAR_GLOW = "--shader-layer-phosphor-glow";
const VAR_HALO = "--shader-layer-phosphor-halo";

const RULES_CSS = `
.${SCOPE_CLASS} .cm-content,
.${SCOPE_CLASS} .style-preview-content,
.${SCOPE_CLASS} .style-preview-cursor-demo {
  text-shadow:
    0 0 var(${VAR_GLOW}, 4px) currentColor,
    0 0 var(${VAR_HALO}, 12px) currentColor;
  -webkit-font-smoothing: antialiased;
}
`;

function injectRules() {
  if (document.getElementById(RULES_ID)) return;
  const style = document.createElement("style");
  style.id = RULES_ID;
  style.textContent = RULES_CSS;
  document.head.appendChild(style);
}

function removeRules() {
  document.getElementById(RULES_ID)?.remove();
}

export default function mount(host, ctx) {
  injectRules();

  // Scope = the modal preview pane when the layer is in container mode,
  // <body> when fullscreen. The scope element is the only place the
  // scope class lives, and the only place the custom properties are
  // set — so cleanup is trivially scoped.
  const scope = host.parentElement === document.body
    ? document.body
    : host.parentElement;
  scope.classList.add(SCOPE_CLASS);

  function apply(intensity) {
    const i = clamp(intensity);

    // Two text-shadow layers, both color = currentColor:
    //   - "glow":   tight halo at 1..6px, the sharp neon edge
    //   - "halo":   soft falloff at 6..28px, the ambient bleed
    // Both scale linearly with intensity. At 0 the values collapse to
    // 0 0 0 currentColor, which renders no shadow.
    const glowPx = (i * 6).toFixed(2);
    const haloPx = (i * 22).toFixed(2);
    scope.style.setProperty(VAR_GLOW, `${glowPx}px`);
    scope.style.setProperty(VAR_HALO, `${haloPx}px`);

    // Scanline overlay on the host element. 3px-period stripes (1px
    // dark + 2px transparent) — finer than the "Vignette + Scanlines"
    // layer so it pairs with the glow without overpowering it.
    const scanA = (0.06 + i * 0.20).toFixed(3);
    host.style.background = `repeating-linear-gradient(
      to bottom,
      rgba(0,0,0,0) 0,
      rgba(0,0,0,0) 2px,
      rgba(0,0,0,${scanA}) 2px,
      rgba(0,0,0,${scanA}) 3px
    )`;
    host.style.mixBlendMode = "multiply";
  }

  apply(ctx.intensity);

  return {
    update({ intensity }) { apply(intensity); },
    dispose() {
      // Full unwind. Wrapped in try blocks individually so a stale
      // reference in one step can't strand cleanup of the others —
      // this is the "pull the plug" path.
      try { scope.classList.remove(SCOPE_CLASS); } catch (_) {}
      try { scope.style.removeProperty(VAR_GLOW); } catch (_) {}
      try { scope.style.removeProperty(VAR_HALO); } catch (_) {}
      try { host.style.background = ""; } catch (_) {}
      try { host.style.mixBlendMode = ""; } catch (_) {}
      try { removeRules(); } catch (_) {}
    },
  };
}

function clamp(v) {
  if (typeof v !== "number" || Number.isNaN(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}
