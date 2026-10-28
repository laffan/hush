/**
 * The Inbox preview's notebook snapshot: what the notebook's camera
 * shows, as the user left it, cropped to the middle 1024 × 768 screen
 * pixels of the view so every snapshot is at one standard scale — a
 * chart drawn small and a proof page zoomed in both read as they did on
 * screen, rather than a whole canvas squeezed into a sliver. Drawn
 * offscreen with no background, so the sidebar's own colour shows
 * through, and none of the canvas's chrome (toolbar, selection, shelf).
 * Two are drawn, one in the notebook's light theme and one in its dark,
 * so the preview matches whichever appearance is on screen without
 * waiting for the next save.
 *
 * Drawn through the export renderer (notebook/renderer-export.ts), as
 * the Versions panel's thumbnails are; strokes are approximated as
 * polylines (notebook-snapshot-preview.js#drawApproximateStrokes).
 */
import { renderForExport } from "../notebook/renderer-export.ts";
import { snapshotFlowchart } from "../notebook/flowchart-snapshot.ts";
import { drawApproximateStrokes } from "./notebook-snapshot-preview.js";

/** The crop, in screen px, centred on the view. */
const CROP_W = 1024;
const CROP_H = 768;
/** The snapshot's size in px (shown at half that). */
const OUT_W = 480;
const OUT_H = 360;

/** Draw the crop in `variant` ("light" | "dark"). */
function draw(canvasInstance, variant, payload, camera) {
  const st = canvasInstance.state;
  const out = document.createElement("canvas");
  out.width = OUT_W;
  out.height = OUT_H;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  const scale = OUT_W / CROP_W;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const theme = st.themeForVariant?.(variant) || st.theme;
  const fontFamily = st.fontFamily || "Inter";
  renderForExport(ctx, CROP_W, CROP_H, {
    shapes: payload.shapes,
    camera,
    imageCache: canvasInstance.getImageCache?.() || new Map(),
    theme,
    backgroundPattern: "blank",
    gridSpacing: st.gridSpacing || 25,
    gridOpacity: 0,
    fontFamily,
    layers: payload.layers,
    includeBackground: false,
    // Arrows at the width they have on screen (the crop is drawn at the
    // camera's own zoom, then scaled down once).
    flowchart: snapshotFlowchart(payload.shapes, payload.flowEdges, fontFamily, camera.zoom * scale, 1),
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
  if (!shapes.length) return null;
  const payload = {
    shapes,
    layers: st.layers,
    flowEdges: st.flowEdgesLocked ? [] : st.flowchart?.serialize?.() || [],
  };
  // The view's middle, in the camera's screen space: the crop's corner
  // becomes the origin, so the camera shifts by it.
  const host = canvasInstance.container;
  const vw = host?.clientWidth || CROP_W;
  const vh = host?.clientHeight || CROP_H;
  const cam = st.camera || { x: 0, y: 0, zoom: 1 };
  const camera = {
    x: cam.x - (vw - CROP_W) / 2,
    y: cam.y - (vh - CROP_H) / 2,
    zoom: cam.zoom || 1,
  };
  const light = draw(canvasInstance, "light", payload, camera);
  const dark = draw(canvasInstance, "dark", payload, camera);
  return light && dark ? { light, dark } : null;
}
