/**
 * Edge Lights — the fragment shader, both skies in one program (the
 * `u_kind` branch is uniform across the frame, so it costs nothing).
 *
 * Both work per pixel from two things: its distance to the nearest
 * window edge, and its angle about the centre taken as a point on the
 * unit circle (so the shapes have no seam where `atan` wraps). Along
 * that circle, two slow lobe fields set how far each stretch of edge
 * reaches in — from about a tenth of the depth to well past it — so the
 * light gathers in places rather than framing the window, and each lobe
 * breathes on its own phase.
 *
 *   Polar (0)  curtains: fine bands running out from the edge, drifting
 *              along it and flowing inward.
 *   Scuba (1)  the same light seen from under water — no curtains, but
 *              a slow swell bending everything (the edges included), the
 *              moving net of caustic lines a rippling surface throws (two
 *              wandering cell patterns, borders lit), and soft rings
 *              rolling in from the edge.
 *   Thrum (2)  no lines at all: slow, irregular patches of soft
 *              gradient. A noise field warped through two other noise
 *              fields (each drifting on its own) gives shapes that fold
 *              and pool rather than drift past; it decides both how far
 *              in the light reaches and which colours it is, so each
 *              patch is a gradient of its own, and it swells and ebbs
 *              on a slow throb.
 *   Thrum Dark (3)  Thrum's shapes as ink rather than light: solid at
 *              the edge — a black palette is black, not a grey wash —
 *              with opacity setting how much of the band is solid, and
 *              laid over the page unblended (edge-lights-overlay.js).
 *
 * Colour: all but the palette's last colour are spread along the edge by
 * a slow noise field; the last is what the far reach fades into. With
 * three colours this is exactly the original two-along, one-at-the-reach
 * mix. Output is premultiplied.
 *
 * Fill (`u_fill`) decides what the shape is filled with, once each kind
 * has worked out how strongly a pixel belongs to it: the colour above
 * (0); the strength alone, in white, as a mask the blur layer
 * reads (1 — edge-lights-blur.js); particles in the palette's
 * colours (2) — Hyperspace's streaks running out from the middle of the
 * window, or Snow's flakes drifting down in three depths (`u_anim`),
 * sized by `u_psize`; or Blur's own surface (3), a faint frost drawn
 * over what the blur layer blurs so the shape shows even over a plain
 * page, where there is nothing to blur. Opacity scales every fill
 * down to nothing at 0.
 */

export const MAX_SHADER_COLORS = 6;

export const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2  u_res;
uniform float u_time;     // seconds, already scaled by the speed option
uniform float u_depth;    // reach, in canvas px
uniform float u_opacity;
uniform float u_sat;
uniform float u_fade;
uniform int   u_kind;     // 0 polar, 1 scuba, 2 thrum, 3 thrum dark
uniform int   u_count;    // colours in use, 2..${MAX_SHADER_COLORS}
uniform vec3  u_colors[${MAX_SHADER_COLORS}];
uniform int   u_fill;     // 0 colours, 1 blur's outer mask, 2 animation, 3 frost, 4 blur's core mask
uniform int   u_anim;     // 0 hyperspace, 1 snow
uniform float u_psize;    // particle size, a multiple of the first
uniform int   u_dark;     // 1 on a dark page

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

// One octave, 0..1: the broad, smooth shapes Thrum is made of.
float soft(vec2 p) { return 0.5 + 0.5 * snoise(p); }

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
// Water caustics: a cell pattern whose points wander on their own
// clocks; light gathers along the borders between cells (where the
// nearest and second-nearest points are equally far), which is the net
// of bright lines a rippling surface throws. 1 on a border, 0 inside.
float caustics(vec2 p, float t) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 h = hash2(cell + g);
      vec2 o = 0.5 + 0.42 * sin(t * (0.6 + 0.5 * h) + 6.2831 * h);
      float dd = length(g + o - f);
      if (dd < d1) { d2 = d1; d1 = dd; } else if (dd < d2) { d2 = dd; }
    }
  }
  return 1.0 - smoothstep(0.0, 0.22, d2 - d1);
}

