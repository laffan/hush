import type { Camera } from "./types";

export type BackgroundPatternKind =
  | "grid"
  | "dot-grid"
  | "lined"
  | "isometric"
  | "blank";

export function drawBackground(ctx: CanvasRenderingContext2D, camera: Camera, w: number, h: number, color: string, pattern: BackgroundPatternKind, spacing: number, opacity: number) {
  if (pattern === "blank") return;
  const scaledSize = spacing * camera.zoom;
  if (scaledSize < 6) return;
  const offsetX = camera.x % scaledSize;
  const offsetY = camera.y % scaledSize;
  ctx.save();
  ctx.globalAlpha = opacity;
  if (pattern === "grid") {
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    for (let x = offsetX; x < w; x += scaledSize) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = offsetY; y < h; y += scaledSize) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
  } else if (pattern === "lined") {
    // Lined paper: horizontal rule lines only, like a notebook page.
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    for (let y = offsetY; y < h; y += scaledSize) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
  } else if (pattern === "isometric") {
    // Isometric grid: two sets of diagonals at ±30° from horizontal,
    // anchored to a horizontal step. The cross-cutting vertical line
    // is intentionally absent — the diagonals alone read as classic
    // iso paper.
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    const tan30 = Math.tan(Math.PI / 6); // ≈ 0.5774
    // Vertical step between parallel diagonals — measured along y at x=0.
    // Lines slope at ±tan30 so an x-shift of w moves y by w * tan30.
    const stepY = scaledSize;
    const slack = w * tan30;
    const startY = Math.floor((-slack + (camera.y % stepY)) / stepY) * stepY - (camera.y % stepY);
    for (let y = startY; y < h + slack; y += stepY) {
      // line going right and down (positive slope, y increases as x grows)
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y + w * tan30);
      ctx.stroke();
      // line going right and up (negative slope)
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y - w * tan30);
      ctx.stroke();
    }
  } else {
    // dot-grid (default fallback)
    ctx.fillStyle = color;
    const radius = Math.max(0.8, scaledSize / 25);
    for (let x = offsetX; x < w; x += scaledSize) {
      for (let y = offsetY; y < h; y += scaledSize) {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}
