/**
 * Caret effects for WebGL2 background layers — sparks / bubbles /
 * ripples presets that follow the caret. The renderer keeps a short
 * trail of recent caret positions (position + birth time + seed) and
 * hands it to a preset-specific fragment shader as a uniform array, so
 * every visual is stateless per frame: particles are pure functions of
 * (trail entry, age), which keeps the whole thing resumable and cheap.
 *
 * The rAF loop self-parks when the trail has fully faded and the caret
 * is still, then wakes on caret movement via a low-rate poll — an idle
 * editor pays a 4 Hz position compare, not a 60 Hz draw.
 */
import { linkProgram, setupQuad, QUAD_VERT, hexToVec3, clamp01, sizeCanvas } from "./webgl-utils.js";

const TRAIL = 12;

const COMMON = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2  u_resolution;
uniform float u_time;
uniform float u_px;        // backing-store px per CSS px
uniform vec4  u_trail[${TRAIL}]; // x, y (backing px, y-down), birth (s), seed
uniform vec3  u_color;
uniform float u_intensity;

float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
`;

// Sparks: each trail entry throws a handful of bright motes upward that
// arc over and die out.
const FRAG_SPARKS = COMMON + `
void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  float acc = 0.0;
  for (int i = 0; i < ${TRAIL}; i++) {
    vec4 tp = u_trail[i];
    if (tp.z < 0.0) continue;
    float age = u_time - tp.z;
    if (age < 0.0 || age > 1.2) continue;
    float fade = 1.0 - age / 1.2;
    for (int j = 0; j < 4; j++) {
      float fj = float(j);
      float h1 = hash(tp.w + fj * 17.3);
      float h2 = hash(tp.w + fj * 31.7 + 5.0);
      float h3 = hash(tp.w + fj * 7.9 + 11.0);
      vec2 dir = vec2((h1 - 0.5) * 2.2, -(0.7 + 1.1 * h2));
      float spd = (45.0 + 110.0 * h3) * u_px;
      vec2 p = tp.xy + dir * spd * age + vec2(0.0, 190.0 * u_px * age * age);
      float r = (1.2 + 1.6 * h2) * u_px;
      float d = length(frag - p);
      acc += exp(-d * d / (r * r * 4.0)) * fade;
    }
  }
  float a = clamp(acc * u_intensity, 0.0, 0.85);
  outColor = vec4(u_color * a, a);
}`;

// Bubbles: soft rings drifting up from the caret with a lateral wobble.
const FRAG_BUBBLES = COMMON + `
void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  float acc = 0.0;
  for (int i = 0; i < ${TRAIL}; i++) {
    vec4 tp = u_trail[i];
    if (tp.z < 0.0) continue;
    float age = u_time - tp.z;
    if (age < 0.0 || age > 2.2) continue;
    float fade = 1.0 - age / 2.2;
    for (int j = 0; j < 3; j++) {
      float fj = float(j);
      float h1 = hash(tp.w + fj * 13.1);
      float h2 = hash(tp.w + fj * 29.7 + 3.0);
      float rise = (26.0 + 40.0 * h1) * u_px;
      float wob = sin(age * (2.0 + 3.0 * h2) + h1 * 6.283) * 9.0 * u_px;
      vec2 p = tp.xy + vec2(wob + (h2 - 0.5) * 26.0 * u_px, -rise * age);
      float radius = (2.5 + 4.5 * h2 + age * 2.0) * u_px;
      float d = abs(length(frag - p) - radius);
      float band = 1.1 * u_px;
      acc += exp(-d * d / (band * band * 2.0)) * fade * 0.8;
    }
  }
  float a = clamp(acc * u_intensity, 0.0, 0.8);
  outColor = vec4(u_color * a, a);
}`;

// Ripples: expanding rings centred where the caret has been.
const FRAG_RIPPLES = COMMON + `
void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  float acc = 0.0;
  for (int i = 0; i < ${TRAIL}; i++) {
    vec4 tp = u_trail[i];
    if (tp.z < 0.0) continue;
    float age = u_time - tp.z;
    if (age < 0.0 || age > 1.8) continue;
    float radius = age * 95.0 * u_px;
    float d = abs(length(frag - tp.xy) - radius);
    float band = (2.0 + age * 3.0) * u_px;
    acc += exp(-d * d / (band * band)) * exp(-age * 2.1);
  }
  float a = clamp(acc * u_intensity, 0.0, 0.8);
  outColor = vec4(u_color * a, a);
}`;

const FRAGS = { sparks: FRAG_SPARKS, bubbles: FRAG_BUBBLES, ripples: FRAG_RIPPLES };
const LIFETIMES = { sparks: 1.2, bubbles: 2.2, ripples: 1.8 };

/**
 * Mount a caret-effect canvas into `host`. `cfg` is `{ preset, color,
 * intensity }`; `caretSource.get()` yields the caret in viewport px.
 * Returns `{ update, resize, setVisible, dispose }` — `update` can swap
 * presets in place (relinks the program, keeps the canvas).
 */
export function createCaretEffect(host, cfg, caretSource, ctx) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
  host.appendChild(canvas);

  const gl = canvas.getContext("webgl2", {
    alpha: true, premultipliedAlpha: false, antialias: false,
    depth: false, stencil: false, powerPreference: "low-power",
  });
  if (!gl) {
    canvas.remove();
    return { update() {}, resize() {}, setVisible() {}, dispose() {} };
  }

  let preset = cfg.preset;
  let color = hexToVec3(cfg.color || "#9ecbff");
  let intensity = clamp01(cfg.intensity ?? 0.6);

  let program = null;
  let uni = {};
  function buildProgram() {
    const frag = FRAGS[preset];
    if (!frag) { program = null; return; }
    program = linkProgram(gl, QUAD_VERT, frag);
    if (!program) return;
    gl.useProgram(program);
    setupQuad(gl, program);
    uni = {
      res: gl.getUniformLocation(program, "u_resolution"),
      time: gl.getUniformLocation(program, "u_time"),
      px: gl.getUniformLocation(program, "u_px"),
      trail: gl.getUniformLocation(program, "u_trail[0]"),
      color: gl.getUniformLocation(program, "u_color"),
      intensity: gl.getUniformLocation(program, "u_intensity"),
    };
  }
  buildProgram();

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  // Trail ring: flat vec4 array, birth < 0 marks an empty slot.
  const trail = new Float32Array(TRAIL * 4).fill(-1);
  let trailHead = 0;
  let lastPush = { x: -1e9, y: -1e9, t: 0 };
  const epoch = performance.now();
  const now = () => (performance.now() - epoch) / 1000;

  // Cached canvas rect for viewport→canvas conversion; refreshed on
  // resize and on a slow interval (the editor host only moves with
  // window / layout changes, so a 500 ms refresh is plenty).
  let rect = canvas.getBoundingClientRect();
  const rectTimer = setInterval(() => { rect = canvas.getBoundingClientRect(); }, 500);
  let pxScale = 1;

  function pushIfMoved() {
    const c = caretSource.get();
    if (!c || !c.valid) return false;
    const t = now();
    const dx = c.x - lastPush.x, dy = c.y - lastPush.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 3 && t - lastPush.t < 0.12) return false;
    if (dist < 0.5) return false;
    lastPush = { x: c.x, y: c.y, t };
    const bx = (c.x - rect.left) * pxScale;
    const by = (c.y - rect.top) * pxScale;
    const o = trailHead * 4;
    trail[o] = bx; trail[o + 1] = by; trail[o + 2] = t; trail[o + 3] = Math.random() * 100;
    trailHead = (trailHead + 1) % TRAIL;
    return true;
  }

  function anyAlive() {
    const t = now();
    const life = LIFETIMES[preset] || 2;
    for (let i = 0; i < TRAIL; i++) {
      const birth = trail[i * 4 + 2];
      if (birth >= 0 && t - birth < life) return true;
    }
    return false;
  }

  let rafId = 0;
  let wakeTimer = 0;
  let visible = true;

  function draw() {
    rafId = 0;
    if (!visible || !program) return;
    pushIfMoved();
    if (!anyAlive()) { park(); return; }
    gl.useProgram(program);
    gl.uniform2f(uni.res, canvas.width, canvas.height);
    gl.uniform1f(uni.time, now());
    gl.uniform1f(uni.px, pxScale);
    gl.uniform4fv(uni.trail, trail);
    gl.uniform3f(uni.color, color[0], color[1], color[2]);
    gl.uniform1f(uni.intensity, intensity);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    rafId = requestAnimationFrame(draw);
  }

  // Idle: everything faded → clear once, stop drawing, and poll the
  // caret at 4 Hz for a wake-up instead of burning rAF frames.
  function park() {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!wakeTimer) {
      wakeTimer = setInterval(() => {
        if (visible && pushIfMoved()) { unpark(); }
      }, 250);
    }
  }
  function unpark() {
    if (wakeTimer) { clearInterval(wakeTimer); wakeTimer = 0; }
    if (!rafId) rafId = requestAnimationFrame(draw);
  }

  function resize(width, height, dpr) {
    sizeCanvas(canvas, gl, width, height, dpr);
    pxScale = width > 0 ? canvas.width / width : 1;
    rect = canvas.getBoundingClientRect();
  }
  resize(ctx.width, ctx.height, ctx.dpr);
  unpark();

  return {
    update(nextCfg) {
      const nextPreset = nextCfg.preset;
      color = hexToVec3(nextCfg.color || "#9ecbff");
      intensity = clamp01(nextCfg.intensity ?? 0.6);
      if (nextPreset !== preset) {
        preset = nextPreset;
        buildProgram();
      }
      unpark();
    },
    resize,
    setVisible(v) {
      visible = v;
      if (v) unpark();
      else { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } if (wakeTimer) { clearInterval(wakeTimer); wakeTimer = 0; } }
    },
    dispose() {
      visible = false;
      if (rafId) cancelAnimationFrame(rafId);
      if (wakeTimer) clearInterval(wakeTimer);
      clearInterval(rectTimer);
      try {
        const lose = gl.getExtension("WEBGL_lose_context");
        lose && lose.loseContext();
      } catch (_) {}
      try { canvas.remove(); } catch (_) {}
    },
  };
}
