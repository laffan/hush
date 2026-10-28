/**
 * Edge Lights — the overlay itself: one fixed, click-through canvas
 * over the whole window, whose edges glow in slowly shifting curtains of
 * colour. Imported only when the lights are begun (or previewed).
 *
 * Built on the background layers' WebGL helpers (background-layers/
 * webgl-utils.js), but not mounted as a style layer: it sits over the
 * app rather than behind the text, and it belongs to no style.
 *
 * What it draws — Polar's curtains, Scuba's ripples, Thrum's patches — is the shader's
 * (edge-lights-shader.js); this module runs it. With the Distortion fill
 * the canvas itself is hidden and draws the shape as a mask, which it
 * hands to the distortion layer (edge-lights-distort.js) as an image
 * every `MASK_MS`.
 *
 * Cost: it is drawn at half the CSS resolution (it is all soft light),
 * at 30 fps, and a pixel further in than any lobe can reach leaves at
 * once — so the middle of the window, where the text is, costs a
 * distance test. The loop stops while the window is hidden.
 */
import { linkProgram, setupQuad, hexToVec3 } from "../background-layers/webgl-utils.js";
import { FRAG, MAX_SHADER_COLORS } from "./edge-lights-shader.js";
import { UNBLENDED_KINDS } from "./edge-lights-store.js";

/** The shader's `u_kind` numbers, in order. */
const KIND_IDS = ["polar", "scuba", "thrum", "thrumDark"];

const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

/** Canvas px per CSS px. Soft light loses nothing at half resolution. */
const RENDER_SCALE = 0.5;
const FRAME_MS = 1000 / 30;
const FADE_IN_MS = 2500;
const FADE_OUT_MS = 1200;
/** How often the Distortion fill's mask is passed on. Reading a frame
 *  out as an image costs a little; a dozen times a second is plenty for
 *  shapes this slow. */
const MASK_MS = 80;
const FILL_IDS = ["colors", "distortion", "animation"];
const ANIMATION_IDS = ["hyperspace", "snow"];

/** Mount the overlay with `options` (resolved — see edge-lights-
 *  store.js#readOptions — plus `colors`, the palette's colours).
 *  Returns `{ update(options), stop() }`; `stop` fades out and resolves
 *  once the element is gone. */
