/**
 * Northern Lights — the overlay itself: one fixed, click-through canvas
 * over the whole window, whose edges glow in slowly shifting curtains of
 * colour. Imported only when the lights are begun (or previewed).
 *
 * Built on the background layers' WebGL helpers (background-layers/
 * webgl-utils.js), but not mounted as a style layer: it sits over the
 * app rather than behind the text, and it belongs to no style.
 *
 * The shader works out each pixel's distance from the nearest window
 * edge and its angle about the centre. The angle, taken as a point on a
 * circle so it has no seam, is the coordinate the shapes move along:
 * large slow lobes set how far each stretch of edge reaches in (the
 * `depth` option is their scale), finer bands running out from the edge
 * make the curtains, and every lobe breathes on its own phase. Colour
 * runs from the palette's first two colours along the edge into the
 * third at the far reach.
 *
 * Cost: it is drawn at half the CSS resolution (it is all soft light),
 * at 30 fps, and a pixel further in than any lobe can reach leaves at
 * once — so the middle of the window, where the text is, costs a
 * distance test. The loop stops while the window is hidden.
 */
import { linkProgram, setupQuad, hexToVec3 } from "../background-layers/webgl-utils.js";

const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2  u_res;
uniform float u_time;
uniform float u_depth;    // reach, in canvas px
uniform float u_opacity;
uniform float u_sat;
uniform float u_fade;
uniform vec3  u_c1;
uniform vec3  u_c2;
uniform vec3  u_c3;

// 2D simplex noise (Ashima Arts / Ian McEwan, MIT) — smooth in every
// direction, so the shapes have no grid in them. Range about -1..1.
vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
// Three octaves, each turned against the last; 0..1.
float fbm(vec2 p) {
  const mat2 R = mat2(0.8, -0.6, 0.6, 0.8);
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * snoise(p);
    p = R * p * 2.02 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return 0.5 + 0.5 * v / 0.875;
}

void main() {
  vec2 px = gl_FragCoord.xy;
  float d = min(min(px.x, u_res.x - px.x), min(px.y, u_res.y - px.y));
  // Past the furthest any lobe can reach: nothing to draw.
  if (d > u_depth * 1.6) { outColor = vec4(0.0); return; }

  vec2 q = (px - 0.5 * u_res) / min(u_res.x, u_res.y);
  float ang = atan(q.y, q.x);
  vec2 ring = vec2(cos(ang), sin(ang));
  float t = u_time;

  // How far in this stretch of edge reaches — slow lobes drifting round
  // the frame, from almost nothing to well past the depth, so the light
  // gathers in places rather than lining the window like a frame.
  float lobe  = fbm(ring * 1.4 + vec2(t * 0.03, -t * 0.022));
  float lobe2 = fbm(ring * 2.6 + vec2(-t * 0.045, t * 0.035) + 11.0);
  float gather = smoothstep(0.3, 0.75, lobe) * (0.55 + 0.6 * lobe2);
  float reach = u_depth * (0.12 + 1.35 * gather);
  float x = d / max(reach, 1.0);

  // The curtains: fine bands running out from the edge, drifting along
  // it and flowing inward.
  float rays = fbm(ring * 9.0 + vec2(t * 0.06, x * 1.6 - t * 0.18));
  float curtain = 0.25 + 1.2 * smoothstep(0.25, 0.85, rays);

  // Each lobe breathes on a phase of its own; the whole sky slower still.
  float pulse = (0.78 + 0.22 * sin(t * 0.5 + lobe * 9.0)) * (0.9 + 0.1 * sin(t * 0.19));

  float glow = pow(clamp(1.0 - x, 0.0, 1.0), 1.8) * curtain * pulse;
  // A soft seam right at the edge where the light gathers, as if it
  // came from just beyond the window.
  glow += 0.3 * gather * exp(-d / max(u_depth * 0.06, 1.0)) * pulse;

  float m = fbm(ring * 1.1 + vec2(t * 0.018, t * 0.013) + 3.0);
  vec3 col = mix(u_c1, u_c2, smoothstep(0.3, 0.7, m));
  col = mix(col, u_c3, smoothstep(0.1, 0.75, x));
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = clamp(mix(vec3(lum), col, u_sat), 0.0, 1.0);

  float a = clamp(glow, 0.0, 1.0) * u_opacity * u_fade;
  outColor = vec4(col * a, a);
}`;

const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

/** Canvas px per CSS px. Soft light loses nothing at half resolution. */
const RENDER_SCALE = 0.5;
const FRAME_MS = 1000 / 30;
const FADE_IN_MS = 2500;
const FADE_OUT_MS = 1200;

/** Mount the overlay with `options` (resolved — see northern-lights-
 *  store.js#readOptions — plus `colors`, the three palette colours).
 *  Returns `{ update(options), stop() }`; `stop` fades out and resolves
 *  once the element is gone. */
export function mountNorthernLights(options) {
  const el = document.createElement("canvas");
  el.className = "northern-lights";
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
  for (const name of ["u_res", "u_time", "u_depth", "u_opacity", "u_sat", "u_fade", "u_c1", "u_c2", "u_c3"]) {
    u[name] = gl.getUniformLocation(program, name);
  }

  let opts = options;
  let raf = 0;
  let lastDraw = 0;
  let fade = 0;
  let fadeFrom = 0;
  let fadeTarget = 1;
  let fadeStart = performance.now();
  let fadeMs = FADE_IN_MS;
  let onFadedOut = null;
  // The sky starts somewhere different each time it is begun.
  const epoch = performance.now() - Math.random() * 600000;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  function applyColors() {
    const [c1, c2, c3] = opts.colors.map(hexToVec3);
    gl.uniform3f(u.u_c1, ...c1);
    gl.uniform3f(u.u_c2, ...c2);
    gl.uniform3f(u.u_c3, ...c3);
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
    gl.uniform1f(u.u_time, ((now - epoch) / 1000) * (reduced ? 0.35 : 1));
    gl.uniform1f(u.u_depth, opts.depth * Math.min(el.width, el.height));
    gl.uniform1f(u.u_opacity, opts.opacity);
    gl.uniform1f(u.u_sat, opts.saturation);
    gl.uniform1f(u.u_fade, fade);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  const start = () => { if (!raf && !document.hidden) raf = requestAnimationFrame(frame); };
  const onVisibility = () => { if (!document.hidden) start(); };

  function finish() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", onVisibility);
    try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch (_) {}
    el.remove();
    onFadedOut?.();
  }

  applyColors();
  resize();
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", onVisibility);
  start();

  return {
    update(next) {
      opts = next;
      applyColors();
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
  el.className = "northern-lights northern-lights-fallback";
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  const paint = (o) => {
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
