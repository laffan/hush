/**
 * Gradient background layer — a freeform multi-node mesh gradient. The
 * user places colour nodes on a 2D field (the modal's pad editor); the
 * fragment shader blends them with inverse-distance weighting, which
 * gives the smooth "each node owns its neighbourhood" look without any
 * mesh topology to manage.
 *
 * `animate: true` orbits every node around its base position in a slow
 * small circle (per-node phase from its index, so they don't move in
 * lockstep). Static gradients render exactly once per config / resize —
 * no rAF loop unless animating and visible.
 *
 * No-WebGL2 fallback: stacked CSS radial-gradients — visually coarser
 * but never blank.
 */
import { linkProgram, setupQuad, QUAD_VERT, hexToVec3, sizeCanvas } from "./webgl-utils.js";
import { defaultGradientNodes } from "./effects-registry.js";

const MAX_NODES = 8;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform vec2  u_resolution;
uniform float u_time;
uniform float u_animate;
uniform int   u_count;
uniform vec2  u_pos[${MAX_NODES}];
uniform vec3  u_colors[${MAX_NODES}];

void main() {
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec3 col = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < ${MAX_NODES}; i++) {
    if (i >= u_count) break;
    float phase = float(i) * 2.4;
    vec2 orbit = u_animate * 0.045 * vec2(cos(u_time * 0.35 + phase), sin(u_time * 0.28 + phase));
    vec2 p = u_pos[i] + orbit;
    vec2 d = (v_uv - p) * vec2(aspect, 1.0);
    float w = 1.0 / (pow(length(d), 3.0) + 0.002);
    col += u_colors[i] * w;
    wsum += w;
  }
  outColor = vec4(col / max(wsum, 1e-6), 1.0);
}`;

const DEFAULT_NODES = defaultGradientNodes();

function resolveOpacity(cfg, appearance) {
  const isDark = appearance === "dark";
  const v = isDark ? cfg.darkOpacity : cfg.lightOpacity;
  return v != null ? v : 1;
}

function cssFallback(el, nodes) {
  const grads = (nodes || []).map(n =>
    `radial-gradient(circle at ${Math.round(n.x * 100)}% ${Math.round(n.y * 100)}%, ${n.color} 0%, transparent 62%)`
  );
  el.style.background = grads.join(", ");
}

export function mountGradientLayer(host, cfg, appearance, ctx) {
  const canvas = document.createElement("canvas");
  canvas.className = "bg-layer bg-layer-gradient";
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
  host.appendChild(canvas);

  const gl = canvas.getContext("webgl2", {
    alpha: true, premultipliedAlpha: false, antialias: false,
    depth: false, stencil: false, powerPreference: "low-power",
  });

  let nodes = (cfg.nodes && cfg.nodes.length ? cfg.nodes : DEFAULT_NODES).slice(0, MAX_NODES);
  let animate = !!cfg.animate;
  let visible = true;
  let rafId = 0;
  const epoch = performance.now();

  function applyChrome(c, app) {
    canvas.style.mixBlendMode = c.blend || "normal";
    canvas.style.opacity = String(resolveOpacity(c, app));
  }
  applyChrome(cfg, appearance);

  if (!gl) {
    // Fallback element reuses the canvas node as a plain painted div —
    // background shorthand works on canvas elements too.
    cssFallback(canvas, nodes);
    return {
      update(nextCfg, nextAppearance) {
        nodes = (nextCfg.nodes && nextCfg.nodes.length ? nextCfg.nodes : DEFAULT_NODES).slice(0, MAX_NODES);
        applyChrome(nextCfg, nextAppearance);
        cssFallback(canvas, nodes);
      },
      setVisible() {},
      dispose() { canvas.remove(); },
    };
  }

  const program = linkProgram(gl, QUAD_VERT, FRAG);
  if (!program) {
    cssFallback(canvas, nodes);
    return { update() {}, setVisible() {}, dispose() { canvas.remove(); } };
  }
  gl.useProgram(program);
  setupQuad(gl, program);
  const uni = {
    res: gl.getUniformLocation(program, "u_resolution"),
    time: gl.getUniformLocation(program, "u_time"),
    animate: gl.getUniformLocation(program, "u_animate"),
    count: gl.getUniformLocation(program, "u_count"),
    pos: gl.getUniformLocation(program, "u_pos"),
    colors: gl.getUniformLocation(program, "u_colors"),
  };

  const posArr = new Float32Array(MAX_NODES * 2);
  const colArr = new Float32Array(MAX_NODES * 3);
  function pushNodeUniforms() {
    for (let i = 0; i < nodes.length; i++) {
      posArr[i * 2] = nodes[i].x;
      // Node coords are stored y-down (matching the pad editor and the
      // editor surface); v_uv is y-up.
      posArr[i * 2 + 1] = 1 - nodes[i].y;
      const c = hexToVec3(nodes[i].color);
      colArr[i * 3] = c[0]; colArr[i * 3 + 1] = c[1]; colArr[i * 3 + 2] = c[2];
    }
    gl.uniform1i(uni.count, nodes.length);
    gl.uniform2fv(uni.pos, posArr);
    gl.uniform3fv(uni.colors, colArr);
  }

  function drawFrame() {
    gl.uniform2f(uni.res, canvas.width, canvas.height);
    gl.uniform1f(uni.time, (performance.now() - epoch) / 1000);
    gl.uniform1f(uni.animate, animate ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function loop() {
    rafId = 0;
    if (!visible || !animate) return;
    drawFrame();
    rafId = requestAnimationFrame(loop);
  }
  function sync() {
    pushNodeUniforms();
    if (animate && visible) {
      if (!rafId) rafId = requestAnimationFrame(loop);
    } else {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      drawFrame();
    }
  }

  function resize(width, height, dpr) {
    sizeCanvas(canvas, gl, width, height, dpr);
    drawFrame();
  }
  resize(ctx.width, ctx.height, ctx.dpr);
  sync();

  return {
    update(nextCfg, nextAppearance) {
      nodes = (nextCfg.nodes && nextCfg.nodes.length ? nextCfg.nodes : DEFAULT_NODES).slice(0, MAX_NODES);
      animate = !!nextCfg.animate;
      applyChrome(nextCfg, nextAppearance);
      sync();
    },
    resize,
    setVisible(v) {
      visible = v;
      if (v) sync();
      else if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    },
    dispose() {
      if (rafId) cancelAnimationFrame(rafId);
      try {
        const lose = gl.getExtension("WEBGL_lose_context");
        lose && lose.loseContext();
      } catch (_) {}
      try { canvas.remove(); } catch (_) {}
    },
  };
}
