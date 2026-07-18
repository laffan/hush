import type { Bounds, Camera, ImageShape, SelectionBox, Shape } from "./types";
import type { CanvasTheme } from "./themes";
import { getShapeBounds } from "./utils";

/** Inset of the shadow-header text from the pane's left edge: 15px to the
 *  right of the gutter's red orientation rule (which sits at 20px). The
 *  headers are still fixed in screen space (horizontal pan doesn't move them)
 *  even though the rule pans with the canvas — that relationship is expected
 *  to change later. */
const SHADOW_HEADER_X = 35;

/** Draw faded doc headings inside a gutter pane. Drawn in screen space
 *  with manual vertical offset (cameraY) so the canvas scroll carries
 *  them along but horizontal camera-pan does not. A faint horizontal rule
 *  sits above each so the section break reads at a glance even off-screen
 *  horizontally. */
export function drawShadowHeaders(
  ctx: CanvasRenderingContext2D,
  headers: { y: number; level: number; text: string }[],
  theme: CanvasTheme,
  fontFamily: string,
  cameraY: number,
  canvasW: number,
  canvasH: number,
): void {
  ctx.save();
  ctx.textBaseline = "top";
  for (const h of headers) {
    const y = cameraY + h.y; // canvas-pixel y
    if (y < -40 || y > canvasH + 4) continue; // skip off-screen
    const fontPx = h.level <= 1 ? 18 : h.level === 2 ? 15 : 13;
    // Rule above the header text (4px gap), starting at the header inset.
    ctx.strokeStyle = theme.foreground;
    ctx.globalAlpha = 0.18;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(SHADOW_HEADER_X, y - 4);
    ctx.lineTo(canvasW, y - 4);
    ctx.stroke();
    // Header text
    ctx.fillStyle = theme.foreground;
    ctx.globalAlpha = 0.4;
    ctx.font = `600 ${fontPx}px ${fontFamily}, system-ui, sans-serif`;
    let text = h.text;
    const maxChars = Math.max(8, Math.floor((canvasW - SHADOW_HEADER_X - 8) / (fontPx * 0.55)));
    if (text.length > maxChars) text = text.slice(0, maxChars - 1) + "…";
    ctx.fillText(text, SHADOW_HEADER_X, y);
  }
  ctx.restore();
}

/** Translucent dashed ghost previewing where a reorder swap will land.
 *  Drawn in canvas space (caller has the world transform applied) so
 *  the dash scales with zoom — divide pattern + line width by zoom to
 *  match the rest of the selection chrome's screen-stable look. Two
 *  rects are shown: the dragged unit at the target's slot, and the
 *  target unit at the dragged unit's pre-drag slot. */
