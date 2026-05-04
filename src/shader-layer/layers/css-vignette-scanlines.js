/**
 * CSS-family layer: radial vignette + horizontal scanlines.
 *
 * No JS animation, no canvas, no rAF — paints once via two stacked
 * background images on the host element. Idle cost is whatever the
 * compositor pays to keep the layer composited (essentially zero on
 * any GPU-accelerated WebKit). Re-renders on resize are also free
 * because backgrounds reflow themselves.
 *
 * Knobs (defined in the shader-layer registry's settings schema):
 *   - vignetteStrength: corner darkness alpha (0..1)
 *   - scanlineOpacity:  bar alpha (0..1)
 *   - scanlineColor:    hex color of the scanline bars
 *
 * Intensity is the master scale that multiplies all three so dialing
 * intensity to 0 collapses the whole layer regardless of knob values.
 */
export default function mount(host, ctx) {
  const apply = (intensity, options) => {
    const i = clamp(intensity);
    const o = options || {};
    const vignetteStrength = num(o.vignetteStrength, 0.5) * i;
    const scanlineAlpha = num(o.scanlineOpacity, 0.15) * i;
    const scanRgb = hexToRgbCsv(o.scanlineColor || "#000000");

    host.style.background = [
      // Vignette: transparent center → dark edges.
      `radial-gradient(circle at center, transparent 55%, rgba(0,0,0,${vignetteStrength.toFixed(3)}) 100%)`,
      // Scanlines: 2px-tall stripe pattern using the user-chosen color.
      `repeating-linear-gradient(
        to bottom,
        rgba(0,0,0,0) 0px,
        rgba(0,0,0,0) 1px,
        rgba(${scanRgb},${scanlineAlpha.toFixed(3)}) 1px,
        rgba(${scanRgb},${scanlineAlpha.toFixed(3)}) 2px
      )`,
    ].join(", ");
    // Multiply blend mode keeps scanlines from washing out the editor on
    // light themes.
    host.style.mixBlendMode = "multiply";
  };

  apply(ctx.intensity, ctx.options);

  return {
    update({ intensity, options }) { apply(intensity, options); },
    dispose() {
      host.style.background = "";
      host.style.mixBlendMode = "";
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
  // Accepts #rgb, #rrggbb. Returns "r,g,b" decimal triplet.
  const h = (hex || "").replace("#", "");
  const expand = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const r = parseInt(expand.slice(0, 2), 16) || 0;
  const g = parseInt(expand.slice(2, 4), 16) || 0;
  const b = parseInt(expand.slice(4, 6), 16) || 0;
  return `${r},${g},${b}`;
}
