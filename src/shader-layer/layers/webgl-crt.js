/**
 * WebGL2 layer: CRT effect.
 *
 * The effect math is ported from CRTFilterWebGL by Ichiaka, MIT-licensed:
 *   https://github.com/Ichiaka/CRTFilter
 *   Copyright (c) 2025 Aka — MIT License
 *
 * Adaptation note: CRTFilter is a true post-processing filter — it samples
 * a source canvas and applies effects to those pixels. In Hush the
 * "screen" is a CodeMirror DOM editor (or a notebook canvas), and
 * capturing it as a GL texture every frame would dominate the frame
 * budget. So the port treats the source as `vec3(1.0)` (a fully bright
 * canvas) and emits a multiplicative mask: each fragment outputs `col`
 * with alpha 1.0, the canvas is composited via `mix-blend-mode: multiply`,
 * and the editor pixels are darkened wherever scanlines / mask / signal
 * loss / vignette want them darker. col = 1.0 means "no change" so the
 * editor stays crisp through the gaps.
 *
 * The effects that need a real source (chromatic aberration, glow on
 * bright pixels, horizontal-tearing texture sampling) are dropped — they
 * have no visible work to do without one. Everything else (curvature,
 * scanlines, retrace lines, dot mask, signal loss, flicker, contrast,
 * vignette) ports cleanly.
 *
 * `intensity` 0 → mask is identically vec3(1.0) → editor untouched.
 * `intensity` 1 → strong CRT.
 *
 * Procedural-only also means: no DOM capture, no html2canvas, no
 * texSubImage2D every frame — single fullscreen quad, ~1ms even on iPad.
 */

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;

uniform float u_time;
uniform float u_intensity;
uniform vec2  u_resolution;

// Barrel distortion — port of CRTFilter's barrelDistortion().
vec2 barrel(vec2 uv, float k) {
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  return uv + c * r2 * k;
}

