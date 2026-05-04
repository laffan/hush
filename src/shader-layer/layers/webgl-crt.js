/**
 * WebGL2 layer: CRT effect — barrel-distorted UVs, scanlines, slot mask,
 * and a soft vignette around the curved edge.
 *
 * Procedural-only — the shader does NOT sample editor pixels. That means
 * text glyphs stay crisp (the CRT bars composite over them via screen /
 * multiply blend modes set on the canvas element) and the entire shader
 * pass costs one fullscreen quad: a few microseconds even on iPad.
 *
 * The rAF loop is gated on visibility + focus through ctx.onVisible.
 * When the user tabs away the GPU goes quiet.
 *
 * If WebGL2 isn't available (very old WebKit), we fall back to mounting
 * a static CSS scanline so the user still sees *something* rather than
 * silently nothing.
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

uniform float u_time;       // seconds since mount
uniform float u_intensity;  // 0..1
uniform vec2  u_resolution;

// Barrel distortion — push UVs outward from center based on r^2.
vec2 barrel(vec2 uv, float k) {
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  return uv + c * r2 * k;
}

void main() {
  // Curvature scales with intensity but never gets too aggressive.
  float k = 0.18 + u_intensity * 0.35;
  vec2 uv = barrel(v_uv, k);

  // Outside-the-tube mask — pixels that fell off the curved edge go
  // black. Soft falloff at the boundary so it doesn't read as a
  // hard-cropped rectangle.
  float edgeX = smoothstep(0.0, 0.02, uv.x) * smoothstep(0.0, 0.02, 1.0 - uv.x);
  float edgeY = smoothstep(0.0, 0.02, uv.y) * smoothstep(0.0, 0.02, 1.0 - uv.y);
  float edge = edgeX * edgeY;

  // Horizontal scanlines — fine bars at native pixel scale.
  float scanY = uv.y * u_resolution.y;
  float scan = 0.5 + 0.5 * sin(scanY * 3.14159);
  // Make the bars thicker / more visible at higher intensity.
  float scanStrength = mix(0.08, 0.35, u_intensity);
  float scanMul = 1.0 - scan * scanStrength;

  // Slot-mask shimmer — vertical RGB triad approximation. We just darken
  // every third column slightly; the screen blend on the canvas tint
  // produces the colored-stripe sensation when composited over text.
  float slot = 0.92 + 0.08 * sin(uv.x * u_resolution.x * 2.0944); // 2π/3
  float pixelMul = scanMul * slot;

  // Vignette — same as the CSS layer but cheaper here since we already
  // have r^2 in scope conceptually. Use the post-barrel uv so it tracks
  // the curved edge.
  vec2 c = uv - 0.5;
  float vig = 1.0 - dot(c, c) * (1.2 + u_intensity * 0.8);
  vig = clamp(vig, 0.0, 1.0);

  // Phosphor glow — slow brightness pulse.
  float pulse = 0.97 + 0.03 * sin(u_time * 1.7);

  // Final composite: a translucent dark bar that screens darker = scanlines,
  // multiplied by edge mask + vignette + pulse. Alpha rises with intensity
  // so the user can see what they're tuning.
  float darken = (1.0 - pixelMul) * edge * vig * pulse;
  float baseAlpha = mix(0.18, 0.55, u_intensity);
  outColor = vec4(0.0, 0.0, 0.0, darken * baseAlpha + (1.0 - edge) * 0.85);
}`;

export default function mount(host, ctx) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
  // Multiply: the shader output is mostly black with darker bars, so
  // multiplying darkens the underlying editor exactly where the bars are
  // and leaves the rest untouched.
  canvas.style.mixBlendMode = "multiply";
  host.appendChild(canvas);

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

  // ── shader compile ──────────────────────────────────────────────────
  const program = link(gl, VERT, FRAG);
  if (!program) {
    canvas.remove();
    return { update() {}, dispose() {} };
  }
  gl.useProgram(program);

  const uTime = gl.getUniformLocation(program, "u_time");
  const uIntensity = gl.getUniformLocation(program, "u_intensity");
  const uRes = gl.getUniformLocation(program, "u_resolution");

  // Fullscreen triangle pair — two tris cover the clip cube.
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1,  -1, 1,
    -1,  1,  1, -1,   1, 1,
  ]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  let intensity = clamp(ctx.intensity);
  let visible = !document.hidden && document.hasFocus();
  let rafId = 0;
  const start = performance.now();

  function resize() {
    const w = ctx.width;
    const h = ctx.height;
    // CRT effect doesn't benefit from full DPR — the scanline math reads
    // the *target* resolution and we want bars roughly 1px tall on screen,
    // so render at native CSS pixels and let the browser upsample. That
    // saves ~4x fragment work on a Retina display with no visible loss.
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
    gl.clearColor(0, 0, 0, 0);
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
      // Explicitly drop the GPU context — WebKit holds onto canvas-backed
      // GPU memory longer than you'd expect otherwise.
      const lose = gl.getExtension("WEBGL_lose_context");
      try { lose && lose.loseContext(); } catch (_) {}
      canvas.remove();
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
