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
import { FONT_FAMILY } from "../notebook/types.ts";
import { decodeNotebookContent } from "../notebook/notebook-content.ts";
import {
  computeNotebookBounds,
  drawApproximateStrokes,
} from "../sidebar/notebook-snapshot-preview.js";
import { collectDesktopFiles, DESKTOP_KIND_ORDER } from "./desktop-files.js";
import { loadThumbRecord, saveThumbRecord, loadDesktopEnvelope } from "./desktop-store.js";
import { layoutDocOutline, drawDocOutline } from "./desktop-outline.js";
import {
  makeCanvas, encode, loadImage, baseRenderOpts, drawCard,
  docThumbText, pageGround, docPageTheme, CARD_W, CARD_H,
} from "./desktop-thumb-draw.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

// Doc thumbnails read as a printed page: 320 × 420 by default, generous
// inner margins, and a pure white / black page ground (by appearance)
// rather than the canvas colour. The per-Desktop options (bg-settings
// flyout) scale these: `themeCtx.longEdge` scales every thumbnail
// relative to the 400 px default, `themeCtx.docFontSize` sets the doc
// page's type size.
const DOC_W = 320;
const DOC_H = 420;
const DOC_PAD = 40;
const DOC_FONT_SIZE = 8;
const BASE_LONG_EDGE = 400;
// Bump when thumbnail geometry / styling changes so cached renders
// regenerate on the next Desktop open.
const THUMB_STYLE_VERSION = 11;
// Doc outline column geometry + drawing live in ./desktop-outline.js.
// Width of each constituent slice in a stack file's thumbnail.
const STACK_SLICE_WIDTH = 80;
// Doc length representation: one sheet per PAGE_WORDS words, drawn as a
// faintly-bordered page-ground box offset down-right behind the page.
// The offset has to survive the Desktop's fit-all zoom (~0.5×) to read,
// so a 6 px step shows as ~3 px on screen — a legible stack.
const PAGE_WORDS = 500;
const SHEET_OFFSET = 6;
const MAX_SHEETS = 20;
// Sheet edge — a soft grey so the stepped pages read against the white
// page without shouting. Thumbnails are always light, so this is fixed.
const SHEET_BORDER = "rgba(60,60,60,0.28)";
// Notebook thumbnails sit inside a page-ground matte.
const NB_MATTE = 20;

/** Per-Desktop option accessors — themeCtx carries them (and folds them
 *  into its cache signature); plain defaults elsewhere. */
function optLongEdge(themeCtx) {
  const n = themeCtx?.longEdge;
  return typeof n === "number" && n >= 100 ? n : BASE_LONG_EDGE;
}
function optScale(themeCtx) {
  return optLongEdge(themeCtx) / BASE_LONG_EDGE;
}
function optDocFontSize(themeCtx) {
  const n = themeCtx?.docFontSize;
  return typeof n === "number" && n >= 3 && n <= 24 ? n : DOC_FONT_SIZE;
}
const NB_MARGIN = 10;

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
  if (entry.kind === "doc") {
    return `${v}|doc|${fileModified(state, entry.fileId)}|o${entry.outline ? 1 : 0}|${themeSig}`;
  }
  if (entry.kind === "notebook") {
    return `${v}|notebook|${fileModified(state, entry.fileId)}|${themeSig}`;
  }
  // Stack fans recompose when the stack file itself changes (items
  // added / removed / reordered); a constituent file's *content* edit
  // shows on the next explicit Refresh.
  if (entry.kind === "stack") return `${v}|stack|${fileModified(state, entry.fileId)}|${themeSig}`;
  if (entry.kind === "project") {
    const collected = collectDesktopFiles(state, entry.nodeId);
    // Names ride the signature too: the composite paints them under each
    // child thumbnail, and the outline column is nothing but names.
    const parts = (collected?.entries || []).map((e) => e.kind === "project"
      ? `p:${e.nodeId}:${e.name}`
      : `${e.kind}:${e.key}:${fileModified(state, e.fileId)}:${e.name}`);
    return `${v}|project|${parts.join(",")}|o${entry.outline ? 1 : 0}|${themeSig}`;
  }
  return null;
}


/** A doc renders as a printed page sitting on a stack of paper: the
 *  rendered-markdown page on top, plus one faintly-bordered page-ground
 *  sheet per PAGE_WORDS words behind it, each offset 2 px down-right —
 *  so a long doc visibly reads as a thick pile. Borders are baked in
 *  (the sheets make the bounding box non-rectangular), so the record is
 *  `frameless` and the canvas chrome skips its own border. */
