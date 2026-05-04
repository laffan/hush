/**
 * CSS-family layer: radial vignette + horizontal scanlines.
 *
 * No JS animation, no canvas, no rAF — paints once via two stacked
 * background images on the host element. Idle cost is whatever the
 * compositor pays to keep the layer composited (essentially zero on
 * any GPU-accelerated WebKit). Re-renders on resize are also free
 * because backgrounds reflow themselves.
 *
 * Intensity controls vignette darkness + scanline visibility together.
 */
export default function mount(host, ctx) {
  const apply = (intensity) => {
    const i = clamp(intensity);
    const vignetteStrength = 0.15 + i * 0.55; // 0.15 .. 0.70 alpha at the corners
    const scanlineAlpha = 0.04 + i * 0.16;    // 0.04 .. 0.20

    host.style.background = [
      // Vignette: transparent center → dark edges. radial-gradient with
      // a circle clamps cleanly on every aspect ratio.
      `radial-gradient(circle at center, transparent 55%, rgba(0,0,0,${vignetteStrength.toFixed(3)}) 100%)`,
      // Scanlines: 2px-tall stripe pattern. Even-numbered pixel rows are
      // covered by a translucent black bar.
      `repeating-linear-gradient(
        to bottom,
        rgba(0,0,0,0) 0px,
        rgba(0,0,0,0) 1px,
        rgba(0,0,0,${scanlineAlpha.toFixed(3)}) 1px,
        rgba(0,0,0,${scanlineAlpha.toFixed(3)}) 2px
      )`,
    ].join(", ");
    // Multiply blend mode keeps scanlines from washing out the editor on
    // light themes — overlay would invert on bright backgrounds.
    host.style.mixBlendMode = "multiply";
  };

  apply(ctx.intensity);

  return {
    update({ intensity }) { apply(intensity); },
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
