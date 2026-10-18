/* ============================================================
 * HUSH FORK DELTA LOG (vs. temp-drawing-demo reference):
 *   1a. createAtlasCache({ brushUrl }) — optional resolver.
 *       Default preserved (`brushes/${id}.png`).
 *   1b. loadPngBrushes skips the fetch when resolveBrushUrl(id)
 *       returns a falsy value, so brushes with no PNG (e.g. the
 *       highlighter's procedural flat fallback) don't fire a 404.
 *   Hush delta #40: per-mask mip chain; getTintedAtlas picks the level
 *       that fits the stamp's device-pixel diameter.
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

// Hush delta #40: mip levels. A stamp is a 128-px cell drawn into a
// few device pixels — the default 3-px pen is 4–6 px at DPR 2 and one
// or two once the backing's DPR drops for a zoomed-out view — so every
// drawImage is a 20–150× minification, and what that looks like is up
// to the browser's image filter. Chromium mipmaps it; WebKit's canvas
// does not reliably, and point-samples a handful of texels out of the
// cell instead. For a textured tip that is the difference between the
// stroke's real body and a sparse, thinner one, and it changes with the
// backing's DPR (zoom crossings) and with which canvas of the delta-#31
// swap pair did the painting — so after zooming out and back in, ink
// re-stamped by one pass read thinner than ink painted by another. Each
// mask therefore carries a chain of box-filtered halvings, built once,
// and a stroke stamps from the smallest level whose cell still covers
// its device-pixel diameter: no draw minifies by more than ~2× at full
// pressure, which every filter handles the same way.
const MIN_MIP_CELL = 4;

// Halve an atlas repeatedly down to MIN_MIP_CELL-pixel cells. An exact
// 2× bilinear reduction averages each aligned 2×2 block, and cells sit
// on even boundaries at every level, so neighbouring variants never
// bleed into each other.
function buildMipChain(mask, cell) {
  const levels = [mask];
  let src = mask;
  let c = cell;
  while (c / 2 >= MIN_MIP_CELL && src.width % 2 === 0 && src.height % 2 === 0) {
    const next = document.createElement('canvas');
    next.width = src.width / 2;
    next.height = src.height / 2;
    const ctx = next.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, next.width, next.height);
    levels.push(next);
    src = next;
    c /= 2;
  }
  return levels;
}

/** Smallest mip level whose cell is at least `diameter` device px. */
function levelFor(entry, diameter) {
  if (!(diameter > 0)) return 0;
  const k = Math.floor(Math.log2(entry.cell / diameter));
  return Math.max(0, Math.min(entry.mips.length - 1, k));
}

// atlasMasks: brushId → { mask, mips, fromPng, cell, variants } — cell+variants
//   may be overridden by the loaded PNG (defaults to ATLAS_CELL/ATLAS_VARIANTS);
//   mips[0] is the mask itself, mips[k] has cells of cell / 2^k.
// tintAtlasCache: brushId|color|level → { canvas, bitmap? } (tinted atlas).
//
// Hush delta #30: each tinted atlas is asynchronously promoted to an
// ImageBitmap, and getTintedAtlas hands the bitmap out once it
// resolves. A canvas used as a drawImage SOURCE is mutable, so WebKit
// re-converts / re-uploads it per draw — on iPad that made the
// re-anchor's edge-strip rebake (hundreds of stamps) a ~220 ms
// commit-side stall even after the blit itself went readback-free.
// ImageBitmaps are immutable, so the engine can cache the texture and
// repeated stamps stay on the GPU. The canvas remains the fallback
// until the bitmap resolves (ms) and on engines without
// createImageBitmap.
export function createAtlasCache({ onAtlasReady, brushUrl } = {}) {
  const atlasMasks = new Map();
  const tintAtlasCache = new Map();
  const canMakeBitmaps = typeof createImageBitmap === 'function';
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
    const mask = makeFallbackAtlasMask(def.fallbackShape);
    entry = {
      mask,
      mips: buildMipChain(mask, ATLAS_CELL),
      fromPng: false,
      cell: ATLAS_CELL,
      variants: ATLAS_VARIANTS,
    };
    atlasMasks.set(brushId, entry);
    return entry;
  }

  // `diameter` is the stamp's full-pressure size in device pixels of the
  // target (delta #40); omitted, the full-resolution atlas is returned.
  function getTintedAtlas(brushId, color, diameter) {
    const entry = ensureAtlasMask(brushId);
    const level = levelFor(entry, diameter);
    const key = `${brushId}|${color}|${level}`;
    let tinted = tintAtlasCache.get(key);
    if (!tinted) {
      tinted = { canvas: tintAtlasMask(entry.mips[level], color), bitmap: null };
      tintAtlasCache.set(key, tinted);
      if (canMakeBitmaps) {
        // Promote to an immutable (texture-cacheable) source. Guard
        // against the entry having been invalidated (PNG landed) by
        // the time the promise resolves.
        createImageBitmap(tinted.canvas).then((bmp) => {
          if (tintAtlasCache.get(key) === tinted) tinted.bitmap = bmp;
          else bmp.close();
        }).catch(() => {});
      }
    }
    return { atlas: tinted.bitmap || tinted.canvas, cell: entry.mips[level].height, variants: entry.variants };
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
      atlasMasks.set(def.id, { mask: canvas, mips: buildMipChain(canvas, cell), fromPng: true, cell, variants });
      for (const k of [...tintAtlasCache.keys()]) {
        if (k.startsWith(`${def.id}|`)) {
          const stale = tintAtlasCache.get(k);
          if (stale && stale.bitmap) stale.bitmap.close();
          tintAtlasCache.delete(k);
        }
      }
      if (onAtlasReady) onAtlasReady(def.id);
    }));
  }

  return { ensureAtlasMask, getTintedAtlas, loadPngBrushes };
}