vec3 paletteColor(float m, float x) {
  int n = u_count;
  float span = float(max(n - 2, 0));
  float f = min(clamp((m - 0.3) / 0.4, 0.0, 1.0) * span, max(span - 0.0001, 0.0));
  int i = int(floor(f));
  vec3 col = mix(u_colors[i], u_colors[min(i + 1, max(n - 2, 0))], smoothstep(0.0, 1.0, fract(f)));
  col = mix(col, u_colors[n - 1], smoothstep(0.1, 0.75, x));
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  return clamp(mix(vec3(lum), col, u_sat), 0.0, 1.0);
}

float edgeDistance(vec2 p) {
  return min(min(p.x, u_res.x - p.x), min(p.y, u_res.y - p.y));
}

// The edge distance with the corners rounded off (a soft minimum of the
// four), so a patch turning a corner bends round it instead of meeting
// itself along the diagonal.
float roundedEdgeDistance(vec2 p, float k) {
  float e = exp(-p.x / k) + exp(-(u_res.x - p.x) / k) + exp(-p.y / k) + exp(-(u_res.y - p.y) / k);
  return max(-k * log(e), 0.0);
}

// Snow: one depth of flakes — a sparse grid of soft dots, each cell's
// flake at its own place, the whole layer falling and swaying.
float snowLayer(vec2 uv, float scale, float speed, float t, out float id) {
  vec2 p = uv * scale + vec2(sin(t * 0.21 + uv.y * 3.0) * 0.35, t * speed);
  vec2 cell = floor(p);
  vec2 h = hash2(cell + scale);
  id = h.y;
  vec2 o = 0.5 + (h - 0.5) * 0.7;
  float r = min((0.07 + 0.07 * h.x) * u_psize, 0.3);
  float d = length(fract(p) - o);
  return smoothstep(r, r * 0.25, d) * step(0.45, h.x);
}

// Hyperspace: thin streaks, one per narrow wedge round the middle of the
// window, each running outward on its own clock and lengthening as it
// goes, as stars do past a ship at speed.
float warpLayer(vec2 q, float wedges, float seed, float t, out float id) {
  float r = length(q);
  float a = (atan(q.y, q.x) / 6.2831853 + 0.5) * wedges;
  float wedge = floor(a);
  vec2 h = hash2(vec2(wedge, seed));
  id = h.x;
  float head = fract(h.y + t * (0.12 + 0.25 * h.x)) * 1.4;
  float len = (0.04 + 0.22 * head * head) * u_psize;
  float along = smoothstep(head - len, head, r) * (1.0 - smoothstep(head, head + 0.01, r));
  float across = 1.0 - smoothstep(0.06 * u_psize, min(0.32 * u_psize, 0.5), abs(fract(a) - 0.5));
  return along * across * smoothstep(0.05, 0.25, head) * step(0.3, h.x);
}

// The particles at this pixel, 0..1, and which palette colour they are.
float particles(vec2 px, float t, out float id) {
  float s = min(u_res.x, u_res.y);
  float best = 0.0;
  float i0, i1, i2;
  if (u_anim == 1) {
    vec2 uv = px / s;
    float a = snowLayer(uv, 26.0, 0.9, t, i0) * 0.55;
    float b = snowLayer(uv, 15.0, 1.4, t, i1) * 0.8;
    float c = snowLayer(uv, 8.0, 2.1, t, i2);
    best = max(a, max(b, c));
    id = c >= b && c >= a ? i2 : (b >= a ? i1 : i0);
  } else {
    vec2 q = (px - 0.5 * u_res) / s;
    float a = warpLayer(q, 140.0, 1.7, t, i0);
    float b = warpLayer(q, 90.0, 5.3, t * 1.3, i1) * 0.8;
    best = max(a, b);
    id = a >= b ? i0 : i1;
  }
  return best;
}

