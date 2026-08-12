/**
 * Caret effects for caret background layers — presets that follow the
 * text cursor. The renderer keeps a short trail of recent caret
 * positions (position + birth time + seed) and hands it to a
 * preset-specific fragment shader as a uniform array, so every visual
 * is stateless per frame: particles are pure functions of
 * (trail entry, age), which keeps the whole thing resumable and cheap.
 *
 * Beyond the trail, a preset can read the *current* caret (u_caret /
 * u_caretH) — that's what the flicker bar rides.
 *
 * Idle behaviour is per-preset (PARK_MODES): trail presets clear the
 * canvas and park once everything has faded; "run" presets (flicker bar)
 * animate whenever a caret exists — visibility gating still stops them
 * when the window blurs. Parked loops wake on a 4 Hz caret poll, so an
 * idle editor pays no per-frame cost.
 *
 * Brightness is *not* a shader knob. Each preset draws at its own tuned
 * alpha ceiling and the layer's per-appearance opacity (on the slot
 * element, exactly as for image and gradient layers) is what dials it
 * up and down — one control instead of two that multiplied together.
 */
import { linkProgram, setupQuad, QUAD_VERT, hexToVec3, num, sizeCanvas } from "./webgl-utils.js";
import { resolveCaretPreset } from "./effects-registry.js";

const TRAIL = 16;

/** How long a trail entry lives, in seconds. Underline exposes it as the
 *  "trail length" knob; every other preset has a fixed tuned value. */
function presetLife(preset, cfg) {
  if (preset === "underline") {
    return Math.max(0.3, num(cfg?.trailSeconds, UNDERLINE_DEFAULTS.trailSeconds));
  }
  return LIFETIMES[preset] || 2;
}

const COMMON = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2  u_resolution;
uniform float u_time;
uniform float u_px;        // backing-store px per CSS px
uniform vec4  u_trail[${TRAIL}]; // x, y (backing px, y-down), birth (s), seed
uniform vec3  u_color;
uniform vec2  u_caret;     // current caret (backing px, y-down)
uniform float u_caretH;    // caret height (backing px)
uniform float u_lineH;     // underline thickness (CSS px)
uniform float u_life;      // trail lifetime (s) — how long the streak lasts
uniform float u_sparkH;    // sparks: hop height (CSS px)
uniform float u_offsetY;   // underline glow: vertical nudge (CSS px)

