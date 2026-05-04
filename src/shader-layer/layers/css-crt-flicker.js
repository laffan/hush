/**
 * CSS-family layer: classic CRT — horizontal scanlines + vertical RGB
 * triad stripes + an animated flicker overlay.
 *
 * Ported from xybre's "CRT Monitor Styled Codeblocks using CSS" Obsidian
 * snippets, which themselves credit Alec Lownes:
 *   https://publish.obsidian.md/xybre/permalink/6b8a4441-c676-40bb-a422-74179e6759f6
 *   http://aleclownes.com/2017/02/01/crt-display.html
 *
 * Original was scoped to markdown code blocks (`pre code`); we mount it
 * as a fullscreen / pane-scoped overlay instead and skip the
 * `text-shadow`-based chromatic aberration (which would require touching
 * the editor's text directly, outside the shader-layer's overlay model).
 *
 * Three stacked layers:
 *   1. Scanlines + vertical RGB stripes — static background, painted via
 *      two stacked linear-gradients exactly the way the original does.
 *   2. Retrace strip — a 4px-tall vertically-tiled gradient, slowly
 *      scrolled via `background-position` keyframes so the bright band
 *      looks like a CRT retrace beam falling down the screen.
 *   3. Flicker overlay — a near-black layer whose opacity is bashed
 *      between 0.08 and 0.96 every 7.5ms (0.15s ÷ 20 keyframes), giving
 *      that distinctive analog-noise wobble.
 *
 * Idle cost: zero JS frames. Compositor handles the keyframe animation
 * end-to-end on the GPU. Intensity 0 = layers all alpha 0 = no visual
 * change. The keyframes themselves are injected into <head> once per
 * session and deliberately left in place on dispose — they're a few
 * hundred bytes and harmless.
 */

const KEYFRAMES_ID = "shader-layer-crt-flicker-keyframes";

const KEYFRAMES_CSS = `
@keyframes shader-layer-crt-flicker {
  0%   { opacity: 0.27861; }
  5%   { opacity: 0.34769; }
  10%  { opacity: 0.23604; }
  15%  { opacity: 0.90626; }
  20%  { opacity: 0.18128; }
  25%  { opacity: 0.83891; }
  30%  { opacity: 0.65583; }
  35%  { opacity: 0.67807; }
  40%  { opacity: 0.26559; }
  45%  { opacity: 0.84693; }
  50%  { opacity: 0.96019; }
  55%  { opacity: 0.08594; }
  60%  { opacity: 0.20313; }
  65%  { opacity: 0.71988; }
  70%  { opacity: 0.53455; }
  75%  { opacity: 0.37288; }
  80%  { opacity: 0.71428; }
  85%  { opacity: 0.70419; }
  90%  { opacity: 0.70030; }
  95%  { opacity: 0.36108; }
  100% { opacity: 0.24387; }
}

@keyframes shader-layer-crt-retrace {
  from { background-position: 0 0; }
  to   { background-position: 0 100vh; }
}
`;

function injectKeyframes() {
  if (document.getElementById(KEYFRAMES_ID)) return;
  const style = document.createElement("style");
  style.id = KEYFRAMES_ID;
  style.textContent = KEYFRAMES_CSS;
  document.head.appendChild(style);
}

export default function mount(host, ctx) {
  injectKeyframes();

  // Three stacked children fill the host. Each is position:absolute /
  // inset:0 with its own background + (optional) animation. We rebuild
  // them in `apply()` so a slider drag can re-tune alphas without
  // re-mounting the whole layer.
  const screen = document.createElement("div");
  const retrace = document.createElement("div");
  const flicker = document.createElement("div");
  for (const el of [screen, retrace, flicker]) {
    el.style.cssText = "position:absolute;inset:0;pointer-events:none";
    host.appendChild(el);
  }

  function apply(intensity) {
    const i = clamp(intensity);

    // 1. Scanlines + vertical RGB triad stripes (port of read-code-screen).
    //    Original alpha values multiplied by intensity so 0 → invisible.
    const scanA = (0.25 * i).toFixed(3);     // black bar alpha
    const stripeR = (0.06 * i).toFixed(3);
    const stripeG = (0.02 * i).toFixed(3);
    const stripeB = (0.06 * i).toFixed(3);
    screen.style.background = [
      `linear-gradient(rgba(18,16,16,0) 50%, rgba(0,0,0,${scanA}) 50%)`,
      `linear-gradient(90deg,
        rgba(255,0,0,${stripeR}),
        rgba(0,255,0,${stripeG}),
        rgba(0,0,255,${stripeB}))`,
    ].join(", ");
    screen.style.backgroundSize = "100% 2px, 3px 100%";

    // 2. Retrace strip — 4px tile, vertical scroll. Alpha follows
    //    intensity, animation is intensity-gated by `animation-duration`
    //    (set high so it visibly creeps even at intensity 0.1).
    const retraceA = (0.4 * i).toFixed(3);
    retrace.style.background =
      `linear-gradient(to bottom,
        rgba(0,0,0,0) 70%,
        rgba(40,40,30,${retraceA}) 70%)`;
    retrace.style.backgroundSize = "100% 4px";
    retrace.style.animation = i > 0
      ? "shader-layer-crt-retrace 8s linear infinite"
      : "none";

    // 3. Flicker — translucent black layer with chaotic opacity. We
    //    scale the *base* color alpha by intensity so the keyframe
    //    opacities (0..1) modulate a peak that maxes at 0.10 alpha at
    //    full intensity (matching the original snippet).
    const flickerBase = (0.10 * i).toFixed(3);
    flicker.style.background = `rgba(18,16,16,${flickerBase})`;
    flicker.style.opacity = "0";
    flicker.style.animation = i > 0
      ? "shader-layer-crt-flicker 0.15s infinite"
      : "none";
  }

  apply(ctx.intensity);

  return {
    update({ intensity }) { apply(intensity); },
    dispose() {
      // Leave the keyframes <style> in <head> — it's tiny and any other
      // mount this session reuses it. Just drop the host children.
      screen.remove();
      retrace.remove();
      flicker.remove();
    },
  };
}

function clamp(v) {
  if (typeof v !== "number" || Number.isNaN(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}
