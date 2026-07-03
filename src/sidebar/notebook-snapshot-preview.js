/**
 * Notebook snapshot thumbnail renderer for the Versions panel.
 *
 * Snapshots are stored as JSON envelopes (see notebook-content.ts). To
 * preview one we decode the envelope, fit the camera to its content
 * bbox, and call the existing notebook export renderer. Drawing strokes
 * are approximated as polylines because the bake-engine canvas only
 * exists for the live notebook — close enough for a thumbnail.
 *
 * Theme + font come from the live notebook so the thumbnail visually
 * matches whatever the user is currently looking at.
 */

import { decodeNotebookContent } from "../notebook/notebook-content.ts";
import { renderForExport } from "../notebook/renderer-export.ts";
import { getShapeBounds } from "../notebook/utils.ts";

const PADDING = 32;

const FALLBACK_THEME = {
  canvasBackground: "#ffffff",
  foreground: "#222222",
  headingColor: "#222222",
  selection: "rgba(80,140,255,0.3)",
  accent: "#3b82f6",
  gridColor: "#999999",
  uiBackground: "#f8f8f8",
  uiBorder: "#e0e0e0",
};

/** Render an in-memory `{ shapes, layers }` payload into `targetCanvas`,
 *  optionally at an explicit `camera` (the History panel passes the
 *  recorded viewport so the ghost matches what the user actually saw;
 *  omit to fit-to-content like the Versions thumbnail). */
export function renderShapesPreview(targetCanvas, payload, liveCanvas, camera) {
  const shapes = (payload?.shapes || []).filter((s) => !s.pocketed);
  const layers = payload?.layers;

  const cssW = Math.max(1, Math.round(targetCanvas.clientWidth || targetCanvas.width));
  const cssH = Math.max(1, Math.round(targetCanvas.clientHeight || targetCanvas.height));
  const dpr = window.devicePixelRatio || 1;
  targetCanvas.width = cssW * dpr;
  targetCanvas.height = cssH * dpr;
  const ctx = targetCanvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const fontFamily = liveCanvas?.state?.fontFamily || "Inter";
  const theme = liveCanvas?.state?.theme || FALLBACK_THEME;

  let cam = camera && typeof camera.zoom === "number" ? camera : null;
  if (!cam) {
    const bounds = computeContentBounds(shapes, fontFamily);
    if (!bounds) {
      ctx.fillStyle = theme.canvasBackground;
      ctx.fillRect(0, 0, cssW, cssH);
      drawEmptyMessage(ctx, cssW, cssH, theme);
      return;
    }
    cam = computeSnapshotCamera(bounds, cssW, cssH);
  }

  renderForExport(ctx, cssW, cssH, {
    shapes,
    camera: cam,
    imageCache: liveCanvas?.getImageCache?.() || new Map(),
    theme,
    backgroundPattern: liveCanvas?.state?.backgroundPattern || "blank",
    gridSpacing: liveCanvas?.state?.gridSpacing || 25,
    gridOpacity: liveCanvas?.state?.gridOpacity ?? 0,
    fontFamily,
    layers,
    includeBackground: true,
    canvasBackgroundOverride: liveCanvas?.state?.canvasBackgroundOverride || "",
    flowchart: undefined,
    omitTextGlyphs: false,
  });

  drawApproximateStrokes(ctx, shapes, cam, theme);
}

/** Render a notebook snapshot's JSON content into `targetCanvas`.
 *  `liveCanvas` is the active NotesCanvas (used for theme/font/imageCache).
 *  Returns `{ shapeCount, layerCount, camera, contentBounds }` — the
 *  camera is the one used to project the snapshot, suitable for
 *  callers that want to overlay markers (panes, viewport, etc.) on
 *  top of the thumbnail. `contentBounds` is null for an empty notebook. */