export function drawReorderPreview(
  ctx: CanvasRenderingContext2D,
  ghostA: Bounds,
  ghostB: Bounds,
  accentColor: string,
  zoom: number,
): void {
  ctx.save();
  ctx.setLineDash([6 / zoom, 4 / zoom]);
  ctx.lineWidth = 1.5 / zoom;
  ctx.strokeStyle = accentColor;
  for (const b of [ghostA, ghostB]) {
    ctx.beginPath();
    ctx.rect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = accentColor;
    ctx.fill();
    ctx.globalAlpha = 0.7;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.restore();
}

export function drawSelectionHighlight(ctx: CanvasRenderingContext2D, shape: Shape, zoom: number, accentColor: string, fontFamily?: string) {
  const bounds = getShapeBounds(shape, fontFamily);
  const pad = 6;
  const x1 = bounds.minX - pad, y1 = bounds.minY - pad;
  const w = bounds.maxX - bounds.minX + pad * 2;
  const h = bounds.maxY - bounds.minY + pad * 2;

  ctx.save();
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 1.5 / zoom;
  ctx.setLineDash([4 / zoom, 4 / zoom]);
  ctx.strokeRect(x1, y1, w, h);
  ctx.setLineDash([]);

  const handleSize = 7 / zoom;
  const half = handleSize / 2;
  const mx = x1 + w / 2, my = y1 + h / 2;
  const handles: [number, number][] = [
    [x1, y1], [x1 + w, y1], [x1, y1 + h], [x1 + w, y1 + h],
    [mx, y1], [mx, y1 + h], [x1, my], [x1 + w, my],
  ];
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 1.5 / zoom;
  for (const [hx, hy] of handles) {
    ctx.fillRect(hx - half, hy - half, handleSize, handleSize);
    ctx.strokeRect(hx - half, hy - half, handleSize, handleSize);
  }
  ctx.restore();
}

/** Stroke-specific selection highlight: a dashed bbox with no resize
 *  handles. DrawShapes can't be resized from the canvas renderer (the
 *  drawing engine owns transforms), so a handled highlight is just
 *  chrome that lies about what's interactive. */
export function drawStrokeBoundsHighlight(ctx: CanvasRenderingContext2D, shape: Shape, zoom: number, accentColor: string, fontFamily?: string) {
  const bounds = getShapeBounds(shape, fontFamily);
  const pad = 6;
  const x1 = bounds.minX - pad, y1 = bounds.minY - pad;
  const w = bounds.maxX - bounds.minX + pad * 2;
  const h = bounds.maxY - bounds.minY + pad * 2;
  ctx.save();
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 1.5 / zoom;
  ctx.setLineDash([4 / zoom, 4 / zoom]);
  ctx.strokeRect(x1, y1, w, h);
  ctx.setLineDash([]);
  ctx.restore();
}

export function drawGroupHighlight(ctx: CanvasRenderingContext2D, bounds: { minX: number; minY: number; maxX: number; maxY: number }, zoom: number, accentColor: string) {
  const pad = 14;
  const x1 = bounds.minX - pad, y1 = bounds.minY - pad;
  const w = bounds.maxX - bounds.minX + pad * 2;
  const h = bounds.maxY - bounds.minY + pad * 2;
  ctx.save();
  ctx.strokeStyle = accentColor;
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = 1 / zoom;
  ctx.setLineDash([6 / zoom, 4 / zoom]);
  ctx.strokeRect(x1, y1, w, h);
  ctx.setLineDash([]);
  ctx.restore();
}

export function drawSelectionBox(ctx: CanvasRenderingContext2D, box: SelectionBox, camera: Camera) {
  // The marquee is axis-aligned in *world* space, so paint it under the
  // full camera transform (which may include rotation) with widths
  // divided back out of the zoom.
  ctx.save();
  ctx.translate(camera.x, camera.y);
  if (camera.rotation) ctx.rotate(camera.rotation);
  ctx.scale(camera.zoom, camera.zoom);
  const x = Math.min(box.start.x, box.end.x);
  const y = Math.min(box.start.y, box.end.y);
  const w = Math.abs(box.end.x - box.start.x);
  const h = Math.abs(box.end.y - box.start.y);
  ctx.fillStyle = "rgba(66, 133, 244, 0.08)";
  ctx.strokeStyle = "#4285f4";
  ctx.lineWidth = 1 / camera.zoom;
  ctx.setLineDash([4 / camera.zoom, 4 / camera.zoom]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  ctx.restore();
}

export function drawCropOverlay(ctx: CanvasRenderingContext2D, shape: ImageShape, zoom: number) {
  // Show red border and handles on the image bounds during crop mode
  const pad = 2;
  const x = shape.position.x - pad, y = shape.position.y - pad;
  const w = shape.width + pad * 2, ht = shape.height + pad * 2;
  ctx.save();
  ctx.strokeStyle = "#ea4335";
  ctx.lineWidth = 2 / zoom;
  ctx.setLineDash([6 / zoom, 3 / zoom]);
  ctx.strokeRect(x, y, w, ht);
  ctx.setLineDash([]);
  // Red corner handles
  const handleSize = 8 / zoom;
  const half = handleSize / 2;
  const mx = x + w / 2, my = y + ht / 2;
  const handles: [number, number][] = [
    [x, y], [x + w, y], [x, y + ht], [x + w, y + ht],
    [mx, y], [mx, y + ht], [x, my], [x + w, my],
  ];
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#ea4335";
  ctx.lineWidth = 2 / zoom;
  for (const [hx, hy] of handles) {
    ctx.fillRect(hx - half, hy - half, handleSize, handleSize);
    ctx.strokeRect(hx - half, hy - half, handleSize, handleSize);
  }
  ctx.restore();
}

/** Small touch-friendly dot drawn at the midpoint of every flowchart edge
 *  (except the one currently revealed as a delete-X). Tapping the dot is
 *  the touch path to summoning the delete button — mouse users get the
 *  same affordance via hover. Rendered in screen space; the dot's hit
 *  target is the same 12 px-screen radius the X uses. */
export function drawEdgeDeleteDot(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  theme: CanvasTheme,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(sx, sy, 4, 0, Math.PI * 2);
  ctx.fillStyle = theme.uiBackground;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.foreground;
  ctx.globalAlpha = 0.6;
  ctx.stroke();
  ctx.restore();
}

/** Small circular X button drawn at the midpoint of a hovered flowchart
 *  edge. Rendered in screen space (caller passes pre-transformed sx/sy)
 *  so the affordance is a fixed size regardless of zoom. Click handling
 *  lives in DrawingState.handlePointerDown — that path hit-tests in
 *  canvas space against the same midpoint with a 12px-screen-radius
 *  threshold scaled by 1/zoom. */
export function drawEdgeDeleteButton(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  theme: CanvasTheme,
): void {
  const r = 9;
  ctx.save();
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fillStyle = theme.uiBackground;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.foreground;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sx - 3.5, sy - 3.5);
  ctx.lineTo(sx + 3.5, sy + 3.5);
  ctx.moveTo(sx + 3.5, sy - 3.5);
  ctx.lineTo(sx - 3.5, sy + 3.5);
  ctx.lineWidth = 1.4;
  ctx.lineCap = "round";
  ctx.strokeStyle = theme.foreground;
  ctx.stroke();
  ctx.restore();
}
