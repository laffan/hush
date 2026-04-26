/* ============================================================
 * HUSH FORK DELTA LOG (vs. temp-drawing-demo reference):
 *   1a. createAtlasCache({ brushUrl }) — optional resolver.
 *       Default preserved (`brushes/${id}.png`).
 *   1b. loadPngBrushes skips the fetch when resolveBrushUrl(id)
 *       returns a falsy value, so brushes with no PNG (e.g. the
 *       highlighter's procedural flat fallback) don't fire a 404.
 * ============================================================
 *
 * stroke-atlas.js (stamped) — brush atlas cache.
 *
 * A brush atlas is a 512×128 bitmap containing 4 variants (128×128 cells)
 * of the same tip. At stamp time the renderer picks a variant index and does
 * one drawImage with a source rect — plus a stable per-stamp rotation. The
 * atlas is alpha-masked; per-color tinted copies are built lazily via
 * source-in compositing with a solid fill.
 *
 * PNG atlases loaded from brushes/brush-N.png override the procedural
 * fallback, which is a plain soft-round tip (duplicated across 4 cells) used
 * only when the PNG is missing/late.
 * ============================================================ */

export const ATLAS_CELL = 128;
export const ATLAS_VARIANTS = 4;
export const ATLAS_WIDTH = ATLAS_CELL * ATLAS_VARIANTS;

// Fixed set of brush slots. The engine loads brushes/<id>.png for each at
// init; if the PNG is absent the procedural fallback is used.
//
// A brush def is purely about tip appearance (atlas PNG + fallback shape).
// Stroke composite behaviour lives in STROKE_MODES below, not here — any
// brush can be used in any mode.
//
// fallbackShape — 'round' (soft radial gradient, default) or 'flat'
//                (near-uniform alpha disc with a thin feather, reads like a
//                chisel-tip marker). Used only until the PNG decodes.
export const BRUSH_DEFS = [
  { id: 'brush-1', name: 'Brush 1' },
  { id: 'brush-2', name: 'Brush 2' },
  { id: 'brush-3', name: 'Brush 3' },
  { id: 'brush-4', name: 'Brush 4' },
  { id: 'brush-5', name: 'Brush 5' },
  { id: 'brush-highlighter', name: 'Highlighter', fallbackShape: 'flat' },
];

export function getBrushDef(brushId) {
  return BRUSH_DEFS.find((b) => b.id === brushId) || BRUSH_DEFS[0];
}

// Per-stroke rendering modes. A stroke carries its own `mode` string; the
// renderer dispatches on it. 'normal' (the default) keeps the direct-stamp
// hot path, which is pixel-identical to the pre-mode behaviour. Anything
// else opts into the flatten path in stroke-render.js (stamp into scratch
// at full opacity, then blit with composite + strokeAlpha so overlapping
// stamps within the same stroke do not accumulate density).
export const STROKE_MODES = {
  normal:      { composite: 'source-over', strokeAlpha: 1 },
  highlighter: { composite: 'multiply',    strokeAlpha: 0.5 },
};

export function getModeComposite(mode) {
  return STROKE_MODES[mode] || STROKE_MODES.normal;
}

// Build a single-cell alpha mask. Used only as the fallback before a
// brush's PNG decodes. Returns a 128×128 canvas whose alpha channel is the
// mask. Shape is either 'round' (soft radial falloff, matches the original
// fallback) or 'flat' (near-uniform disc with a thin feather — matches a
// chisel-tip marker at low magnification).
function makeFallbackCell(shape) {
  const c = document.createElement('canvas');
  c.width = c.height = ATLAS_CELL;
  const ctx = c.getContext('2d');
  const R = ATLAS_CELL / 2;
  const grad = ctx.createRadialGradient(R, R, 0, R, R, R);
  if (shape === 'flat') {
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.92, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
  } else {
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.55, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, ATLAS_CELL, ATLAS_CELL);
  return c;
}

