/**
 * WebGL2 layer: neon bloom — three soft colored glow blobs drifting
 * across the screen, screen-blended onto the editor.
 *
 * Knobs (registry-defined):
 *   - brightness:  master bloom brightness (0..1)
 *   - speed:       drift speed (0..1, mapped to 0..2× base rate)
 *   - color1/2/3:  hex colors of the three blobs
 *
 * Intensity is the master scale that multiplies brightness, so it
 * smoothly fades the whole layer to nothing at intensity 0.
 *
 * Why a fragment shader vs CSS: smoothly interpolating sub-pixel blob
 * positions every frame in CSS forces paint cycles on the entire layer.
 * The shader does the same compositing on the GPU at <1ms/frame and
 * gives us per-pixel smoothness. If you don't notice the difference,
 * the CSS path is fine.
 *
 * Blend mode lives on the host element (not the canvas) — putting it
 * on the canvas isolates the blend to the host's transparent backdrop.
 * rAF loop is gated on visibility + focus via ctx.onVisible; WebGL
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
uniform float u_brightness;   // master output scale (intensity * knob)
uniform vec2  u_resolution;
uniform vec3  u_color1;
uniform vec3  u_color2;
uniform vec3  u_color3;

vec3 glow(vec2 uv, vec2 c, float r, vec3 color, float aspect) {
  vec2 d = (uv - c) * vec2(aspect, 1.0);
  float dist = length(d);
  float core = smoothstep(r * 0.25, 0.0, dist);
  float halo = smoothstep(r,        0.0, dist);
  return color * (core * 0.55 + halo * 0.45);
}

void main() {
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);

  // Drift positions — irrationally-related rates so the pattern
  // never visibly repeats. u_time already incorporates the speed knob.
  float t = u_time;
  vec2 p1 = vec2(0.28 + 0.22 * sin(t * 1.13), 0.40 + 0.18 * cos(t * 0.91));
  vec2 p2 = vec2(0.74 + 0.18 * cos(t * 0.87), 0.62 + 0.20 * sin(t * 1.07));
  vec2 p3 = vec2(0.50 + 0.26 * sin(t * 0.63), 0.50 + 0.22 * cos(t * 1.27));

  vec3 col = vec3(0.0);
  col += glow(v_uv, p1, 0.55, u_color1, aspect);
  col += glow(v_uv, p2, 0.55, u_color2, aspect);
  col += glow(v_uv, p3, 0.55, u_color3, aspect);

  col *= u_brightness;

  float a = clamp((col.r + col.g + col.b) * 0.85, 0.0, 0.9);
  outColor = vec4(col, a);
}`;

export default function mount(host, ctx) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
  host.appendChild(canvas);
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
  const uBright = gl.getUniformLocation(program, "u_brightness");
  const uRes = gl.getUniformLocation(program, "u_resolution");
  const uC1 = gl.getUniformLocation(program, "u_color1");
  const uC2 = gl.getUniformLocation(program, "u_color2");
  const uC3 = gl.getUniformLocation(program, "u_color3");

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

  // Per-frame state derived from intensity + options.
  let intensity = clamp(ctx.intensity);
  let options = ctx.options || {};
  let visible = !document.hidden && document.hasFocus();
  let rafId = 0;
  const start = performance.now();
  // `timeAccum` accumulates real-time × current speed so changing the
  // speed knob doesn't snap the blobs — they smoothly continue from
  // wherever they were.
  let timeAccum = 0;
  let lastClock = start;

  function applyOptions() {
    const c1 = hexToVec3(options.color1 || "#f334a6");
    const c2 = hexToVec3(options.color2 || "#34c4f4");
    const c3 = hexToVec3(options.color3 || "#8c4ce8");
    gl.uniform3f(uC1, c1[0], c1[1], c1[2]);
    gl.uniform3f(uC2, c2[0], c2[1], c2[2]);
    gl.uniform3f(uC3, c3[0], c3[1], c3[2]);
  }
  applyOptions();

  function resize() {
    const w = ctx.width;
    const h = ctx.height;
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
    const now = performance.now();
    // Speed knob 0..1 → multiplier 0..2 over a base rate of 0.10/sec.
    const speed = num(options.speed, 0.4) * 2 * 0.10;
    timeAccum += ((now - lastClock) / 1000) * speed;
    lastClock = now;
    // brightness knob × master intensity; clamp so high knob values
    // don't blow out the screen blend.
    const bright = clamp(num(options.brightness, 0.55) * intensity);

    gl.uniform1f(uTime, timeAccum);
    gl.uniform1f(uBright, bright);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    rafId = requestAnimationFrame(draw);
  }
  function startLoop() {
    if (!rafId && visible) {
      lastClock = performance.now();
      rafId = requestAnimationFrame(draw);
    }
  }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }

  ctx.onResize = () => { resize(); };
  ctx.onVisible = (v) => {
    visible = v;
    if (v) startLoop(); else stopLoop();
  };

  resize();
  startLoop();

  return {
    update({ intensity: i, options: o }) {
      intensity = clamp(i);
      options = o || {};
      applyOptions();
    },
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

function num(v, fallback) {
  return (typeof v === "number" && !Number.isNaN(v)) ? v : fallback;
}

function hexToVec3(hex) {
  // Accepts #rgb, #rrggbb. Returns [r, g, b] in 0..1.
  const h = (hex || "").replace("#", "");
  const expand = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const r = (parseInt(expand.slice(0, 2), 16) || 0) / 255;
  const g = (parseInt(expand.slice(2, 4), 16) || 0) / 255;
  const b = (parseInt(expand.slice(4, 6), 16) || 0) / 255;
  return [r, g, b];
}
