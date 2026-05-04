/**
 * WebGL2 layer: neon bloom — three soft colored glow blobs drifting
 * across the screen, screen-blended onto the editor.
 *
 * Replaces the earlier CRT shader (which the user found too flickery).
 * Goal here is the "atmospheric neon" feel — like distant pink/cyan
 * signs cast a soft glow on the writing surface — without any
 * scanlines, retrace, or rapid flicker.
 *
 * Why this is worth a fragment shader instead of CSS: the closest CSS
 * equivalent is animated `radial-gradient(...)` keyframes with
 * `mix-blend-mode: screen`. That works for a *static* set of glows but
 * smoothly interpolating sub-pixel positions every frame in CSS forces
 * paint cycles on the entire layer. The fragment shader does the same
 * compositing on the GPU at <1ms per frame and gives us per-pixel
 * smoothness. Honest answer though: if you don't notice the difference,
 * the CSS path is fine.
 *
 * The blend mode lives on the host element (not the canvas) — putting
 * it on the canvas isolates the blend to the host's transparent
 * backdrop, painting the canvas opaque over the editor. With it on the
 * host, the entire layer composites onto everything in body's stacking
 * context.
 *
 * rAF loop is gated on visibility + focus via ctx.onVisible. WebGL
 * context is loseContext()-ed on dispose.
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

// Soft glow falloff: brighter core, much softer halo. Two stacked
// smoothsteps approximate a Gaussian without the cost of expensive
// exp() calls and read better at low intensity.
vec3 glow(vec2 uv, vec2 c, float r, vec3 color, float aspect) {
  // Correct for non-square viewport so blobs stay round.
  vec2 d = (uv - c) * vec2(aspect, 1.0);
  float dist = length(d);
  float core = smoothstep(r * 0.25, 0.0, dist);
  float halo = smoothstep(r,        0.0, dist);
  return color * (core * 0.55 + halo * 0.45);
}

void main() {
  // Aspect-corrected coords — without this the blobs squish on
  // wide viewports.
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);

  // Three blobs drifting at slow, irrationally-related rates so the
  // pattern never visibly repeats.
  float t = u_time * 0.10; // overall slow drift
  vec2 p1 = vec2(0.28 + 0.22 * sin(t * 1.13), 0.40 + 0.18 * cos(t * 0.91));
  vec2 p2 = vec2(0.74 + 0.18 * cos(t * 0.87), 0.62 + 0.20 * sin(t * 1.07));
  vec2 p3 = vec2(0.50 + 0.26 * sin(t * 0.63), 0.50 + 0.22 * cos(t * 1.27));

  vec3 col = vec3(0.0);
  // Magenta / cyan / violet — classic neon palette, complementary
  // hues so the screen blend produces clean whites where they overlap
  // instead of muddy browns.
  col += glow(v_uv, p1, 0.55, vec3(0.95, 0.20, 0.65), aspect); // magenta
  col += glow(v_uv, p2, 0.55, vec3(0.20, 0.78, 0.95), aspect); // cyan
  col += glow(v_uv, p3, 0.55, vec3(0.55, 0.30, 0.92), aspect); // violet

  // Intensity scales the whole bloom. At 0 every channel is 0, so the
  // canvas paints transparent black everywhere — invisible.
  col *= u_intensity * 0.45;

  // Output as straight alpha blend (no mix-blend-mode: screen needed —
  // the canvas alpha-composites and the host carries the screen blend).
  // alpha = brightness, so dark regions stay transparent (editor shows)
  // and bright regions composite as colored bloom.
  float a = clamp((col.r + col.g + col.b) * 0.85, 0.0, 0.9);
  outColor = vec4(col, a);
}`;

export default function mount(host, ctx) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
  host.appendChild(canvas);
  // Screen blend on the HOST (not the canvas) so the entire layer
  // brightens the editor underneath. Screen mode never darkens; it
  // only adds light, which is what bloom should do.
  host.style.mixBlendMode = "screen";

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
    // Fallback for platforms without WebGL2: animated CSS radial
    // gradients in the same neon palette. Less smooth but the same
    // visual idea.
    canvas.remove();
    host.style.background = `
      radial-gradient(circle at 30% 40%, rgba(244,52,166,0.18), transparent 50%),
      radial-gradient(circle at 70% 60%, rgba(52,196,244,0.18), transparent 50%),
      radial-gradient(circle at 50% 50%, rgba(140,76,232,0.14), transparent 55%)`;
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
    host.style.mixBlendMode = "";
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

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  let intensity = clamp(ctx.intensity);
  let visible = !document.hidden && document.hasFocus();
  let rafId = 0;
  const start = performance.now();

  function resize() {
    const w = ctx.width;
    const h = ctx.height;
    // Render at half-DPR (or native CSS px on non-retina). The blobs
    // are smooth volumetric gradients, so upsampling adds an extra
    // hint of softness for free — perfect for a bloom layer.
    const dpr = Math.min(ctx.dpr, 1.0);
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
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
      try {
        const lose = gl.getExtension("WEBGL_lose_context");
        lose && lose.loseContext();
      } catch (_) {}
      try { canvas.remove(); } catch (_) {}
      try { host.style.mixBlendMode = ""; } catch (_) {}
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
