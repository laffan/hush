import type { Camera, ImageShape, SelectionBox, Shape } from "./types";
import type { CanvasTheme } from "./themes";
import { getShapeBounds } from "./utils";

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
  const x1 = box.start.x * camera.zoom + camera.x;
  const y1 = box.start.y * camera.zoom + camera.y;
  const x2 = box.end.x * camera.zoom + camera.x;
  const y2 = box.end.y * camera.zoom + camera.y;
  ctx.save();
  ctx.fillStyle = "rgba(66, 133, 244, 0.08)";
  ctx.strokeStyle = "#4285f4";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
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
