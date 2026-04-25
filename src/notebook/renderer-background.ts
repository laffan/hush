import type { Camera } from "./types";

export function drawBackground(ctx: CanvasRenderingContext2D, camera: Camera, w: number, h: number, color: string, pattern: "grid" | "dot-grid", spacing: number, opacity: number) {
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
  } else {
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