// What the pixel becomes, given its colour and how strongly it belongs
// to the shape (already scaled by opacity and the fade).
vec4 fillOut(vec3 col, float a, vec2 px, float t) {
  // How fully the pixel is in the shape, before opacity; opacity then
  // scales the fill straight down to nothing.
  float k = u_opacity * u_fade;
  float g = k > 0.0 ? clamp(a / k, 0.0, 1.0) : 0.0;
  // Blur's masks (edge-lights-blur.js): how far into the shape a pixel
  // is, made mostly solid so the blur reads as a blur rather than the
  // page faded over a blurred copy — the outer band (1) under a light
  // blur, the core (4) under the full one. Opacity is the blur's radius,
  // not the mask's.
  if (u_fill == 1) { float m = smoothstep(0.02, 0.3, g) * u_fade; return vec4(m); }
  if (u_fill == 4) { float m = smoothstep(0.3, 0.65, g) * u_fade; return vec4(m); }
  if (u_fill == 2) {
    float id;
    float p = particles(px, t, id);
    vec3 pc = paletteColor(0.3 + 0.4 * id, 0.0);
    float pa = clamp(p, 0.0, 1.0) * clamp(g * 3.0, 0.0, 1.0) * k;
    return vec4(pc * pa, pa);
  }
  if (u_fill == 3) {
    // Frost: a hint of haze, light on dark and grey on light — enough to
    // show the shape over a blank page, too little to fog the blur.
    float v = (u_dark == 1 ? 0.08 : 0.05) * g * k;
    vec3 c = u_dark == 1 ? vec3(1.0) : vec3(0.5);
    return vec4(c * v, v);
  }
  return vec4(col * a, a);
}

