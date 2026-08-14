/**
 * Viewport-aware image budget.
 *
 * The canvas's image cache holds one decoded `HTMLImageElement` per
 * ImageShape, which is the right trade for an ordinary notebook: a
 * handful of pasted screenshots, decoded once, drawn for free forever.
 *
 * A PDF proof breaks that assumption. Fifty full-size page rasters
 * decode to roughly 8 MB of bitmap each — around 400 MB resident before
 * a single stroke is drawn, which is past what iPadOS will hand a
 * WKWebView. So above a threshold the cache stops being "every image"
 * and becomes "every image near the viewport", with everything else
 * dropped and re-decoded on the way back.
 *
 * The margin is deliberately generous — a screen and a half in every
 * direction — because decoding is the expensive half and re-decoding a
 * page the user merely scrolled past is exactly the thrash worth paying
 * memory to avoid. It mirrors the PDF viewer's own policy in
 * `pdf/pdf-viewer-render.js`: keep a working set, evict at distance,
 * never per frame.
 */

import type { Camera, Shape } from "./types";
import { screenToCanvas } from "./utils";

/** Below this many image shapes the cache keeps everything — the
 *  bookkeeping isn't worth it, and a notebook with a dozen pasted
 *  images should never pay a re-decode for scrolling. */
export const IMAGE_BUDGET_THRESHOLD = 12;

/** Viewport multiples kept live beyond the visible rect, per side. */
const MARGIN_SCREENS = 1.5;

/** World rect currently on screen, corner-derived so canvas rotation is
 *  handled without a special case. */
function viewportWorldRect(camera: Camera, w: number, h: number) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [sx, sy] of [[0, 0], [w, 0], [0, h], [w, h]] as const) {
    const p = screenToCanvas({ x: sx, y: sy }, camera);
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Image-shape ids worth holding decoded right now, or `null` when the
 * notebook is small enough that everything stays.
 *
 * Shapes with no bytes yet (a Desktop thumbnail mid-hydration) are
 * always kept: they cost nothing decoded and dropping them would restart
 * a load that is already in flight.
 */
export function imageKeepSet(
  shapes: Shape[],
  camera: Camera,
  canvasW: number,
  canvasH: number,
): Set<string> | null {
  let imageCount = 0;
  for (const s of shapes) if (s.type === "image") imageCount++;
  if (imageCount <= IMAGE_BUDGET_THRESHOLD) return null;
  if (!canvasW || !canvasH) return null;

  const view = viewportWorldRect(camera, canvasW, canvasH);
  const padX = (view.maxX - view.minX) * MARGIN_SCREENS;
  const padY = (view.maxY - view.minY) * MARGIN_SCREENS;
  const minX = view.minX - padX, maxX = view.maxX + padX;
  const minY = view.minY - padY, maxY = view.maxY + padY;

  const keep = new Set<string>();
  for (const s of shapes) {
    if (s.type !== "image") continue;
    if (!s.dataUrl) { keep.add(s.id); continue; }
    // Pocketed shapes render in screen space from the tray, so their
    // world position says nothing about whether they're visible.
    if (s.pocketed) { keep.add(s.id); continue; }
    const x0 = s.position.x, y0 = s.position.y;
    const x1 = x0 + s.width, y1 = y0 + s.height;
    if (x1 >= minX && x0 <= maxX && y1 >= minY && y0 <= maxY) keep.add(s.id);
  }
  return keep;
}

/**
 * True when the camera has drifted far enough since `since` that the
 * keep set is worth recomputing. Recomputing on every pan frame would
 * walk the shape list at 60 Hz for a result that changes once per
 * half-screen of travel.
 */
export function budgetNeedsRecompute(since: Camera | null, now: Camera, canvasW: number, canvasH: number): boolean {
  if (!since) return true;
  if (since.zoom !== now.zoom || (since.rotation || 0) !== (now.rotation || 0)) return true;
  const dx = Math.abs(since.x - now.x), dy = Math.abs(since.y - now.y);
  return dx > canvasW * 0.5 || dy > canvasH * 0.5;
}
