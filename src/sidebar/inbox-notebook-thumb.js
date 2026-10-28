/**
 * The Inbox preview's notebook snapshot: the notebook's shapes drawn
 * offscreen, fitted to their content, with no background — so the
 * sidebar's own colour shows through — and none of the canvas's chrome
 * (toolbar, selection, shelf). Two are drawn, one in the notebook's
 * light theme and one in its dark, so the preview matches whichever
 * appearance is on screen without waiting for the next save.
 *
 * Drawn through the export renderer (notebook/renderer-export.ts), as
 * the Versions panel's thumbnails are; strokes are approximated as
 * polylines (notebook-snapshot-preview.js#drawApproximateStrokes).
 */
import { renderForExport } from "../notebook/renderer-export.ts";
import { snapshotFlowchart } from "../notebook/flowchart-snapshot.ts";
import { computeNotebookBounds, computeSnapshotCamera, drawApproximateStrokes } from "./notebook-snapshot-preview.js";

/** CSS size of the snapshot; drawn at twice that for sharp screens. */
const CSS_W = 240;
const MIN_H = 48;
const MAX_H = 110;
const SCALE = 2;

/** Draw `canvasInstance`'s notebook in `variant` ("light" | "dark"), or
 *  null when it holds nothing to draw. */
function draw(canvasInstance, variant, payload, bounds) {
  const st = canvasInstance.state;
  const aspect = (bounds.maxY - bounds.minY + 64) / Math.max(1, bounds.maxX - bounds.minX + 64);
  const cssH = Math.round(Math.max(MIN_H, Math.min(MAX_H, CSS_W * aspect)));
  const out = document.createElement("canvas");
  out.width = CSS_W * SCALE;
  out.height = cssH * SCALE;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  const camera = computeSnapshotCamera(bounds, CSS_W, cssH);
  const theme = st.themeForVariant?.(variant) || st.theme;
  renderForExport(ctx, CSS_W, cssH, {
    shapes: payload.shapes,
    camera,
    imageCache: canvasInstance.getImageCache?.() || new Map(),
    theme,
    backgroundPattern: "blank",
    gridSpacing: st.gridSpacing || 25,
    gridOpacity: 0,
    fontFamily: st.fontFamily || "Inter",
    layers: payload.layers,
    includeBackground: false,
    flowchart: snapshotFlowchart(payload.shapes, payload.flowEdges, st.fontFamily || "Inter", camera.zoom),
  });
  drawApproximateStrokes(ctx, payload.shapes, camera, theme);
  // PNG keeps the transparency (WebKit has no WebP encoder, and JPEG
  // has no alpha).
  try { return out.toDataURL("image/png"); } catch { return null; }
}

/** `{ light, dark }` data URLs for the notebook in `canvasInstance`, or
 *  null when it is empty. */
export function renderNotebookThumbs(canvasInstance) {
  const st = canvasInstance?.state;
  if (!st) return null;
  const shapes = (st.shapes || []).filter((s) => !s.pocketed);
  const payload = {
    shapes,
    layers: st.layers,
    flowEdges: st.flowEdgesLocked ? [] : st.flowchart?.serialize?.() || [],
  };
  const bounds = computeNotebookBounds(payload, st.fontFamily || "Inter");
  if (!bounds) return null;
  const light = draw(canvasInstance, "light", payload, bounds);
  const dark = draw(canvasInstance, "dark", payload, bounds);
  return light && dark ? { light, dark } : null;
}