async function renderDocThumb(state, entry, themeCtx) {
  const content = await loadFileContent(state, entry.fileId);
  const text = docThumbText(content);
  const scale = optScale(themeCtx);
  const w = Math.round(DOC_W * scale);
  const h = Math.round(DOC_H * scale);
  const pad = Math.round(DOC_PAD * scale);
  const off = Math.max(1, Math.round(SHEET_OFFSET * scale));

  const words = text.split(/\s+/).filter(Boolean).length;
  const pages = Math.max(1, Math.ceil(words / PAGE_WORDS));
  const sheets = Math.min(MAX_SHEETS, pages - 1);

  const blockW = w + sheets * off;
  const blockH = h + sheets * off;

  // Optional clickable outline column, attached to the **left** of the
  // page. Headings are parsed from the *original* content so their
  // startOffsets index the real document (the click handler scrolls the
  // opened doc to that offset).
  let outline = null;
  if (entry.outline) {
    const { parseHeadings } = await import("../longview/longview-parser.js");
    outline = layoutDocOutline(parseHeadings(content), scale, 0);
  }

  // The column takes the left band, so everything the page draws shifts
  // right by its width.
  const ox = outline ? outline.colW : 0;
  const imgW = blockW + ox;
  const imgH = outline ? Math.max(blockH, outline.contentH) : blockH;
  const { canvas, ctx } = makeCanvas(imgW, imgH);
  const ground = pageGround(themeCtx);

  // The paper pile, deepest sheet first — a white sheet with a soft
  // edge and a hair of shadow so each step reads as a physical page.
  for (let i = sheets; i >= 1; i--) {
    const x = ox + i * off, y = i * off;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.12)";
    ctx.shadowBlur = 2;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = ground;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    ctx.strokeStyle = SHEET_BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  // The page itself. Clip so a long doc's text can't bleed onto the
  // pile offsets below it.
  ctx.fillStyle = ground;
  ctx.fillRect(ox, 0, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, 0, w, h);
  ctx.clip();
  const shape = {
    id: "doc-thumb", type: "text", color: "auto",
    position: { x: ox + pad, y: pad },
    // ~40 wrapped lines fill the page; 4 KB of text is plenty.
    text: text.slice(0, 4000) || " ",
    fontSize: optDocFontSize(themeCtx),
    width: w - pad * 2, manualWidth: true,
  };
  renderForExport(ctx, imgW, imgH, {
    ...baseRenderOpts(themeCtx),
    shapes: [shape],
    camera: { x: 0, y: 0, zoom: 1 },
    // Ink guarded against a cross-appearance theme pairing.
    theme: docPageTheme(themeCtx),
    includeBackground: false,
  });
  ctx.restore();
  ctx.strokeStyle = SHEET_BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(ox + 0.5, 0.5, w - 1, h - 1);

  if (outline) {
    drawDocOutline(ctx, outline, {
      ink: docPageTheme(themeCtx).foreground,
      border: SHEET_BORDER,
      fontFamily: FONT_FAMILY,
      bg: ground,
      height: imgH,
    });
  }

  return {
    dataUrl: encode(canvas), w: imgW, h: imgH, frameless: true,
    outlineRows: outline ? outline.rows : null,
  };
}