// 512×128 alpha mask: fallback cell duplicated across all four variant slots.
function makeFallbackAtlasMask(shape) {
  const c = document.createElement('canvas');
  c.width = ATLAS_WIDTH;
  c.height = ATLAS_CELL;
  const ctx = c.getContext('2d');
  const cell = makeFallbackCell(shape);
  for (let i = 0; i < ATLAS_VARIANTS; i++) {
    ctx.drawImage(cell, i * ATLAS_CELL, 0);
  }
  return c;
}

// Given an alpha-mask atlas, produce a solid-color tinted copy by filling
// with the target color under source-in composition. Fast: one drawImage +
// one fillRect, O(atlas pixels).
function tintAtlasMask(mask, color) {
  const c = document.createElement('canvas');
  c.width = mask.width;
  c.height = mask.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(mask, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

// Async-load a PNG atlas. Returns a canvas sized to the image, or null if
// the load failed (file missing, decode error, etc.). The image is drawn
// into a canvas so subsequent drawImage calls don't pay decode cost again.
async function loadBrushAtlasPng(url) {
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  } catch {
    return null;
  }
}

// atlasMasks: brushId → { mask, fromPng, cell, variants } — cell+variants
//   may be overridden by the loaded PNG (defaults to ATLAS_CELL/ATLAS_VARIANTS).
// tintAtlasCache: brushId|color → canvas (tinted atlas).
export function createAtlasCache({ onAtlasReady, brushUrl } = {}) {
  const atlasMasks = new Map();
  const tintAtlasCache = new Map();
  // Hush delta #1a: optional `brushUrl` resolver lets the caller supply
  // bundler-resolved URLs (Vite ?url imports). Reference default unchanged.
  const resolveBrushUrl = brushUrl || ((id) => `brushes/${id}.png`);

  function ensureAtlasMask(brushId) {
    let entry = atlasMasks.get(brushId);
    if (entry) return entry;
    // Build the procedural fallback on demand. PNG-backed entries overwrite
    // this when they finish decoding. Shape picks the cell look: the
    // highlighter reads right even without a PNG thanks to the flat fallback.
    const def = getBrushDef(brushId);
    entry = {
      mask: makeFallbackAtlasMask(def.fallbackShape),
      fromPng: false,
      cell: ATLAS_CELL,
      variants: ATLAS_VARIANTS,
    };
    atlasMasks.set(brushId, entry);
    return entry;
  }

  function getTintedAtlas(brushId, color) {
    const entry = ensureAtlasMask(brushId);
    const key = `${brushId}|${color}`;
    let tinted = tintAtlasCache.get(key);
    if (!tinted) {
      tinted = tintAtlasMask(entry.mask, color);
      tintAtlasCache.set(key, tinted);
    }
    return { atlas: tinted, cell: entry.cell, variants: entry.variants };
  }

  // Async-load PNG atlases for each brush slot in the background. When a
  // PNG lands, swap the entry in, drop prior tints, and notify via
  // onAtlasReady so the caller can decide whether to repaint.
  async function loadPngBrushes() {
    await Promise.all(BRUSH_DEFS.map(async (def) => {
      const url = resolveBrushUrl(def.id);
      // Hush delta #1b: a null/empty url signals "no PNG for this brush"
      // — the procedural fallback already handled it via ensureAtlasMask,
      // so skip cleanly without firing a network request that would show
      // up as a 404.
      if (!url) return;
      const canvas = await loadBrushAtlasPng(url);
      if (!canvas) return;
      const cell = canvas.height;
      const variants = Math.max(1, Math.floor(canvas.width / cell));
      atlasMasks.set(def.id, { mask: canvas, fromPng: true, cell, variants });
      for (const k of [...tintAtlasCache.keys()]) {
        if (k.startsWith(`${def.id}|`)) tintAtlasCache.delete(k);
      }
      if (onAtlasReady) onAtlasReady(def.id);
    }));
  }

  return { ensureAtlasMask, getTintedAtlas, loadPngBrushes };
}
