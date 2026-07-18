import type { Camera } from "./types";

export interface BackgroundImageConfig {
  enabled?: boolean;
  src?: string;
  fit?: string;     // "cover" | "contain" | "100% 100%" | "auto"
  repeat?: string;  // "no-repeat" | "repeat" | "repeat-x" | "repeat-y"
  blend?: string;   // CSS mix-blend-mode value
  opacity?: number;
  invert?: boolean; // resolved per-appearance: paint the image inverted
}

const bgImageCache = new Map<string, HTMLImageElement>();

/** Loaded image for `src`, kicking off a load (and `onReady` redraw on
 *  completion) the first time. Returns null until decoded. */
function getBgImage(src: string, onReady: () => void): HTMLImageElement | null {
  const cached = bgImageCache.get(src);
  if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : null;
  const img = new Image();
  img.onload = () => onReady();
  img.src = src;
  bgImageCache.set(src, img);
  return null;
}

/** Draw a style's background image in screen space (fills the viewport),
 *  composited over the solid canvas fill and beneath the grid pattern.
 *  `w`/`h` are CSS pixels; the caller's transform is screen-space. */
export function drawBackgroundImage(
  ctx: CanvasRenderingContext2D,
  bi: BackgroundImageConfig | null | undefined,
  w: number, h: number,
  onReady: () => void,
) {
  if (!bi || !bi.enabled || !bi.src) return;
  const img = getBgImage(bi.src, onReady);
  if (!img) return;
  ctx.save();
  ctx.globalAlpha = bi.opacity != null ? bi.opacity : 1;
  if (bi.blend && bi.blend !== "normal") {
    ctx.globalCompositeOperation = bi.blend as GlobalCompositeOperation;
  }
  if (bi.invert) ctx.filter = "invert(1)";
  const repeat = bi.repeat || "no-repeat";
  if (repeat !== "no-repeat") {
    const rep = repeat === "repeat-x" ? "repeat-x" : repeat === "repeat-y" ? "repeat-y" : "repeat";
    const pat = ctx.createPattern(img, rep);
    if (pat) { ctx.fillStyle = pat; ctx.fillRect(0, 0, w, h); }
  } else {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const fit = bi.fit || "cover";
    let dw = w, dh = h, dx = 0, dy = 0;
    if (fit === "cover" || fit === "contain") {
      const scale = fit === "contain" ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
      dw = iw * scale; dh = ih * scale; dx = (w - dw) / 2; dy = (h - dh) / 2;
    } else if (fit === "auto") {
      dw = iw; dh = ih; dx = (w - dw) / 2; dy = (h - dh) / 2;
    } // "100% 100%" (stretch) → fill the viewport
    ctx.drawImage(img, dx, dy, dw, dh);
  }
  ctx.restore();
}

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
  ctx.save();
  ctx.globalAlpha = opacity;
  // "Pattern space" is screen space counter-rotated by the camera's
  // rotation: the world grid is axis-aligned there and scaled by zoom.
  // Unrotated cameras keep the identity frame — px0..py1 collapse to
  // the plain viewport and the loops below match the original code.
  const rot = camera.rotation || 0;
  let px0 = 0, py0 = 0, px1 = w, py1 = h;   // pattern-space viewport AABB
  let anchorX = camera.x, anchorY = camera.y; // world origin in pattern space
  if (rot) {
    ctx.rotate(rot);
    const cos = Math.cos(rot), sin = Math.sin(rot);
    px0 = Infinity; py0 = Infinity; px1 = -Infinity; py1 = -Infinity;
    for (const [sx, sy] of [[0, 0], [w, 0], [0, h], [w, h]] as const) {
      const x = sx * cos + sy * sin;
      const y = -sx * sin + sy * cos;
      if (x < px0) px0 = x; if (x > px1) px1 = x;
      if (y < py0) py0 = y; if (y > py1) py1 = y;
    }
    anchorX = camera.x * cos + camera.y * sin;
    anchorY = -camera.x * sin + camera.y * cos;
  }
  // First grid line at or below the AABB's min edge, phase-locked to
  // the world origin (anchor ≡ world 0,0 in pattern space).
  const gridStart = (min: number, anchor: number) =>
    min + ((((anchor - min) % scaledSize) + scaledSize) % scaledSize) - scaledSize;
  const startX = gridStart(px0, anchorX);
  const startY = gridStart(py0, anchorY);
  if (pattern === "grid") {
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    for (let x = startX; x < px1; x += scaledSize) {
      ctx.beginPath(); ctx.moveTo(x, py0); ctx.lineTo(x, py1); ctx.stroke();
    }
    for (let y = startY; y < py1; y += scaledSize) {
      ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke();
    }
  } else if (pattern === "lined") {
    // Lined paper: horizontal rule lines only, like a notebook page.
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    for (let y = startY; y < py1; y += scaledSize) {
      ctx.beginPath(); ctx.moveTo(px0, y); ctx.lineTo(px1, y); ctx.stroke();
    }
  } else if (pattern === "isometric") {
    // Isometric grid: two sets of diagonals at ±30° from horizontal,
    // anchored to a horizontal step. The cross-cutting vertical line
    // is intentionally absent — the diagonals alone read as classic
    // iso paper.
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    const tan30 = Math.tan(Math.PI / 6); // ≈ 0.5774
    // Vertical step between parallel diagonals — measured along y at
    // the AABB's left edge. Lines slope at ±tan30 so an x-span of
    // (px1 - px0) moves y by that span * tan30.
    const span = px1 - px0;
    const slack = span * tan30;
    for (let y = startY - Math.ceil(slack / scaledSize) * scaledSize; y < py1 + slack; y += scaledSize) {
      // line going right and down (positive slope, y increases as x grows)
      ctx.beginPath();
      ctx.moveTo(px0, y);
      ctx.lineTo(px1, y + slack);
      ctx.stroke();
      // line going right and up (negative slope)
      ctx.beginPath();
      ctx.moveTo(px0, y);
      ctx.lineTo(px1, y - slack);
      ctx.stroke();
    }
  } else {
    // dot-grid (default fallback)
    ctx.fillStyle = color;
    const radius = Math.max(0.8, scaledSize / 25);
    for (let x = startX; x < px1; x += scaledSize) {
      for (let y = startY; y < py1; y += scaledSize) {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}