async function renderNotebookThumb(state, entry, themeCtx) {
  const content = await loadFileContent(state, entry.fileId);
  const decoded = content ? decodeNotebookContent(content) : null;
  const shapes = (decoded?.shapes || []).filter((s) => !s.pocketed);
  const bounds = computeNotebookBounds(decoded || {}, themeCtx.fontFamily);
  if (!bounds) return drawCard(themeCtx, "Empty notebook", null);

  const worldW = bounds.maxX - bounds.minX + NB_MARGIN * 2;
  const worldH = bounds.maxY - bounds.minY + NB_MARGIN * 2;
  const zoom = optLongEdge(themeCtx) / Math.max(worldW, worldH);
  // Content box (long edge = the option value) sits inside a 20 px
  // page-ground matte.
  const matte = Math.round(NB_MATTE * optScale(themeCtx));
  const innerW = Math.max(1, Math.round(worldW * zoom));
  const innerH = Math.max(1, Math.round(worldH * zoom));
  const cssW = innerW + matte * 2;
  const cssH = innerH + matte * 2;
  const camera = {
    x: -(bounds.minX - NB_MARGIN) * zoom + matte,
    y: -(bounds.minY - NB_MARGIN) * zoom + matte,
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
  // Page-ground matte around the canvas-coloured content box.
  ctx.fillStyle = pageGround(themeCtx);
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.fillStyle = themeCtx.canvasBackgroundOverride || themeCtx.theme.canvasBackground;
  ctx.fillRect(matte, matte, innerW, innerH);
  ctx.save();
  ctx.beginPath();
  ctx.rect(matte, matte, innerW, innerH);
  ctx.clip();
  renderForExport(ctx, cssW, cssH, {
    ...baseRenderOpts(themeCtx),
    shapes, camera, imageCache,
    layers: decoded?.layers,
    includeBackground: false,
  });
  drawApproximateStrokes(ctx, shapes, camera, themeCtx.theme);
  ctx.restore();
  return { dataUrl: encode(canvas), w: cssW, h: cssH };
}

/** A stack file renders as a row of 80 px slices — one per constituent
 *  file, in stack order, each showing the left edge of that file's
 *  thumbnail normalized to the long-edge height. Reads like a book
 *  spine row of the stack's contents. */
async function renderStackFanThumb(state, entry, themeCtx, depth) {
  const content = await loadFileContent(state, entry.fileId);
  let items = [];
  try {
    const parsed = JSON.parse(content);
    if (parsed?.format === "hushstack" && Array.isArray(parsed.items)) items = parsed.items;
  } catch { /* fall through to the glyph card */ }
  const kindMap = { document: "doc", notebook: "notebook", pdf: "pdf", project: "project" };
  items = items.filter((it) => it && it.fileId && kindMap[it.fileType]).slice(0, 8);
  const scale = optScale(themeCtx);
  if (!items.length || depth >= 2) {
    return drawCard(themeCtx, entry.name, "stack", Math.round(CARD_W * scale), Math.round(CARD_H * scale));
  }

  const sliceH = optLongEdge(themeCtx);
  const sliceW = Math.round(STACK_SLICE_WIDTH * scale);
  const images = [];
  for (const it of items) {
    const kind = kindMap[it.fileType];
    const pseudo = {
      key: it.fileId, kind,
      fileId: kind === "project" ? null : it.fileId,
      nodeId: it.fileId,
      name: it.name || "",
    };
    const t = await ensureDesktopThumb(state, pseudo, themeCtx, { depth: depth + 1 });
    const img = await loadImage(t.dataUrl || t.url);
    // Name rides along with the image so a slice that failed to decode
    // can't shift the captions out of step with what's drawn.
    if (img && img.naturalWidth && img.naturalHeight) images.push({ img, name: pseudo.name });
  }
  if (!images.length) {
    return drawCard(themeCtx, entry.name, "stack", Math.round(CARD_W * scale), Math.round(CARD_H * scale));
  }

  const cssW = sliceW * images.length;
  const { canvas, ctx } = makeCanvas(cssW, sliceH);
  const t = themeCtx.theme;
  const slices = [];
  for (let i = 0; i < images.length; i++) {
    const x = i * sliceW;
    const { img, name } = images[i];
    const drawW = Math.max(sliceW, Math.round((img.naturalWidth / img.naturalHeight) * sliceH));
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, 0, sliceW, sliceH);
    ctx.clip();
    ctx.fillStyle = themeCtx.canvasBackgroundOverride || t.canvasBackground;
    ctx.fillRect(x, 0, sliceW, sliceH);
    // Left edge of the file's thumbnail, scaled to the slice height.
    ctx.drawImage(img, x, 0, drawW, sliceH);
    ctx.restore();
    ctx.strokeStyle = t.uiBorder || "rgba(128,128,128,0.3)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, 0.5, sliceW - 1, sliceH - 1);
    slices.push({ x, w: sliceW, name });
  }
  return { dataUrl: encode(canvas), w: cssW, h: sliceH, slices };
}

async function resolvePdfThumb(entry, themeCtx) {
  const { loadPdfCoverUrl, ensurePdfCover } = await import("../pdf/pdf-covers.js");
  const url = (await loadPdfCoverUrl(entry.fileId)) || (await ensurePdfCover(entry.fileId));
  if (!url) return null;
  const img = await loadImage(url);
  if (!img) return null;
  const h = optLongEdge(themeCtx);
  const w = Math.max(1, Math.round((img.naturalWidth / Math.max(1, img.naturalHeight)) * h));
  return { url, w, h };
}

