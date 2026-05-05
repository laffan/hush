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
    // Isometric grid: two diagonal sets of lines at ±30° plus a vertical
    // set, forming the classic 60° rhombic tiling. Spacing controls the
    // horizontal step between adjacent diagonals.
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    const tan30 = Math.tan(Math.PI / 6); // ≈ 0.5774
    // Horizontal step between parallel diagonals — measured along x at y=0.
    const stepX = scaledSize;
    // The diagonals have slope ±tan30, so a y-shift of h moves x by h*tan30.
    // Pick a starting x range wide enough that lines cover the whole canvas.
    const slack = h * tan30;
    const startX = Math.floor((-slack + (camera.x % stepX)) / stepX) * stepX - (camera.x % stepX);
    for (let x = startX; x < w + slack; x += stepX) {
      // line going down-right (positive slope when y increases downward)
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + h * tan30, h);
      ctx.stroke();
      // line going down-left
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x - h * tan30, h);
      ctx.stroke();
    }
    // Vertical lines at the same horizontal step align the rhombi into hexagons.
    for (let x = offsetX; x < w; x += stepX) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
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