// Hash for the static-noise term.
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  // Curvature is gentle — we keep the *visual* warp of the scanline
  // pattern without warping any underlying content (because there isn't
  // any to warp). Higher intensity = more curve.
  float k = 0.10 + u_intensity * 0.18;
  vec2 uv = barrel(v_uv, k);

  // Soft edge: corners of the post-barrel rectangle fall outside [0,1].
  // smoothstep over a small band gives a gradient toward the corners
  // rather than a hard mask. Crucially, the floor is non-zero — even
  // the darkest corner stays at ~0.45 of the editor brightness, so
  // multiply blend never produces full black.
  float edgeX = smoothstep(-0.06, 0.04, uv.x) * smoothstep(-0.06, 0.04, 1.0 - uv.x);
  float edgeY = smoothstep(-0.06, 0.04, uv.y) * smoothstep(-0.06, 0.04, 1.0 - uv.y);
  float edge = edgeX * edgeY;

  // Source = pure white. All the effects below DARKEN this 1.0 to
  // various values; the resulting col is the multiplier that blends
  // over the editor.
  vec3 col = vec3(1.0);

  // Static noise — small grain over the whole tube.
  float noise = (hash21(uv * u_resolution + u_time) - 0.5);
  col += noise * (0.05 * u_intensity);

  // Signal loss — slowly-rolling horizontal dropout bars (CRTFilter's
  // u_signalLoss term).
  col *= 1.0 - (0.07 * u_intensity * abs(sin(uv.y * 60.0 + u_time * 8.0)));

  // Retrace lines — fine horizontal scanlines pinned to the target
  // canvas resolution so each bar lands roughly one pixel tall.
  // CRTFilter scales the multiplier by 1.9 + scanlineIntensity * sin();
  // we rebase to "1 minus a positive bump" so 0 intensity = no scanline.
  float scan = 0.5 - 0.5 * sin(uv.y * u_resolution.y * 3.14159 + u_time * 4.0);
  col *= 1.0 - (0.45 * u_intensity) * scan;

  // Dot mask — vertical RGB triad approximation. With a procedural
  // source we can't sample three offset RGB taps the way CRTFilter
  // does, but modulating the col channels at a column-frequency gives
  // the same colored-stripe sensation when composited over text.
  float maskR = 1.0;
  float maskG = 0.94 + 0.06 * sin(uv.x * u_resolution.x * 2.0944);
  float maskB = 0.94 + 0.06 * sin(uv.x * u_resolution.x * 2.0944 + 2.0);
  vec3 mask = mix(vec3(1.0), vec3(maskR, maskG, maskB), u_intensity * 0.7);
  col *= mask;

  // Flicker — slow brightness pulse (CRTFilter's u_flicker).
  col *= 1.0 + (0.015 * u_intensity) * sin(u_time * 12.0);

  // Vertical jitter — shift the apparent center of brightness up-and-
  // down every few seconds. With no source to sample we approximate
  // by darkening the strip the jitter would push out.
  float jitter = sin(u_time * 5.0) * 0.5 + 0.5;
  float jitterBand = smoothstep(0.45, 0.55, abs(uv.y - jitter));
  col *= 1.0 - (0.04 * u_intensity) * jitterBand;

  // Apply edge mask — corners get a soft vignette but never go fully
  // black. Floor is 1.0 - 0.55*intensity so even at max intensity the
  // darkest corner is ~0.45.
  float floorBrightness = 1.0 - 0.55 * u_intensity;
  col *= mix(floorBrightness, 1.0, edge);

  // intensity = 0 → blend toward pure white = passthrough.
  col = mix(vec3(1.0), col, u_intensity);

  outColor = vec4(col, 1.0);
}`;

export default function mount(host, ctx) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
  host.appendChild(canvas);
  // Blend mode lives on the HOST, not the canvas. Putting it on the
  // canvas isolates the blend to the host's stacking context (the
  // host's transparent background), so cleared white pixels paint
  // opaque over the editor instead of multiplying with it. Setting it
  // on the host blends the entire layer-as-a-unit onto everything
  // beneath in body's stacking context — i.e. the editor.
  host.style.mixBlendMode = "multiply";

  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });

  if (!gl) {
    // Fallback: cheap static scanlines via CSS so the user still gets an
    // effect on platforms without WebGL2.
    canvas.remove();
    host.style.background =
      `repeating-linear-gradient(to bottom, rgba(0,0,0,0) 0px, rgba(0,0,0,0) 1px, rgba(0,0,0,0.18) 1px, rgba(0,0,0,0.18) 2px),
       radial-gradient(circle at center, transparent 50%, rgba(0,0,0,0.55) 100%)`;
    host.style.mixBlendMode = "multiply";
    return {
      update() {},
      dispose() {
        host.style.background = "";
        host.style.mixBlendMode = "";
      },
    };
  }

  const program = link(gl, VERT, FRAG);
  if (!program) {
    canvas.remove();
    return { update() {}, dispose() {} };
  }
  gl.useProgram(program);

  const uTime = gl.getUniformLocation(program, "u_time");
  const uIntensity = gl.getUniformLocation(program, "u_intensity");
  const uRes = gl.getUniformLocation(program, "u_resolution");

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1,  -1, 1,
    -1,  1,  1, -1,   1, 1,
  ]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  let intensity = clamp(ctx.intensity);
  let visible = !document.hidden && document.hasFocus();
  let rafId = 0;
  const start = performance.now();

  function resize() {
    const w = ctx.width;
    const h = ctx.height;
    // Render at native CSS pixels — the scanline math is keyed off
    // u_resolution so we want bars roughly 1px tall on screen. Skipping
    // DPR saves ~4× fragment work on Retina with no visible loss.
    canvas.width = Math.max(1, Math.floor(w));
    canvas.height = Math.max(1, Math.floor(h));
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function draw() {
    rafId = 0;
    if (!visible) return;
    const t = (performance.now() - start) / 1000;
    gl.uniform1f(uTime, t);
    gl.uniform1f(uIntensity, intensity);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    // Clearing to white means "no effect at all" anywhere we don't
    // overwrite, which combined with multiply blend = passthrough.
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    rafId = requestAnimationFrame(draw);
  }
  function startLoop() { if (!rafId && visible) rafId = requestAnimationFrame(draw); }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }

  ctx.onResize = () => { resize(); };
  ctx.onVisible = (v) => {
    visible = v;
    if (v) startLoop(); else stopLoop();
  };

  resize();
  startLoop();

  return {
    update({ intensity: i }) { intensity = clamp(i); },
    dispose() {
      stopLoop();
      const lose = gl.getExtension("WEBGL_lose_context");
      try { lose && lose.loseContext(); } catch (_) {}
      canvas.remove();
      host.style.mixBlendMode = "";
    },
  };
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn("shader compile error", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function link(gl, vsrc, fsrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsrc);
  if (!vs || !fs) return null;
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.warn("program link error", gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

function clamp(v) {
  if (typeof v !== "number" || Number.isNaN(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}