float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
`;

// Every preset below is tuned for STRAIGHT alpha (blending is off, see
// the mount code). Under the old SRC_ALPHA path alpha was silently
// squared, so a gaussian's outer half was invisible and the shapes read
// as small tight marks. Once that squaring went away those halos became
// visible and the same numbers rendered as huge soft blobs — hence the
// tight radii, hard falloffs and low alpha ceilings here.

// Sparks: a few 1-2px motes per keystroke, thrown sideways off the text
// baseline and bouncing along it with a decaying hop before winking out.
// The hop is |sin| under an exponential rather than a simulated bounce:
// same read, one sin and one exp instead of an iterated collision. Its
// amplitude scales with u_sparkH, the "height" knob, so the same preset
// covers a low shower of grit and a tall firework.
const FRAG_SPARKS = COMMON + `
void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  float acc = 0.0;
  for (int i = 0; i < ${TRAIL}; i++) {
    vec4 tp = u_trail[i];
    if (tp.z < 0.0) continue;
    float age = u_time - tp.z;
    if (age < 0.0 || age > 0.75) continue;
    float fade = 1.0 - age / 0.75;
    fade *= fade;
    float baseY = tp.y + u_caretH * 0.30;
    // Cheap bbox reject before the per-particle exp() work. Bounds the
    // fill cost now that the canvas renders at full device resolution.
    // Motes only ever hop *up* from the baseline, so the box is
    // lopsided: a couple of px below, the full hop height above.
    if (frag.y - baseY > 6.0 * u_px) continue;
    if (baseY - frag.y > (u_sparkH * 1.7 + 8.0) * u_px) continue;
    if (abs(frag.x - tp.x) > 300.0 * u_px) continue;
    for (int j = 0; j < 3; j++) {
      float fj = float(j);
      float h1 = hash(tp.w + fj * 17.3);
      float h2 = hash(tp.w + fj * 31.7 + 5.0);
      float h3 = hash(tp.w + fj * 7.9 + 11.0);
      float vx = (h1 - 0.5) * 190.0 * u_px;
      float period = 0.15 + 0.13 * h2;
      float amp = (0.45 + 1.15 * h3) * u_sparkH * u_px;
      float hop = amp * abs(sin(3.14159265 * age / period)) * exp(-age * 3.4);
      vec2 p = vec2(tp.x + vx * age, baseY - hop);
      float d = length(frag - p);
      // A hard little disc with a one-pixel soft edge, not a gaussian:
      // shrunk to spark size a gaussian spends all its brightness on
      // the falloff and the motes wash out to nothing. Half-coverage at
      // 0.85 CSS px of radius is a mote 1-2 px across that still reads
      // at full alpha in the middle.
      float rad = 0.85 * u_px;
      float aa = max(0.55 * u_px, 0.5);
      acc += (1.0 - smoothstep(rad - aa, rad + aa, d)) * fade;
    }
  }
  outColor = vec4(u_color, clamp(acc, 0.0, 1.0) * 0.95);
}`;

// Underline glow: a solid filled bar under the text, drawn as capsules
// between consecutive trail entries so the stroke is continuous rather
// than a row of separate blobs — fast typing reads as one unbroken
// streak that drains away over u_life seconds.
//
// Coverage combines with max(), not +=: overlapping capsules must not
// accumulate, or the joins would read brighter than the run and the
// "filled" bar would look lumpy. The glow rides the bar's own half-
// height so a 1px setting really is a 1px line — a fixed-width halo
// made every thin setting render several px tall.
const FRAG_UNDERLINE = COMMON + `
void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  float halfH = max(u_lineH * 0.5 * u_px, 0.5 * u_px);
  float edge = 0.5 * u_px;
  float acc = 0.0;
  for (int i = 0; i < ${TRAIL}; i++) {
    vec4 a = u_trail[i];
    if (a.z < 0.0) continue;
    float age = u_time - a.z;
    if (age < 0.0 || age > u_life) continue;
    float fade = 1.0 - age / u_life;
    fade *= fade;
    // The 0.30 of caret height puts the bar's top edge at the glyph
    // bottom; u_offsetY is the user's nudge from there, in CSS px, so
    // the resting placement still tracks the font size.
    vec2 pa = vec2(a.x, a.y + u_caretH * 0.30 + u_offsetY * u_px);
    if (abs(frag.y - pa.y) > halfH * 5.0 + 2.0 * u_px) continue;
    vec2 pb = pa;
    // The trail arrives oldest-first, so entry i+1 is the next position
    // the caret took. Join them into one capsule when they share a
    // baseline and sit close together; the distance guard is what stops
    // a click across the document from drawing a bar spanning the jump.
    // Gapping on *time* instead was tried and reads badly — it breaks
    // the bar into dots the moment someone types at a human pace.
    if (i + 1 < ${TRAIL}) {
      vec4 b = u_trail[i + 1];
      if (b.z >= 0.0
          && abs(b.y - a.y) < u_caretH * 0.6
          && abs(b.x - a.x) < 160.0 * u_px
          && (b.z - a.z) < 2.0) {
        pb = vec2(b.x, b.y + u_caretH * 0.30 + u_offsetY * u_px);
      }
    }
    // Both endpoints sit on the same baseline, so the capsule is always
    // horizontal — build it from the x extent and stretch each end by a
    // few px so a lone entry reads as a short dash under its character
    // rather than a dot.
    float ext = 4.0 * u_px;
    vec2 p0 = vec2(min(pa.x, pb.x) - ext, pa.y);
    vec2 p1 = vec2(max(pa.x, pb.x) + ext, pa.y);
    vec2 pf = frag - p0;
    vec2 ba = p1 - p0;
    float h = clamp(dot(pf, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
    float d = length(pf - ba * h);
    float core = 1.0 - smoothstep(halfH - edge, halfH + edge, d);
    float glowR = halfH * 1.6;
    float glow = exp(-(d * d) / max(glowR * glowR * 2.0, 1e-4)) * 0.22;
    acc = max(acc, (core + glow) * fade);
  }
  outColor = vec4(u_color, clamp(acc, 0.0, 1.0) * 0.9);
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
  outColor = vec4(u_color, clamp(band * flicker * scan * 0.35, 0.0, 0.6));
}`;

const FRAGS = {
  sparks: FRAG_SPARKS,
  underline: FRAG_UNDERLINE,
  flicker: FRAG_FLICKER,
};
// Underline's entry is the fallback for its user-set trail length.
// Keep each entry in step with the age cutoff its shader hardcodes —
// this is what decides when a trail preset may park, so a lifetime
// longer than the shader's leaves an idle loop running over an empty
// canvas, and a shorter one wipes the tail mid-fade.
const LIFETIMES = { sparks: 0.75, underline: 3.5, flicker: 3.0 };
export const UNDERLINE_DEFAULTS = { height: 3, trailSeconds: 3.5, offsetY: 0 };
export const SPARK_DEFAULTS = { height: 12 };
// clear: fade out, wipe, park. run: never trail-park — animate while a
// caret exists and the window is visible.
const PARK_MODES = { sparks: "clear", underline: "clear", flicker: "run" };

/**
 * Mount a caret-effect canvas into `host`. `cfg` is `{ preset, color, … }`;
 * `caretSource.get()` yields the caret in viewport px. Returns
 * `{ update, resize, setVisible, dispose }` — `update` can swap presets
 * in place (relinks the program, keeps the canvas).
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

  let preset = resolveCaretPreset(cfg.preset);
  let color = hexToVec3(cfg.color || "#9ecbff");
  let lineH = num(cfg.height, UNDERLINE_DEFAULTS.height);
  let sparkH = num(cfg.sparkHeight, SPARK_DEFAULTS.height);
  let offsetY = num(cfg.offsetY, UNDERLINE_DEFAULTS.offsetY);
  let antialias = cfg.antialias !== false;   // absent = on
  let life = presetLife(preset, cfg);

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
      caret: gl.getUniformLocation(program, "u_caret"),
      caretH: gl.getUniformLocation(program, "u_caretH"),
      lineH: gl.getUniformLocation(program, "u_lineH"),
      life: gl.getUniformLocation(program, "u_life"),
      sparkH: gl.getUniformLocation(program, "u_sparkH"),
      offsetY: gl.getUniformLocation(program, "u_offsetY"),
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
  // The uploaded copy, compacted and sorted oldest-first. The underline
  // shader joins entry i to entry i+1, which only means "the next place
  // the caret went" once the ring buffer's wraparound is unwound.
  const trailSorted = new Float32Array(TRAIL * 4).fill(-1);
  const sortIdx = [];
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

  const lastCaret = { bx: 0, by: 0, bh: 22, valid: false };

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

  function trackCaret() {
    const c = caretSource.get();
    if (c && c.valid) {
      lastCaret.bx = (c.x - rect.left) * pxScale;
      lastCaret.by = (c.y - rect.top) * pxScale;
      lastCaret.bh = (c.h || 22) * pxScale;
      lastCaret.valid = true;
    }
  }

  function anyAlive() {
    const t = now();
    for (let i = 0; i < TRAIL; i++) {
      const birth = trail[i * 4 + 2];
      if (birth >= 0 && t - birth < life) return true;
    }
    return false;
  }

  /** Compact + sort the ring into `trailSorted`, oldest first. */
  function buildSortedTrail() {
    sortIdx.length = 0;
    for (let i = 0; i < TRAIL; i++) if (trail[i * 4 + 2] >= 0) sortIdx.push(i);
    sortIdx.sort((a, b) => trail[a * 4 + 2] - trail[b * 4 + 2]);
    trailSorted.fill(-1);
    for (let n = 0; n < sortIdx.length; n++) {
      const src = sortIdx[n] * 4;
      const dst = n * 4;
      trailSorted[dst] = trail[src];
      trailSorted[dst + 1] = trail[src + 1];
      trailSorted[dst + 2] = trail[src + 2];
      trailSorted[dst + 3] = trail[src + 3];
    }
  }

  let rafId = 0;
  let wakeTimer = 0;
  let visible = true;

  function renderFrame() {
    gl.useProgram(program);
    buildSortedTrail();
    gl.uniform2f(uni.res, canvas.width, canvas.height);
    gl.uniform1f(uni.time, now());
    gl.uniform1f(uni.px, pxScale);
    gl.uniform4fv(uni.trail, trailSorted);
    gl.uniform3f(uni.color, color[0], color[1], color[2]);
    gl.uniform1f(uni.lineH, lineH);
    gl.uniform1f(uni.life, life);
    gl.uniform1f(uni.sparkH, sparkH);
    gl.uniform1f(uni.offsetY, offsetY);
    gl.uniform2f(uni.caret, lastCaret.bx, lastCaret.by);
    gl.uniform1f(uni.caretH, lastCaret.bh);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function draw() {
    rafId = 0;
    if (!visible || !program) return;
    pushIfMoved();
    trackCaret();
    const mode = PARK_MODES[preset] || "clear";
    const alive = mode === "run" ? lastCaret.valid : anyAlive();
    if (!alive) { park(); return; }
    renderFrame();
    rafId = requestAnimationFrame(draw);
  }

  // Idle: stop drawing and poll the caret at 4 Hz for a wake-up instead
  // of burning rAF frames.
  function park() {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
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
    if (!rafId) rafId = requestAnimationFrame(draw);
  }

  // Kept so a mid-session antialias toggle can re-size without waiting
  // for the next window resize.
  let lastW = ctx.width, lastH = ctx.height, lastDpr = ctx.dpr;
  function resize(width, height, dpr) {
    lastW = width; lastH = height; lastDpr = dpr;
    sizeCanvas(canvas, gl, width, height, dpr, antialias);
    // Backing px per CSS px — every shader size is written in CSS px and
    // scaled by this, so supersampling changes sharpness, not geometry.
    pxScale = width > 0 ? canvas.width / width : 1;
    rect = canvas.getBoundingClientRect();
  }
  resize(ctx.width, ctx.height, ctx.dpr);
  unpark();

  return {
    update(nextCfg) {
      const nextPreset = resolveCaretPreset(nextCfg.preset);
      color = hexToVec3(nextCfg.color || "#9ecbff");
      lineH = num(nextCfg.height, UNDERLINE_DEFAULTS.height);
      sparkH = num(nextCfg.sparkHeight, SPARK_DEFAULTS.height);
      offsetY = num(nextCfg.offsetY, UNDERLINE_DEFAULTS.offsetY);
      const nextAA = nextCfg.antialias !== false;
      if (nextAA !== antialias) {
        antialias = nextAA;
        resize(lastW, lastH, lastDpr);
      }
      life = presetLife(nextPreset, nextCfg);
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