void main() {
  vec2 px = gl_FragCoord.xy;
  float t = u_time;
  bool scuba = u_kind == 1;
  bool thrum = u_kind == 2 || u_kind == 3;
  // Past the furthest any lobe (or the water's bend) can reach: nothing.
  // Thrum's reach is 1.6 depths and fades out to 1.1 of that, measured
  // on rounded corners, which can read up to 0.42 depths nearer the
  // edge than the plain distance (k·ln 4 at k = 0.3 depth): 2.2 covers it.
  float bound = thrum ? 2.2 : (scuba ? 1.85 : 1.6);
  if (edgeDistance(px) > u_depth * bound) { outColor = vec4(0.0); return; }

  float s = min(u_res.x, u_res.y);
  vec2 uv = px / s;

  // Under water the whole view sways: everything below is read at a
  // point the swell has bent.
  vec2 warp = vec2(0.0);
  if (scuba) {
    warp = vec2(snoise(uv * 2.6 + vec2(t * 0.11, t * 0.07)),
                snoise(uv * 2.6 + vec2(-t * 0.08, t * 0.1) + 7.0));
    px += warp * u_depth * 0.16;
  }
  float d = max(edgeDistance(px), 0.0);

  if (thrum) {
    // Large single-octave shapes, bent gently by two others drifting on
    // their own: broad patches that fold into one another rather than
    // slide past, with no fine detail to catch the eye.
    vec2 w = vec2(soft(uv * 0.7 + vec2(t * 0.02, 0.0)),
                  soft(uv * 0.7 + vec2(5.2, 1.3) - t * 0.016));
    float field = soft(uv * 0.85 + 1.2 * w + vec2(1.7, 9.2) + t * 0.01);
    float reachT = u_depth * (0.3 + 1.3 * smoothstep(0.25, 0.85, field));
    float xt = roundedEdgeDistance(px, max(u_depth * 0.3, 1.0)) / max(reachT, 1.0);
    float throb = 0.72 + 0.28 * sin(t * 0.35 + field * 5.0 + w.x * 3.0);
    float glowT = smoothstep(1.1, 0.0, xt) * throb;
    // Colour from a field of its own, so neighbouring patches differ,
    // spread over the palette's whole width so many colours don't band.
    float hue = soft(uv * 0.9 + 0.9 * w + vec2(3.1, 7.7) - t * 0.012);
    vec3 colT = paletteColor(0.3 + 0.4 * hue, xt);
    float aT = clamp(glowT, 0.0, 1.0) * u_opacity * u_fade;
    if (u_kind == 3) {
      // Thrum Dark is ink, not light: it reaches full strength. The
      // throb moves the reach in and out instead of dimming the patch,
      // and opacity sets how much of the band is solid — the colour
      // itself at the edge, easing off towards the reach.
      // A straight ramp over a slightly longer reach than Thrum's, so the
      // fade into the page stays as long as the solid part, or longer.
      float sd = clamp(1.0 - xt * (1.15 - 0.15 * throb) / 1.3, 0.0, 1.0);
      // Below 20% opacity the ink itself thins, down to none at 0.
      aT = clamp(sd * sd * (3.0 - 2.0 * sd) * (1.0 + 1.5 * u_opacity), 0.0, 1.0) * u_fade
         * clamp(u_opacity * 5.0, 0.0, 1.0);
    }
    outColor = fillOut(colT, aT, px, t);
    return;
  }

  vec2 q = (px - 0.5 * u_res) / s;
  float ang = atan(q.y, q.x);
  vec2 ring = vec2(cos(ang), sin(ang));

  // How far in this stretch of edge reaches — slow lobes drifting round
  // the frame, from almost nothing to well past the depth, so the light
  // gathers in places rather than lining the window like a frame.
  float lobe  = fbm(ring * 1.4 + vec2(t * 0.03, -t * 0.022));
  float lobe2 = fbm(ring * 2.6 + vec2(-t * 0.045, t * 0.035) + 11.0);
  float gather = smoothstep(0.3, 0.75, lobe) * (0.55 + 0.6 * lobe2);
  float reach = u_depth * (0.12 + 1.35 * gather);
  float x = d / max(reach, 1.0);

  // Each lobe breathes on a phase of its own; the whole sky slower still.
  float pulse = (0.78 + 0.22 * sin(t * 0.5 + lobe * 9.0)) * (0.9 + 0.1 * sin(t * 0.19));

  float glow;
  if (!scuba) {
    // The curtains: fine bands running out from the edge, drifting along
    // it and flowing inward.
    float rays = fbm(ring * 9.0 + vec2(t * 0.06, x * 1.6 - t * 0.18));
    float curtain = 0.25 + 1.2 * smoothstep(0.25, 0.85, rays);
    glow = pow(clamp(1.0 - x, 0.0, 1.0), 1.8) * curtain * pulse;
  } else {
    // Caustics: two cell nets at different sizes, drifting apart and
    // bent by the swell, so the lines wobble and cross like light on a
    // pool floor.
    vec2 cp = uv * 6.0 + warp * 0.45;
    float caustic = caustics(cp + vec2(t * 0.05, -t * 0.03), t * 0.9) * 0.65
                  + caustics(cp * 1.7 + vec2(-t * 0.04, t * 0.05) + 9.0, t * 1.15) * 0.45;
    // Soft rings of brighter water rolling in from the edge.
    float swell = 0.72 + 0.28 * sin(x * 7.0 - t * 1.1 + lobe * 6.0);
    glow = pow(clamp(1.0 - x, 0.0, 1.0), 1.5) * (0.45 + 1.25 * caustic) * swell * pulse;
  }
  // A soft seam right at the edge where the light gathers, as if it
  // came from just beyond the window.
  glow += 0.3 * gather * exp(-d / max(u_depth * 0.06, 1.0)) * pulse;

  float m = fbm(ring * 1.1 + vec2(t * 0.018, t * 0.013) + 3.0);
  vec3 col = paletteColor(m, x);

  float a = clamp(glow, 0.0, 1.0) * u_opacity * u_fade;
  outColor = fillOut(col, a, px, t);
}`;