export function renderNotebookSnapshotThumbnail(targetCanvas, content, liveCanvas) {
  const decoded = decodeNotebookContent(content) || { shapes: [], layers: [], flowEdges: [] };
  const shapes = (decoded.shapes || []).filter((s) => !s.pocketed);
  const layers = decoded.layers;

  const cssW = Math.max(1, Math.round(targetCanvas.clientWidth || targetCanvas.width));
  const cssH = Math.max(1, Math.round(targetCanvas.clientHeight || targetCanvas.height));
  const dpr = window.devicePixelRatio || 1;
  targetCanvas.width = cssW * dpr;
  targetCanvas.height = cssH * dpr;

  const ctx = targetCanvas.getContext("2d");
  if (!ctx) return { shapeCount: shapes.length, layerCount: layers ? layers.length : 0, camera: null, contentBounds: null };
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const fontFamily = liveCanvas?.state?.fontFamily || "Inter";
  const theme = liveCanvas?.state?.theme || {
    canvasBackground: "#ffffff",
    foreground: "#222222",
    headingColor: "#222222",
    selection: "rgba(80,140,255,0.3)",
    accent: "#3b82f6",
    gridColor: "#999999",
    uiBackground: "#f8f8f8",
    uiBorder: "#e0e0e0",
  };

  const bounds = computeContentBounds(shapes, fontFamily);
  let camera;
  if (!bounds) {
    ctx.fillStyle = theme.canvasBackground;
    ctx.fillRect(0, 0, cssW, cssH);
    drawEmptyMessage(ctx, cssW, cssH, theme);
    return { shapeCount: 0, layerCount: layers ? layers.length : 0, camera: null, contentBounds: null };
  }
  camera = computeSnapshotCamera(bounds, cssW, cssH);

  renderForExport(ctx, cssW, cssH, {
    shapes,
    camera,
    imageCache: liveCanvas?.getImageCache?.() || new Map(),
    theme,
    backgroundPattern: liveCanvas?.state?.backgroundPattern || "blank",
    gridSpacing: liveCanvas?.state?.gridSpacing || 25,
    gridOpacity: liveCanvas?.state?.gridOpacity ?? 0,
    fontFamily,
    layers,
    includeBackground: true,
    canvasBackgroundOverride: liveCanvas?.state?.canvasBackgroundOverride || "",
    flowchart: undefined,
    omitTextGlyphs: false,
  });

  drawApproximateStrokes(ctx, shapes, camera, theme);

  return {
    shapeCount: shapes.length,
    layerCount: layers ? layers.length : 0,
    camera,
    contentBounds: bounds,
  };
}

/** Recompute the camera used by `renderNotebookSnapshotThumbnail` for a
 *  given canvas size and content bounding box. Useful for callers that
 *  want to project world coordinates (pane positions, viewport rect)
 *  into thumbnail screen space without re-rendering the canvas. */
export function computeSnapshotCamera(bounds, cssW, cssH) {
  if (!bounds) return null;
  const contentW = Math.max(1, bounds.maxX - bounds.minX);
  const contentH = Math.max(1, bounds.maxY - bounds.minY);
  const innerW = Math.max(1, cssW - PADDING * 2);
  const innerH = Math.max(1, cssH - PADDING * 2);
  const zoom = Math.min(innerW / contentW, innerH / contentH, 1);
  const scaledW = contentW * zoom;
  const scaledH = contentH * zoom;
  return {
    x: (cssW - scaledW) / 2 - bounds.minX * zoom,
    y: (cssH - scaledH) / 2 - bounds.minY * zoom,
    zoom,
  };
}

/** Compute content bounds for a decoded notebook payload — exported so
 *  the desk thumbnail can drive `computeSnapshotCamera` directly. */
export function computeNotebookBounds(decoded, fontFamily) {
  const shapes = (decoded?.shapes || []).filter((s) => !s.pocketed);
  return computeContentBounds(shapes, fontFamily);
}

/** Concatenate every text-shape body into a single searchable string.
 *  Used by the Versions panel's notebook search. */
export function extractSnapshotText(content) {
  const decoded = decodeNotebookContent(content);
  if (!decoded) return "";
  const out = [];
  for (const s of decoded.shapes || []) {
    if (s.type === "text" && typeof s.text === "string" && s.text) out.push(s.text);
  }
  return out.join("\n");
}

function computeContentBounds(shapes, fontFamily) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let any = false;
  for (const s of shapes) {
    if (s.pocketed) continue;
    let b;
    try { b = getShapeBounds(s, fontFamily); } catch { continue; }
    if (!b || !Number.isFinite(b.minX) || !Number.isFinite(b.maxX)) continue;
    if (b.maxX - b.minX <= 0 && b.maxY - b.minY <= 0) continue;
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
    any = true;
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

function drawApproximateStrokes(ctx, shapes, camera, theme) {
  const drawShapes = shapes.filter((s) => s.type === "draw" && Array.isArray(s.points) && s.points.length);
  if (!drawShapes.length) return;
  ctx.save();
  ctx.translate(camera.x, camera.y);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of drawShapes) {
    const color = s.colorIsAuto || s.color === "auto" ? theme.foreground : (s.color || theme.foreground);
    ctx.strokeStyle = color;
    ctx.globalAlpha = s.mode === "highlighter" ? 0.4 : 1;
    ctx.lineWidth = Math.max(0.5, (s.size || 4));
    ctx.beginPath();
    const pts = s.points;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawEmptyMessage(ctx, w, h, theme) {
  ctx.fillStyle = theme.foreground;
  ctx.globalAlpha = 0.5;
  ctx.font = "13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Empty notebook", w / 2, h / 2);
  ctx.globalAlpha = 1;
}
