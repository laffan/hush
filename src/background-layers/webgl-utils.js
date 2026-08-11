/**
 * Tiny WebGL2 helpers shared by the background-layer renderers (gradient
 * layer, caret effects). Mirrors the helpers that live inside
 * shader-layer/layers/webgl-neon-bloom.js — kept separate so that layer
 * module stays self-contained and lazily loadable on its own.
 */

export function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn("background-layer shader compile error", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function linkProgram(gl, vsrc, fsrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsrc);
  if (!vs || !fs) return null;
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.warn("background-layer program link error", gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

/** Standard fullscreen-triangle-pair quad + a_pos attribute setup. */
export function setupQuad(gl, program) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1,  -1, 1,
    -1,  1,  1, -1,   1, 1,
  ]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  return buf;
}

export const QUAD_VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/** Normalize any CSS colour string to `#rrggbb`. Canvas 2D's fillStyle
 *  setter does the parsing — assigning an unparseable value leaves the
 *  previous one in place, which is why the black seed doubles as the
 *  fallback. Used for colours that don't come from a colour input (the
 *  editor's resolved `--cursor`, which can be hex, rgb(), or a keyword). */
let _colorCtx = null;
export function normalizeColor(value, fallback = "#9ecbff") {
  const v = String(value || "").trim();
  if (!v) return fallback;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (!_colorCtx) _colorCtx = document.createElement("canvas").getContext("2d");
  _colorCtx.fillStyle = "#000000";
  _colorCtx.fillStyle = v;
  const out = _colorCtx.fillStyle;
  // A rejected value leaves the seed behind; treat that as "unparseable"
  // unless the caller genuinely asked for black.
  if (out === "#000000" && !/^(#000(000)?|black|rgba?\(0,\s*0,\s*0)/i.test(v)) return fallback;
  return typeof out === "string" && out.startsWith("#") ? out : fallback;
}

export function hexToVec3(hex) {
  const h = (hex || "").replace("#", "");
  const expand = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const r = (parseInt(expand.slice(0, 2), 16) || 0) / 255;
  const g = (parseInt(expand.slice(2, 4), 16) || 0) / 255;
  const b = (parseInt(expand.slice(4, 6), 16) || 0) / 255;
  return [r, g, b];
}

export function clamp01(v) {
  if (typeof v !== "number" || Number.isNaN(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

export function num(v, fallback) {
  return (typeof v === "number" && !Number.isNaN(v)) ? v : fallback;
}

/** Size a canvas to its host, DPR-capped at 1 (these are soft decorative
 *  layers — the halved fill cost matters more than pixel crispness).
 *  Guards no-op resizes: reassigning canvas.width reallocates the
 *  backing surface even for the same value (expensive on iPad). */
export function sizeCanvas(canvas, gl, width, height, dpr) {
  const scale = Math.min(dpr || 1, 1.0);
  const w = Math.max(1, Math.floor(width * scale));
  const h = Math.max(1, Math.floor(height * scale));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  if (gl) gl.viewport(0, 0, w, h);
}