export function mountEdgeLights(options) {
  const el = document.createElement("canvas");
  el.className = "edge-lights";
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);

  const gl = el.getContext("webgl2", {
    alpha: true, premultipliedAlpha: true, antialias: false,
    depth: false, stencil: false, powerPreference: "low-power",
  });
  const program = gl ? linkProgram(gl, VERT, FRAG) : null;
  if (!program) return mountFallback(el, options);
  gl.useProgram(program);
  setupQuad(gl, program);
  const u = {};
  for (const name of ["u_res", "u_time", "u_depth", "u_opacity", "u_sat", "u_fade", "u_kind", "u_count", "u_colors", "u_fill", "u_anim"]) {
    u[name] = gl.getUniformLocation(program, name);
  }

  let opts = options;
  let raf = 0;
  let distort = null;        // the Distortion fill's layer, while it is the fill
  let distortKey = "";
  let lastMask = 0;
  let lastDraw = 0;
  let fade = 0;
  let fadeFrom = 0;
  let fadeTarget = 1;
  let fadeStart = performance.now();
  let fadeMs = FADE_IN_MS;
  let onFadedOut = null;
  // The sky's own clock: real time times the speed option, accumulated
  // so a change of speed carries on from where the shapes are rather
  // than jumping. It starts somewhere different each time it is begun.
  let skyTime = Math.random() * 600;
  let lastClock = performance.now();
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  function applyOptions() {
    const colors = opts.colors.slice(0, MAX_SHADER_COLORS);
    const flat = new Float32Array(MAX_SHADER_COLORS * 3);
    colors.forEach((c, i) => flat.set(hexToVec3(c), i * 3));
    gl.uniform3fv(u.u_colors, flat);
    gl.uniform1i(u.u_count, Math.max(2, colors.length));
    gl.uniform1i(u.u_kind, Math.max(0, KIND_IDS.indexOf(opts.kind)));
    gl.uniform1i(u.u_fill, Math.max(0, FILL_IDS.indexOf(opts.fill)));
    gl.uniform1i(u.u_anim, Math.max(0, ANIMATION_IDS.indexOf(opts.animation)));
    el.classList.toggle("edge-lights-unblended", UNBLENDED_KINDS.has(opts.kind));
    syncDistortion();
  }

  /** The Distortion fill's layer follows the options: mounted (the
   *  module loaded on first use) or rebuilt when its kind or strength
   *  changes, removed when the fill is something else. */
  function syncDistortion() {
    const on = opts.fill === "distortion";
    el.classList.toggle("edge-lights-masking", on);
    if (!on) { distort?.remove(); distort = null; distortKey = ""; return; }
    const key = `${opts.distortion}:${opts.opacity.toFixed(2)}`;
    if (key === distortKey) return;
    distortKey = key;
    import("./edge-lights-distort.js").then(({ mountDistortion }) => {
      if (distortKey !== key || opts.fill !== "distortion") return;
      if (distort) distort.update(opts.distortion, opts.opacity);
      else distort = mountDistortion(opts.distortion, opts.opacity);
      lastMask = 0;
    });
  }

  function resize() {
    const w = Math.max(1, Math.round(window.innerWidth * RENDER_SCALE));
    const h = Math.max(1, Math.round(window.innerHeight * RENDER_SCALE));
    // Reassigning the size reallocates the surface even when unchanged.
    if (el.width !== w) el.width = w;
    if (el.height !== h) el.height = h;
    gl.viewport(0, 0, w, h);
  }

  function frame(now) {
    raf = 0;
    if (document.hidden) return;
    raf = requestAnimationFrame(frame);
    if (now - lastDraw < FRAME_MS) return;
    lastDraw = now;
    const k = Math.min(1, (now - fadeStart) / fadeMs);
    fade = fadeFrom + (fadeTarget - fadeFrom) * k * k * (3 - 2 * k);
    if (k >= 1 && fadeTarget === 0) { finish(); return; }
    gl.uniform2f(u.u_res, el.width, el.height);
    skyTime += ((now - lastClock) / 1000) * opts.speed * (reduced ? 0.35 : 1);
    lastClock = now;
    gl.uniform1f(u.u_time, skyTime);
    gl.uniform1f(u.u_depth, opts.depth * Math.min(el.width, el.height));
    gl.uniform1f(u.u_opacity, opts.opacity);
    gl.uniform1f(u.u_sat, opts.saturation);
    gl.uniform1f(u.u_fade, fade);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    // Read in the same task as the draw: the drawing buffer isn't kept
    // past it (`preserveDrawingBuffer` is off).
    if (distort && now - lastMask >= MASK_MS) {
      lastMask = now;
      distort.setMask(el.toDataURL("image/png"));
    }
  }
  const start = () => {
    if (raf || document.hidden) return;
    lastClock = performance.now(); // time hidden doesn't move the sky
    raf = requestAnimationFrame(frame);
  };
  const onVisibility = () => { if (!document.hidden) start(); };

  function finish() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", onVisibility);
    try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch (_) {}
    distort?.remove();
    distort = null;
    el.remove();
    onFadedOut?.();
  }

  applyOptions();
  resize();
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", onVisibility);
  start();

  return {
    update(next) {
      opts = next;
      applyOptions();
    },
    stop() {
      return new Promise((resolve) => {
        onFadedOut = resolve;
        fadeFrom = fade;
        fadeTarget = 0;
        fadeStart = performance.now();
        fadeMs = FADE_OUT_MS;
        if (document.hidden) finish();
        else start();
      });
    },
  };
}

/** No WebGL2: a still glow round the edges in the first colour, so the
 *  command still does something visible. */
function mountFallback(canvas, options) {
  canvas.remove();
  const el = document.createElement("div");
  el.className = "edge-lights edge-lights-fallback";
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  const paint = (o) => {
    el.classList.toggle("edge-lights-unblended", UNBLENDED_KINDS.has(o.kind));
    const reach = Math.round(o.depth * Math.min(window.innerWidth, window.innerHeight));
    el.style.boxShadow = `inset 0 0 ${reach}px ${Math.round(reach / 3)}px ${o.colors[0]}`;
    el.style.opacity = String(o.opacity);
    el.style.filter = `saturate(${o.saturation})`;
  };
  paint(options);
  return {
    update: paint,
    stop() { el.remove(); return Promise.resolve(); },
  };
}
