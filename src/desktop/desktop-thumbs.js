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
  docOrderEdges, DOC_CONNECTION_ALPHA, DOC_CONNECTION_WIDTH,
  DOC_CONNECTION_HEAD, DOC_CONNECTION_CAP,
} from "./desktop-connections.js";
import { FlowchartLayer } from "../notebook/flowchart.ts";
import { drawStickyBox } from "../notebook/renderer.ts";
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
const THUMB_STYLE_VERSION = 13;
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
    return `${v}|project|${parts.join(",")}|o${entry.outline ? 1 : 0}|s${pinnedNotesSig(entry.nodeId)}|${themeSig}`;
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

/** Notes pinned to a project's Desktop canvas, in that canvas's world
 *  coordinates. Unlike a file's sticky badges — which the renderer
 *  paints live over the cached thumbnail — these are *content* of the
 *  Desktop being composited, so they're baked in like any other shape
 *  and counted in the bounds. */
function pinnedNotesFor(projectId) {
  const fn = typeof window !== "undefined" ? window.__hushDesktopStickiesFor : null;
  try { return fn ? fn(projectId) || [] : []; } catch { return []; }
}

/** Compact signature of a project's pinned notes, folded into the
 *  thumbnail's staleness key so an edited note shows on the next open —
 *  the same cadence a file's own edits get through `modified`. */
function pinnedNotesSig(projectId) {
  return pinnedNotesFor(projectId)
    .map((n) => `${Math.round(n.wx)},${Math.round(n.wy)},${n.w}x${n.h},${n.text.length}`)
    .join(";");
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

/** Compose a project's Desktop into one thumbnail. This is a picture of
 *  the whole Desktop, not just its files: the child thumbnails sit at
 *  their saved positions, and everything else the user put on that
 *  canvas — text shapes, drag areas, freehand strokes — renders around
 *  them through the same `renderForExport` + `drawApproximateStrokes`
 *  pair a notebook thumbnail uses. Sized by the notebook rules too (fit
 *  to the long-edge option inside the page-ground matte), since both are
 *  a whole canvas shrunk down rather than a printed page. */
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

  // Rebuild the child Desktop's shape list: a synthetic image shape per
  // file (its thumbnail decoded into the cache under the same id), plus
  // every non-file shape the envelope carries, untouched.
  const imageCache = new Map();
  const fileShapes = [];
  for (const child of children) {
    const r = rects.get(child.key);
    const thumb = thumbs.get(child.key);
    if (!r || !thumb) continue;
    const id = `pc:${child.key}`;
    const img = await loadImage(thumb.dataUrl || thumb.url);
    if (img) imageCache.set(id, img);
    fileShapes.push({
      id, type: "image", position: { x: r.x, y: r.y }, width: r.w, height: r.h,
      dataUrl: "", name: child.name, color: "#000000",
      fileRef: {
        key: child.key, kind: child.kind, fileId: child.fileId || null, name: child.name,
        ...(thumb.frameless ? { frameless: true } : {}), ...(child.tint ? { tint: child.tint } : {}),
      },
    });
  }
  const extras = (envelope?.shapes || [])
    .filter((s) => s && typeof s === "object" && !s.pocketed && !(s.type === "image" && s.fileRef));
  await Promise.all(extras
    .filter((s) => s.type === "image" && (s.dataUrl || s.dataUrlDark))
    .map(async (s) => {
      const img = await loadImage(s.dataUrl || s.dataUrlDark);
      if (img) imageCache.set(s.id, img);
    }));
  const allShapes = [...extras, ...fileShapes];

  const bounds = computeNotebookBounds({ shapes: allShapes }, themeCtx.fontFamily);
  if (!bounds) return drawCard(themeCtx, "Empty project", "project");
  // Pinned notes are content, so they set the frame like anything else.
  const notes = pinnedNotesFor(entry.nodeId);
  for (const n of notes) {
    bounds.minX = Math.min(bounds.minX, n.wx); bounds.minY = Math.min(bounds.minY, n.wy);
    bounds.maxX = Math.max(bounds.maxX, n.wx + n.w); bounds.maxY = Math.max(bounds.maxY, n.wy + n.h);
  }
  const minX = bounds.minX, minY = bounds.minY;
  const worldW = bounds.maxX - minX + NB_MARGIN * 2;
  // Room under the bottom row for the child captions.
  const worldH = bounds.maxY - minY + 24 + NB_MARGIN * 2;
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

  // World → thumbnail-CSS-px. Rides on the record so the renderer can
  // place the child Desktop's own pinned stickies over the composite.
  const camera = {
    x: ox + matte - (minX - NB_MARGIN) * zoom,
    y: matte - (minY - NB_MARGIN) * zoom,
    zoom,
  };

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
  // Document-order arrows, under the thumbnails exactly as on a live
  // Desktop. Drawn here rather than through renderForExport's own
  // flowchart hook because that hook resets the arrow colour, and these
  // need the Desktop's translucent heavy stroke.
  const flow = new FlowchartLayer({
    getBounds: (sh) => ({
      minX: sh.position.x, minY: sh.position.y,
      maxX: sh.position.x + sh.width, maxY: sh.position.y + sh.height,
    }),
  });
  flow.deserialize(docOrderEdges(children, fileShapes));
  if (flow.edges.length) {
    flow.setArrowColor(themeCtx.theme.foreground);
    flow.setArrowMetrics(DOC_CONNECTION_WIDTH, DOC_CONNECTION_HEAD, DOC_CONNECTION_CAP);
    ctx.save();
    ctx.translate(camera.x, camera.y);
    ctx.scale(zoom, zoom);
    ctx.globalAlpha = DOC_CONNECTION_ALPHA;
    flow.draw(ctx, fileShapes);
    ctx.restore();
  }
  renderForExport(ctx, imgW, imgH, {
    ...baseRenderOpts(themeCtx),
    shapes: allShapes, camera, imageCache, layers: envelope?.layers,
    includeBackground: false,
  });
  drawApproximateStrokes(ctx, allShapes, camera, themeCtx.theme);
  // Pinned notes, baked in at their world positions.
  for (const n of notes) {
    drawStickyBox(ctx, camera.x + n.wx * zoom, camera.y + n.wy * zoom,
      n.w * zoom, n.h * zoom, n.text, themeCtx.fontFamily);
  }
  // Child captions — canvas-painted here (unlike a live Desktop, where
  // labels are hover-only DOM) so the composite says what's inside it.
  ctx.translate(camera.x, camera.y);
  ctx.scale(zoom, zoom);
  ctx.fillStyle = t.foreground;
  ctx.globalAlpha = 0.7;
  ctx.font = `13px ${themeCtx.fontFamily}, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const fs of fileShapes) {
    ctx.fillText(fs.name, fs.position.x + fs.width / 2, fs.position.y + fs.height + 6, fs.width * 1.4);
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
    // Where each child landed (for its own file stickies) and the scale
    // the composite shrank everything by.
    children: fileShapes.map((fs) => ({
      kind: fs.fileRef.kind, fileId: fs.fileRef.fileId,
      x: camera.x + fs.position.x * zoom, y: camera.y + fs.position.y * zoom,
      w: fs.width * zoom, h: fs.height * zoom,
    })),
    childScale: zoom,
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
