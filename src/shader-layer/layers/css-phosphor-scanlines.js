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
 * Knobs:
 *   - glow:            tight halo radius scale (0..1 → 0..30 px)
 *   - halo:            soft falloff radius scale (0..1 → 0..50 px)
 *   - scanlineOpacity: bar alpha (0..1)
 *   - scanlineColor:   hex color of the scanline bars
 *
 * Cleanup invariant: dispose() removes the class, the custom properties,
 * the injected <style>, and the host's inline styles. After dispose
 * there should be NO trace of this layer anywhere — that's the
 * "pull the plug" guarantee.
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

  const scope = host.parentElement === document.body
    ? document.body
    : host.parentElement;
  scope.classList.add(SCOPE_CLASS);

  function apply(intensity, options) {
    const i = clamp(intensity);
    const o = options || {};

    // Glow radii — knob values 0..1 map to 0..30 px (tight) and
    // 0..50 px (soft). Master intensity then scales both.
    const glowPx = (num(o.glow, 0.4) * 30 * i).toFixed(2);
    const haloPx = (num(o.halo, 0.6) * 50 * i).toFixed(2);
    scope.style.setProperty(VAR_GLOW, `${glowPx}px`);
    scope.style.setProperty(VAR_HALO, `${haloPx}px`);

    // Scanline overlay on the host element. Knob alpha + color, scaled
    // by intensity. 3px period stripes pair well with the glow.
    const scanA = (num(o.scanlineOpacity, 0.2) * i).toFixed(3);
    const scanRgb = hexToRgbCsv(o.scanlineColor || "#000000");
    host.style.background = `repeating-linear-gradient(
      to bottom,
      rgba(0,0,0,0) 0,
      rgba(0,0,0,0) 2px,
      rgba(${scanRgb},${scanA}) 2px,
      rgba(${scanRgb},${scanA}) 3px
    )`;
    host.style.mixBlendMode = "multiply";
  }

  apply(ctx.intensity, ctx.options);

  return {
    update({ intensity, options }) { apply(intensity, options); },
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

function num(v, fallback) {
  return (typeof v === "number" && !Number.isNaN(v)) ? v : fallback;
}

function hexToRgbCsv(hex) {
  const h = (hex || "").replace("#", "");
  const expand = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const r = parseInt(expand.slice(0, 2), 16) || 0;
  const g = parseInt(expand.slice(2, 4), 16) || 0;
  const b = parseInt(expand.slice(4, 6), 16) || 0;
  return `${r},${g},${b}`;
}
