import type { Camera, Shape, Layer } from "./types";
import type { CanvasTheme } from "./themes";
import type { FlowchartLayer } from "./flowchart";
import { drawBackground } from "./renderer-background";
import { drawDragArea, drawTextShape, drawImageShape } from "./renderer";

/** Paint shapes + (optional) background into an arbitrary ctx at an
 *  arbitrary camera. Skips every piece of editor chrome — selection
 *  highlights, creating-drag-area preview, selection box, pocket tray,
 *  pocketed cards. Used by the notebook export path. The caller owns
 *  the ctx's base transform; `outWidth`/`outHeight` describe the
 *  target surface in CSS pixels. Drawing strokes are NOT painted here —
 *  the export path blits them from the drawing layer's done canvas
 *  afterwards. */
export function renderForExport(
  ctx: CanvasRenderingContext2D,
  outWidth: number,
  outHeight: number,
  opts: {
    shapes: Shape[];
    camera: Camera;
    imageCache: Map<string, HTMLImageElement>;
    theme: CanvasTheme;
    backgroundPattern: "grid" | "dot-grid" | "blank";
    gridSpacing: number;
    gridOpacity: number;
    fontFamily: string;
    layers?: Layer[];
    includeBackground: boolean;
    canvasBackgroundOverride?: string;
    flowchart?: FlowchartLayer<Shape>;
    /** Skip text glyphs (decorations stay). Used by the PDF exporter, which lays vector text on top. */
    omitTextGlyphs?: boolean;
  },
): void {
  const { shapes, camera, imageCache, theme, backgroundPattern, gridSpacing, gridOpacity, fontFamily, layers, includeBackground, canvasBackgroundOverride, flowchart, omitTextGlyphs } = opts;

  if (includeBackground) {
    ctx.fillStyle = canvasBackgroundOverride || theme.canvasBackground;
    ctx.fillRect(0, 0, outWidth, outHeight);
    if (backgroundPattern !== "blank" && gridOpacity > 0) {
      drawBackground(ctx, camera, outWidth, outHeight, theme.foreground, backgroundPattern, gridSpacing, gridOpacity * 0.8);
    }
  }

  ctx.save();
  ctx.translate(camera.x, camera.y);
  ctx.scale(camera.zoom, camera.zoom);

  const layerOrder: { id: string; hidden: boolean }[] = layers && layers.length
    ? [...layers].reverse().map((l) => ({ id: l.id, hidden: l.hidden }))
    : [{ id: "__single__", hidden: false }];
  const shapesByLayer = new Map<string, Shape[]>();
  for (const l of layerOrder) shapesByLayer.set(l.id, []);
  for (const s of shapes) {
    if (s.pocketed) continue;
    const bucketId = layers && layers.length ? (s.layerId || layerOrder[layerOrder.length - 1].id) : "__single__";
    const bucket = shapesByLayer.get(bucketId) || shapesByLayer.get(layerOrder[layerOrder.length - 1].id);
    if (bucket) bucket.push(s);
  }

  // Match the live render's z-order: drag-areas across every layer, then
  // flowchart arrows (so they emerge from behind text/image boxes), then
  // text/image shapes across every layer.
  for (const layer of layerOrder) {
    if (layer.hidden) continue;
    const layerShapes = shapesByLayer.get(layer.id);
    if (!layerShapes || !layerShapes.length) continue;
    for (const shape of layerShapes) {
      if (shape.type === "drag-area") drawDragArea(ctx, shape);
    }
  }

  if (flowchart) {
    flowchart.setArrowColor(theme.foreground);
    flowchart.draw(ctx, shapes.filter((s) => !s.pocketed));
  }

  for (const layer of layerOrder) {
    if (layer.hidden) continue;
    const layerShapes = shapesByLayer.get(layer.id);
    if (!layerShapes || !layerShapes.length) continue;
    for (const shape of layerShapes) {
      if (shape.type === "drag-area") continue;
      if (shape.type === "draw") continue;
      if (shape.type === "text") drawTextShape(ctx, shape, theme, fontFamily, omitTextGlyphs);
      else if (shape.type === "image") drawImageShape(ctx, shape, imageCache, false);
    }
  }

  ctx.restore();
}
