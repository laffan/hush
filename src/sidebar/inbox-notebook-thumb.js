/**
 * The Inbox preview's notebook snapshot: what the notebook's camera
 * shows, as the user left it, cropped to the middle 1024 × 768 screen
 * pixels of the view so every snapshot is at one standard scale. Drawn
 * offscreen with no background, so the sidebar's own colour shows
 * through, and none of the canvas's chrome; once in the notebook's light
 * theme and once in its dark, so the preview matches whichever
 * appearance is on screen.
 *
 * Two steps, so the snapshot is always of the notebook that was saved
 * and never costs more than the crop:
 *
 *   - `captureScene` (inbox-notebook-scene.js, kept free of the
 *     renderer so the save path can call it synchronously) runs as the
 *     save lands, while the canvas still
 *     holds that notebook: it keeps references (the shapes array is
 *     immutable, so holding it is free), the camera and the view's size
 *     — nothing is drawn. A canvas that isn't on screen (its size is 0)
 *     gives no scene, so leaving a file can't replace its snapshot with
 *     one taken from a hidden view.
 *   - `renderScene` draws it later, at an idle moment, and draws only
 *     the shapes inside the crop (a cheap box test per shape, before any
 *     text is measured): a proof notebook of a few hundred pages costs
 *     the page or two in view, not the whole document.
 *
 * Drawn through the export renderer (notebook/renderer-export.ts);
 * strokes are approximated as polylines
 * (notebook-snapshot-preview.js#drawApproximateStrokes).
 */
import { renderForExport } from "../notebook/renderer-export.ts";
import { snapshotFlowchart } from "../notebook/flowchart-snapshot.ts";
import { drawApproximateStrokes } from "./notebook-snapshot-preview.js";

import { CROP_W, CROP_H } from "./inbox-notebook-scene.js";

/** The snapshot's size in px (shown at half that). */
const OUT_W = 480;
const OUT_H = 360;

/** A generous box round a shape without measuring anything: text is
 *  given its set width (or a wide one) and a height from its length. */
function roughBox(s) {
  const p = s.position;
  if (s.type === "draw" && Array.isArray(s.points) && s.points.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pt of s.points) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
    const pad = (s.size || 4) * 2;
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
  }
  if (!p) return null; // unknown: keep it
  const w = s.width || (s.type === "text" ? 2400 : 400);
  let h = s.height;
  if (!h && s.type === "text") {
    const fs = s.fontSize || 16;
    const lines = String(s.text || "").split("\n").reduce((n, l) => n + 1 + Math.floor(l.length / 30), 0);
    h = lines * fs * 1.4 + fs;
  }
  return { minX: p.x, minY: p.y, maxX: p.x + w, maxY: p.y + (h || 400) };
}

/** The shapes inside the crop, and the edges touching them (with their
 *  far ends, so an arrow leaving the view still has both ends). */
function inView(scene) {
  const { camera } = scene;
  const z = camera.zoom;
  const margin = 40 / z;
  const view = {
    minX: -camera.x / z - margin, minY: -camera.y / z - margin,
    maxX: (CROP_W - camera.x) / z + margin, maxY: (CROP_H - camera.y) / z + margin,
  };
  const keep = new Set();
  for (const s of scene.shapes) {
    if (s.pocketed) continue;
    const b = roughBox(s);
    if (!b || (b.maxX >= view.minX && b.minX <= view.maxX && b.maxY >= view.minY && b.minY <= view.maxY)) keep.add(s.id);
  }
  const edges = (scene.flowEdges || []).filter((e) => keep.has(e.from) || keep.has(e.to));
  for (const e of edges) { keep.add(e.from); keep.add(e.to); }
  return { shapes: scene.shapes.filter((s) => keep.has(s.id) && !s.pocketed), edges };
}

/** Draw `scene` in light and dark: `{ light, dark }` data URLs, or null
 *  when nothing is in view. */
export function renderScene(scene) {
  if (!scene) return null;
  const { shapes, edges } = inView(scene);
  if (!shapes.length) return null;
  const scale = OUT_W / CROP_W;
  const draw = (theme) => {
    const out = document.createElement("canvas");
    out.width = OUT_W;
    out.height = OUT_H;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    renderForExport(ctx, CROP_W, CROP_H, {
      shapes,
      camera: scene.camera,
      imageCache: scene.imageCache,
      theme,
      backgroundPattern: "blank",
      gridSpacing: scene.gridSpacing,
      gridOpacity: 0,
      fontFamily: scene.fontFamily,
      layers: scene.layers,
      includeBackground: false,
      // Arrows at their on-screen width (the crop is drawn at the
      // camera's own zoom, then scaled down once).
      flowchart: snapshotFlowchart(shapes, edges, scene.fontFamily, scene.camera.zoom * scale, 1),
    });
    drawApproximateStrokes(ctx, shapes, scene.camera, theme);
    // PNG keeps the transparency (WebKit has no WebP encoder, and JPEG
    // has no alpha).
    try { return out.toDataURL("image/png"); } catch { return null; }
  };
  const light = draw(scene.themes.light);
  const dark = light && draw(scene.themes.dark);
  return light && dark ? { light, dark } : null;
}
