/**
 * Caret effects for caret background layers — presets that follow the
 * text cursor. The renderer keeps a short trail of recent caret
 * positions (position + birth time + seed) and hands it to a
 * preset-specific fragment shader as a uniform array, so every visual
 * is stateless per frame: particles are pure functions of
 * (trail entry, age), which keeps the whole thing resumable and cheap.
 *
 * Beyond the trail, presets can read the *current* caret (u_caret /
 * u_caretH) and two JS-side dynamics: u_activity, an exponential
 * bump-and-decay of trail pushes that tracks typing speed, and
 * u_angle, rotation accumulated at an activity-scaled rate (accumulated
 * rather than derived from time so speed changes never snap).
 *
 * Idle behaviour is per-preset (PARK_MODES): trail presets clear the
 * canvas and park once everything has faded; "freeze" presets (HUD)
 * draw one last static frame and park; "run" presets (flicker bar)
 * animate whenever a caret exists — visibility gating still stops them
 * when the window blurs. Parked loops wake on a 4 Hz caret poll, so an
 * idle editor pays no per-frame cost.
 */
import { linkProgram, setupQuad, QUAD_VERT, hexToVec3, clamp01, sizeCanvas } from "./webgl-utils.js";

const TRAIL = 16;

const COMMON = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2  u_resolution;
uniform float u_time;
uniform float u_px;        // backing-store px per CSS px
uniform vec4  u_trail[${TRAIL}]; // x, y (backing px, y-down), birth (s), seed
uniform vec3  u_color;
uniform float u_intensity;
uniform vec2  u_caret;     // current caret (backing px, y-down)
uniform float u_caretH;    // caret height (backing px)
uniform float u_angle;     // accumulated rotation (radians)
uniform float u_activity;  // typing speed, 0..1

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
  outColor = vec4(u_color, a);
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
  outColor = vec4(u_color, a);
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
  outColor = vec4(u_color, a);
}`;

// Underline glow: each trail entry lays a short glowing underline just
// below its baseline that takes a few seconds to fade — consecutive
// entries overlap, so fast typing reads as one continuous streak.
const FRAG_UNDERLINE = COMMON + `
void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  float acc = 0.0;
  for (int i = 0; i < ${TRAIL}; i++) {
    vec4 tp = u_trail[i];
    if (tp.z < 0.0) continue;
    float age = u_time - tp.z;
    if (age < 0.0 || age > 3.5) continue;
    float fade = exp(-age * 0.85);
    vec2 c = vec2(tp.x, tp.y + u_caretH * 0.42);
    float dx = max(abs(frag.x - c.x) - 9.0 * u_px, 0.0);
    float dy = frag.y - c.y;
    float core = 1.6 * u_px;
    float halo = 4.5 * u_px;
    float d2 = dx * dx + dy * dy;
    acc += (exp(-d2 / (core * core * 2.0)) * 0.9
          + exp(-d2 / (halo * halo * 2.0)) * 0.5) * fade;
  }
  float a = clamp(acc * u_intensity, 0.0, 0.9);
  outColor = vec4(u_color, a);
}`;

// HUD: concentric rings of radial hash marks around the caret — an
// old-watch-bezel crosshair. Ring rotation rides u_angle, which the JS
// side accumulates at a typing-speed-scaled rate, and brightness leans
// on u_activity so the whole instrument wakes up as you type.
const FRAG_HUD = COMMON + `
float ring(vec2 d, float r, float R, float N, float rot, float tickHalf, float sharp) {
  float theta = atan(d.y, d.x) + rot;
  float t = pow(max(cos(theta * N), 0.0), sharp);
  float band = smoothstep(tickHalf, tickHalf * 0.3, abs(r - R));
  return t * band;
}
void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  vec2 d = frag - u_caret;
  float r = length(d);
  float px = u_px;
  float acc = 0.0;
  acc += ring(d, r, 30.0 * px, 8.0,  u_angle,         5.0 * px, 12.0) * 1.15;
  acc += ring(d, r, 46.0 * px, 24.0, -u_angle * 0.62, 4.0 * px, 26.0) * 0.95;
  acc += ring(d, r, 62.0 * px, 48.0, u_angle * 0.38,  3.0 * px, 40.0) * 0.75;
  acc += smoothstep(1.6 * px, 0.4 * px, abs(r - 16.0 * px)) * 0.6;
  acc *= 0.6 + 0.4 * u_activity;
  float a = clamp(acc * u_intensity, 0.0, 0.85);
  outColor = vec4(u_color, a);
}`;

// Flicker bar: a full-width phosphor bar at the caret's line, with a
// faint two-rate flicker and scanline texture. Deliberately quiet — the
// alpha ceiling keeps it a glow, not a highlight.
const FRAG_FLICKER = COMMON + `
void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  float halfH = max(u_caretH * 0.62, 6.0 * u_px);
  float dy = abs(frag.y - u_caret.y);
  float band = smoothstep(halfH, halfH * 0.35, dy);
  float f1 = hash(floor(u_time * 16.0));
  float f2 = hash(floor(u_time * 43.0) + 7.0);
  float flicker = 0.82 + 0.12 * f1 + 0.06 * f2;
  float scan = 0.9 + 0.1 * sin(frag.y * 6.283 / max(3.0 * u_px, 1.0));
  float a = band * flicker * scan * u_intensity * 0.35;
  outColor = vec4(u_color, clamp(a, 0.0, 0.6));
}`;

const FRAGS = {
  sparks: FRAG_SPARKS,
  bubbles: FRAG_BUBBLES,
  ripples: FRAG_RIPPLES,
  underline: FRAG_UNDERLINE,
  hud: FRAG_HUD,
  flicker: FRAG_FLICKER,
};
const LIFETIMES = { sparks: 1.2, bubbles: 2.2, ripples: 1.8, underline: 3.5, hud: 3.0, flicker: 3.0 };
// clear: fade out, wipe, park. freeze: park on the last-drawn frame (the
// HUD stays parked at the caret). run: never trail-park — animate while
// a caret exists and the window is visible.
const PARK_MODES = { sparks: "clear", bubbles: "clear", ripples: "clear", underline: "clear", hud: "freeze", flicker: "run" };

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
    // Locations for uniforms a preset doesn't use come back null;
    // gl.uniform* on a null location is a spec-defined silent no-op.
    uni = {
      res: gl.getUniformLocation(program, "u_resolution"),
      time: gl.getUniformLocation(program, "u_time"),
      px: gl.getUniformLocation(program, "u_px"),
      trail: gl.getUniformLocation(program, "u_trail[0]"),
      color: gl.getUniformLocation(program, "u_color"),
      intensity: gl.getUniformLocation(program, "u_intensity"),
      caret: gl.getUniformLocation(program, "u_caret"),
      caretH: gl.getUniformLocation(program, "u_caretH"),
      angle: gl.getUniformLocation(program, "u_angle"),
      activity: gl.getUniformLocation(program, "u_activity"),
    };
  }
  buildProgram();

  // No blending: each preset draws a single quad over a freshly cleared
  // transparent buffer, so straight (colour, alpha) output is exact. The
  // old SRC_ALPHA blend was actively wrong here — with a non-premultiplied
  // canvas it lands destination alpha as a² and colour as colour×a, which
  // double-darkens faint output and turned the designed fades into
  // squared ones (an exp(-1.1t) fade displayed as exp(-2.2t)).

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

  // Frame-to-frame dynamics for the presets that use them.
  const lastCaret = { bx: 0, by: 0, bh: 22, valid: false };
  let activity = 0;      // typing speed, bumped per trail push, decays
  let angleAccum = 0;    // HUD rotation
  let lastFrameT = 0;

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
    activity = Math.min(1, activity + 0.25);
    return true;
  }

  function updateDynamics() {
    const c = caretSource.get();
    if (c && c.valid) {
      lastCaret.bx = (c.x - rect.left) * pxScale;
      lastCaret.by = (c.y - rect.top) * pxScale;
      lastCaret.bh = (c.h || 22) * pxScale;
      lastCaret.valid = true;
    }
    const t = now();
    const dt = Math.min(Math.max(t - lastFrameT, 0), 0.1);
    lastFrameT = t;
    activity = Math.max(0, activity - dt / 1.2);
    // Idle drift + typing-speed spin-up.
    angleAccum += dt * (0.25 + 3.0 * activity);
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

  function renderFrame() {
    gl.useProgram(program);
    gl.uniform2f(uni.res, canvas.width, canvas.height);
    gl.uniform1f(uni.time, now());
    gl.uniform1f(uni.px, pxScale);
    gl.uniform4fv(uni.trail, trail);
    gl.uniform3f(uni.color, color[0], color[1], color[2]);
    gl.uniform1f(uni.intensity, intensity);
    gl.uniform2f(uni.caret, lastCaret.bx, lastCaret.by);
    gl.uniform1f(uni.caretH, lastCaret.bh);
    gl.uniform1f(uni.angle, angleAccum);
    gl.uniform1f(uni.activity, activity);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function draw() {
    rafId = 0;
    if (!visible || !program) return;
    pushIfMoved();
    updateDynamics();
    const mode = PARK_MODES[preset] || "clear";
    const alive = mode === "run" ? lastCaret.valid : anyAlive();
    if (!alive) { park(mode); return; }
    renderFrame();
    rafId = requestAnimationFrame(draw);
  }

  // Idle: stop drawing and poll the caret at 4 Hz for a wake-up instead
  // of burning rAF frames. What stays on screen depends on the preset's
  // park mode (see PARK_MODES).
  function park(mode) {
    if (mode === "freeze" && lastCaret.valid) {
      renderFrame();
    } else {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    if (!wakeTimer) {
      wakeTimer = setInterval(() => {
        if (!visible) return;
        const m = PARK_MODES[preset] || "clear";
        const wake = m === "run" ? !!caretSource.get()?.valid : pushIfMoved();
        if (wake) unpark();
      }, 250);
    }
  }
  function unpark() {
    if (wakeTimer) { clearInterval(wakeTimer); wakeTimer = 0; }
    if (!rafId) {
      lastFrameT = now();
      rafId = requestAnimationFrame(draw);
    }
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