/** Outline rows for a project thumbnail: one per child, in project
 *  order. Nested projects and docs are the reading order (level 1);
 *  notebooks / PDFs / stacks are supporting material (level 2, dimmer).
 *  Each row carries the fileRef-shaped `target` the click handler opens,
 *  so a project's outline reads like a single document's table of
 *  contents but jumps to whole files. */
function projectOutlineRows(children) {
  return children.map((c) => ({
    text: c.name || "Untitled",
    level: c.kind === "doc" || c.kind === "project" ? 1 : 2,
    target: { key: c.key, kind: c.kind, fileId: c.fileId, nodeId: c.nodeId, name: c.name },
  }));
}

/** Compose a project's Desktop into one thumbnail: each child file's
 *  thumbnail drawn at its saved Desktop position (or the default grid
 *  when the project's Desktop has never been opened). Sized like a
 *  notebook thumbnail — the composite is fit to the long-edge option
 *  and set inside the same page-ground matte, since both are "a whole
 *  canvas shrunk down" rather than a printed page. */
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
  const zoom = optLongEdge(themeCtx) / Math.max(worldW, worldH);
  // Same matte as a notebook thumbnail, scaled by the long-edge option.
  const matte = Math.round(NB_MATTE * optScale(themeCtx));
  const innerW = Math.max(1, Math.round(worldW * zoom));
  const innerH = Math.max(1, Math.round(worldH * zoom));

  let outline = null;
  if (entry.outline) outline = layoutDocOutline(projectOutlineRows(children), optScale(themeCtx), 0);
  const ox = outline ? outline.colW : 0;
  const blockW = innerW + matte * 2;
  const blockH = innerH + matte * 2;
  const imgW = blockW + ox;
  const imgH = outline ? Math.max(blockH, outline.contentH) : blockH;

  const { canvas, ctx } = makeCanvas(imgW, imgH);
  const t = themeCtx.theme;
  ctx.fillStyle = pageGround(themeCtx);
  ctx.fillRect(ox, 0, blockW, blockH);
  ctx.fillStyle = themeCtx.canvasBackgroundOverride || t.canvasBackground;
  ctx.fillRect(ox + matte, matte, innerW, innerH);
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox + matte, matte, innerW, innerH);
  ctx.clip();
  ctx.translate(ox + matte, matte);
  ctx.scale(zoom, zoom);
  ctx.translate(-(minX - NB_MARGIN), -(minY - NB_MARGIN));
  // Where each child lands in the finished thumbnail's own CSS px. Rides
  // on the fileRef so the renderer can paint each child's file stickies
  // over the composite live — stickies are never baked in.
  const childRects = [];
  for (const child of children) {
    const r = rects.get(child.key);
    const thumb = thumbs.get(child.key);
    if (!r || !thumb) continue;
    childRects.push({
      kind: child.kind, fileId: child.fileId || null,
      x: ox + matte + (r.x - (minX - NB_MARGIN)) * zoom,
      y: matte + (r.y - (minY - NB_MARGIN)) * zoom,
      w: r.w * zoom, h: r.h * zoom,
    });
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
  ctx.strokeRect(ox + 0.5, 0.5, blockW - 1, blockH - 1);

  if (outline) {
    drawDocOutline(ctx, outline, {
      ink: docPageTheme(themeCtx).foreground,
      border: SHEET_BORDER,
      fontFamily: FONT_FAMILY,
      bg: pageGround(themeCtx),
      height: imgH,
    });
  }
  return {
    dataUrl: encode(canvas), w: imgW, h: imgH,
    outlineRows: outline ? outline.rows : null,
    children: childRects, childScale: zoom,
  };
}

/**
 * Resolve (from cache) or generate the thumbnail for a Desktop entry.
 * Returns `{ dataUrl | url, w, h }` — display CSS-px dims, raster at 2×.
 * `opts.force` regenerates even when the signature still matches.
 */
export async function ensureDesktopThumb(state, entry, themeCtx, opts = {}) {
  const depth = opts.depth || 0;

  if (entry.kind === "pdf") {
    return (await resolvePdfThumb(entry, themeCtx))
      || { ...drawCard(themeCtx, "Downloading…", "pdf"), pending: true };
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
    else if (entry.kind === "stack") thumb = await renderStackFanThumb(state, entry, themeCtx, depth);
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
