/**
 * Desktop thumbnail generation — renders the visual preview each file
 * shows on a Desktop canvas:
 *
 *  - Docs:      a 200 × 400 snapshot of the markdown rendered through
 *               the notebook's canvas text renderer (small but readable).
 *  - Notebooks: the whole canvas content + 10 px margins, longer edge
 *               400 px. Strokes are approximated as polylines (same
 *               approach as the Versions thumbnails).
 *  - PDFs:      the shelf's first-page cover (pdf-covers.js), displayed
 *               at 400 px tall. Never cached here — the cover cache is
 *               already per-device on disk.
 *  - Projects:  a composite of the project's own Desktop — its files'
 *               thumbnails drawn at their laid-out positions.
 *  - Stacks:    a simple themed card with the stack glyph.
 *
 * Doc / notebook / project thumbnails cache in IndexedDB keyed by the
 * file's `modified` stamp + the active theme, so opening a Desktop only
 * regenerates what actually changed. Everything renders at 2× for
 * HiDPI; records carry display (CSS px) dims.
 */

import { renderForExport } from "../notebook/renderer-export.ts";
import { decodeNotebookContent } from "../notebook/notebook-content.ts";
import {
  computeNotebookBounds,
  drawApproximateStrokes,
} from "../sidebar/notebook-snapshot-preview.js";
import { collectDesktopFiles, DESKTOP_KIND_ORDER } from "./desktop-files.js";
import { loadThumbRecord, saveThumbRecord, loadDesktopEnvelope } from "./desktop-store.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

// Doc thumbnails read as a printed page: 320 × 420, generous inner
// margins, and a pure white / black page ground (by appearance) rather
// than the canvas colour.
const DOC_W = 320;
const DOC_H = 420;
const DOC_PAD = 40;
const DOC_FONT_SIZE = 8;
// Bump when thumbnail geometry / styling changes so cached renders
// regenerate on the next Desktop open.
const THUMB_STYLE_VERSION = 3;
const LONG_EDGE = 400;
const NB_MARGIN = 10;
const CARD_W = 220;
const CARD_H = 280;
const SCALE = 2; // raster density

// Session cache — avoids IDB round trips on every files-changed
// reconcile while a Desktop is open. Cleared per-key on force refresh.
const _session = new Map();

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Load a VC file's content (doc markdown / notebook envelope). Also
 *  used by desktop-view's shelf search index. */
export async function loadFileContent(state, fileId) {
  if (IS_TAURI) {
    try { return (await tauriInvoke("load_file", { id: fileId }))?.content || ""; }
    catch { return ""; }
  }
  return state.files.find((f) => f.id === fileId)?.content || "";
}

/** Signature parts derived from the theme the Desktop renders with —
 *  a theme/style switch makes every cached thumbnail stale. */
export function themeSigOf(settings) {
  return [
    settings.themeId, settings.appearanceMode, settings.fontFamily,
    settings.canvasBackgroundOverride || "", settings.foregroundOverride || "",
    settings.headingColorOverride || "",
  ].join("|");
}

function fileModified(state, fileId) {
  return state.files.find((f) => f.id === fileId)?.modified || 0;
}

/** Staleness signature for an entry. PDFs return null (they ride the
 *  cover cache instead of the thumbs store). */
export function entrySig(state, entry, themeSig) {
  const v = `v${THUMB_STYLE_VERSION}`;
  if (entry.kind === "doc" || entry.kind === "notebook") {
    return `${v}|${entry.kind}|${fileModified(state, entry.fileId)}|${themeSig}`;
  }
  if (entry.kind === "stack") return `${v}|stack|${themeSig}`;
  if (entry.kind === "project") {
    const collected = collectDesktopFiles(state, entry.nodeId);
    const parts = (collected?.entries || []).map((e) =>
      e.kind === "project" ? `p:${e.nodeId}` : `${e.kind}:${e.key}:${fileModified(state, e.fileId)}`);
    return `${v}|project|${parts.join(",")}|${themeSig}`;
  }
  return null;
}

function makeCanvas(cssW, cssH) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cssW * SCALE));
  canvas.height = Math.max(1, Math.round(cssH * SCALE));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  return { canvas, ctx };
}

function encode(canvas) {
  return canvas.toDataURL("image/webp", 0.85);
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Base render opts shared by every thumbnail — blank background in the
 *  container's own canvas colour so thumbs read as part of the surface. */
function baseRenderOpts(themeCtx) {
  return {
    imageCache: new Map(),
    theme: themeCtx.theme,
    backgroundPattern: "blank",
    gridSpacing: 25,
    gridOpacity: 0,
    fontFamily: themeCtx.fontFamily,
    includeBackground: true,
    canvasBackgroundOverride: themeCtx.canvasBackgroundOverride || "",
    flowchart: undefined,
    omitTextGlyphs: false,
  };
}

/** A neutral card used for stacks, pending PDFs, and empty containers. */
function drawCard(themeCtx, label, glyph, cssW = CARD_W, cssH = CARD_H) {
  const { canvas, ctx } = makeCanvas(cssW, cssH);
  const t = themeCtx.theme;
  ctx.fillStyle = themeCtx.canvasBackgroundOverride || t.canvasBackground;
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.strokeStyle = t.uiBorder || "rgba(128,128,128,0.3)";
  ctx.strokeRect(0.5, 0.5, cssW - 1, cssH - 1);
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.strokeStyle = t.foreground;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  const cx = cssW / 2, cy = cssH / 2 - 10;
  if (glyph === "stack") {
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(cx + i * 16, cy - 28);
      ctx.lineTo(cx + i * 16, cy + 28);
      ctx.stroke();
    }
  } else if (glyph === "pdf" || glyph === "project") {
    ctx.strokeRect(cx - 24, cy - 30, 48, 60);
  }
  if (label) {
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = t.foreground;
    ctx.font = `12px ${themeCtx.fontFamily}, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, cx, cy + 52);
  }
  ctx.restore();
  return { dataUrl: encode(canvas), w: cssW, h: cssH };
}

/** Strip YAML frontmatter + %%comments%% so a doc thumbnail starts at
 *  its actual prose. */
function docThumbText(content) {
  let text = content || "";
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) text = text.slice(end + 4).replace(/^\n+/, "");
  }
  text = text.replace(/%%[\s\S]*?%%/g, "");
  // ~40 wrapped lines fill 400px at 8px type; 4000 chars is plenty.
  return text.slice(0, 4000);
}

/** Rough sRGB luminance of a #rgb / #rrggbb color; null when unparsable. */
function hexLuminance(color) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((color || "").trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/** The doc page is always white (light) / black (dark), whatever the
 *  canvas theme — so make sure the ink still contrasts when the user
 *  paired a dark theme with light appearance (or vice versa). */
function docPageTheme(themeCtx) {
  const dark = themeCtx.appearance === "dark";
  const t = themeCtx.theme;
  const fixInk = (color, fallback) => {
    const lum = hexLuminance(color);
    if (lum == null) return color;
    if (dark && lum < 0.35) return fallback;
    if (!dark && lum > 0.65) return fallback;
    return color;
  };
  return {
    ...t,
    foreground: fixInk(t.foreground, dark ? "#e8e8e8" : "#1a1a1a"),
    headingColor: fixInk(t.headingColor, dark ? "#e8e8e8" : "#1a1a1a"),
  };
}

async function renderDocThumb(state, entry, themeCtx) {
  const content = await loadFileContent(state, entry.fileId);
  const { canvas, ctx } = makeCanvas(DOC_W, DOC_H);
  const shape = {
    id: "doc-thumb", type: "text", color: "auto",
    position: { x: DOC_PAD, y: DOC_PAD },
    text: docThumbText(content) || " ",
    fontSize: DOC_FONT_SIZE,
    width: DOC_W - DOC_PAD * 2, manualWidth: true,
  };
  renderForExport(ctx, DOC_W, DOC_H, {
    ...baseRenderOpts(themeCtx),
    shapes: [shape],
    camera: { x: 0, y: 0, zoom: 1 },
    // A doc reads as a printed page, not a patch of canvas — solid
    // white ground in light appearance, black in dark, ink guarded
    // against a cross-appearance theme pairing.
    theme: docPageTheme(themeCtx),
    canvasBackgroundOverride: themeCtx.appearance === "dark" ? "#000000" : "#ffffff",
  });
  return { dataUrl: encode(canvas), w: DOC_W, h: DOC_H };
}

async function renderNotebookThumb(state, entry, themeCtx) {
  const content = await loadFileContent(state, entry.fileId);
  const decoded = content ? decodeNotebookContent(content) : null;
  const shapes = (decoded?.shapes || []).filter((s) => !s.pocketed);
  const bounds = computeNotebookBounds(decoded || {}, themeCtx.fontFamily);
  if (!bounds) return drawCard(themeCtx, "Empty notebook", null);

  const worldW = bounds.maxX - bounds.minX + NB_MARGIN * 2;
  const worldH = bounds.maxY - bounds.minY + NB_MARGIN * 2;
  const zoom = LONG_EDGE / Math.max(worldW, worldH);
  const cssW = Math.max(1, Math.round(worldW * zoom));
  const cssH = Math.max(1, Math.round(worldH * zoom));
  const camera = {
    x: -(bounds.minX - NB_MARGIN) * zoom,
    y: -(bounds.minY - NB_MARGIN) * zoom,
    zoom,
  };

  // Image shapes need a decoded HTMLImageElement cache; pick the raster
  // variant matching the active appearance for appearance-aware images.
  const imageCache = new Map();
  const dark = themeCtx.appearance === "dark";
  await Promise.all(shapes
    .filter((s) => s.type === "image" && (s.dataUrl || s.dataUrlDark))
    .map(async (s) => {
      const img = await loadImage(dark && s.dataUrlDark ? s.dataUrlDark : s.dataUrl);
      if (img) imageCache.set(s.id, img);
    }));

  const { canvas, ctx } = makeCanvas(cssW, cssH);
  renderForExport(ctx, cssW, cssH, {
    ...baseRenderOpts(themeCtx),
    shapes, camera, imageCache,
    layers: decoded?.layers,
  });
  drawApproximateStrokes(ctx, shapes, camera, themeCtx.theme);
  return { dataUrl: encode(canvas), w: cssW, h: cssH };
}

async function resolvePdfThumb(entry) {
  const { loadPdfCoverUrl, ensurePdfCover } = await import("../pdf/pdf-covers.js");
  const url = (await loadPdfCoverUrl(entry.fileId)) || (await ensurePdfCover(entry.fileId));
  if (!url) return null;
  const img = await loadImage(url);
  if (!img) return null;
  const h = LONG_EDGE;
  const w = Math.max(1, Math.round((img.naturalWidth / Math.max(1, img.naturalHeight)) * h));
  return { url, w, h };
}

/** Compose a project's Desktop into one thumbnail: each child file's
 *  thumbnail drawn at its saved Desktop position (or the default grid
 *  when the project's Desktop has never been opened). */
async function renderProjectThumb(state, entry, themeCtx, depth) {
  const collected = collectDesktopFiles(state, entry.nodeId);
  const children = collected?.entries || [];
  if (!children.length) return drawCard(themeCtx, "Empty project", "project");
  if (depth >= 2) return drawCard(themeCtx, entry.name, "project");

  const thumbs = new Map();
  for (const child of children) {
    thumbs.set(child.key, await ensureDesktopThumb(state, child, themeCtx, { depth: depth + 1 }));
  }

  // Saved layout wins for entries it knows; the rest grid in below.
  const envelope = await loadDesktopEnvelope(entry.nodeId);
  const rects = new Map();
  let maxSavedY = 0;
  for (const s of envelope?.shapes || []) {
    if (s?.fileRef?.key && s.type === "image") {
      rects.set(s.fileRef.key, { x: s.position.x, y: s.position.y, w: s.width, h: s.height });
      maxSavedY = Math.max(maxSavedY, s.position.y + s.height);
    }
  }
  const missing = children.filter((c) => !rects.has(c.key));
  if (missing.length) {
    const gridded = computeDesktopGrid(missing, thumbs, rects.size ? maxSavedY + DESKTOP_GRID_GAP : 0);
    for (const [key, rect] of gridded) rects.set(key, rect);
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const child of children) {
    const r = rects.get(child.key);
    if (!r) continue;
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h + 24);
  }
  if (!Number.isFinite(minX)) return drawCard(themeCtx, "Empty project", "project");

  const worldW = maxX - minX + NB_MARGIN * 2;
  const worldH = maxY - minY + NB_MARGIN * 2;
  const zoom = LONG_EDGE / Math.max(worldW, worldH);
  const cssW = Math.max(1, Math.round(worldW * zoom));
  const cssH = Math.max(1, Math.round(worldH * zoom));

  const { canvas, ctx } = makeCanvas(cssW, cssH);
  const t = themeCtx.theme;
  ctx.fillStyle = themeCtx.canvasBackgroundOverride || t.canvasBackground;
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.save();
  ctx.scale(zoom, zoom);
  ctx.translate(-(minX - NB_MARGIN), -(minY - NB_MARGIN));
  for (const child of children) {
    const r = rects.get(child.key);
    const thumb = thumbs.get(child.key);
    if (!r || !thumb) continue;
    const img = await loadImage(thumb.dataUrl || thumb.url);
    if (img) ctx.drawImage(img, r.x, r.y, r.w, r.h);
    ctx.strokeStyle = t.uiBorder || "rgba(128,128,128,0.3)";
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = t.foreground;
    ctx.globalAlpha = 0.7;
    ctx.font = `13px ${themeCtx.fontFamily}, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(child.name, r.x + r.w / 2, r.y + r.h + 6, r.w * 1.4);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  ctx.strokeStyle = t.uiBorder || "rgba(128,128,128,0.3)";
  ctx.strokeRect(0.5, 0.5, cssW - 1, cssH - 1);
  return { dataUrl: encode(canvas), w: cssW, h: cssH };
}

/**
 * Resolve (from cache) or generate the thumbnail for a Desktop entry.
 * Returns `{ dataUrl | url, w, h }` — display CSS-px dims, raster at 2×.
 * `opts.force` regenerates even when the signature still matches.
 */
export async function ensureDesktopThumb(state, entry, themeCtx, opts = {}) {
  const depth = opts.depth || 0;

  if (entry.kind === "pdf") {
    return (await resolvePdfThumb(entry))
      || { ...drawCard(themeCtx, "Downloading…", "pdf"), pending: true };
  }
  if (entry.kind === "stack") {
    const key = `stack-card|${themeCtx.sig}`;
    if (!_session.has(key)) _session.set(key, drawCard(themeCtx, null, "stack"));
    return _session.get(key);
  }

  const sig = entrySig(state, entry, themeCtx.sig);
  const cacheKey = entry.key;
  if (!opts.force) {
    const cached = _session.get(cacheKey);
    if (cached && cached.sig === sig) return cached;
    const rec = await loadThumbRecord(cacheKey);
    if (rec && rec.sig === sig && rec.dataUrl) {
      _session.set(cacheKey, rec);
      return rec;
    }
  }

  let thumb;
  try {
    if (entry.kind === "doc") thumb = await renderDocThumb(state, entry, themeCtx);
    else if (entry.kind === "notebook") thumb = await renderNotebookThumb(state, entry, themeCtx);
    else if (entry.kind === "project") thumb = await renderProjectThumb(state, entry, themeCtx, depth);
    else thumb = drawCard(themeCtx, entry.name, null);
  } catch (e) {
    console.warn("Desktop thumbnail render failed:", entry.kind, e);
    thumb = drawCard(themeCtx, entry.name, null);
  }
  const record = { ...thumb, sig };
  _session.set(cacheKey, record);
  saveThumbRecord(cacheKey, record);
  return record;
}

// ── Initial grid layout ─────────────────────────────────────────────

export const DESKTOP_GRID_GAP = 150;
const GRID_COLS = 4;

/**
 * Lay entries out in a grid grouped by filetype — ~150 px between
 * thumbnails, sections stacked vertically in DESKTOP_KIND_ORDER.
 * Returns Map key → `{ x, y, w, h }` (world px), starting at `startY`.
 * Shared by the Desktop's initial placement and project-thumb
 * composition, so a never-opened project previews exactly the layout
 * its Desktop will first open with.
 */
export function computeDesktopGrid(entries, thumbs, startY = 0) {
  const rects = new Map();
  let y = startY;
  for (const kind of DESKTOP_KIND_ORDER) {
    const group = entries.filter((e) => e.kind === kind);
    if (!group.length) continue;
    for (let i = 0; i < group.length; i += GRID_COLS) {
      const row = group.slice(i, i + GRID_COLS);
      let x = 0;
      let rowH = 0;
      for (const e of row) {
        const t = thumbs.get(e.key) || { w: CARD_W, h: CARD_H };
        rects.set(e.key, { x, y, w: t.w, h: t.h });
        x += t.w + DESKTOP_GRID_GAP;
        rowH = Math.max(rowH, t.h);
      }
      y += rowH + DESKTOP_GRID_GAP;
    }
  }
  return rects;
}

/** Drop an entry's session cache (force-refresh helper). */
export function evictSessionThumb(key) {
  _session.delete(key);
}
