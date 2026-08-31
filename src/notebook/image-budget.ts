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
 *
 * Three things bound that working set, and all three exist because a
 * proof can be opened more than once at a time (two stack columns, a
 * column and a pane, a pane over the main canvas):
 *
 * 1. **A canvas with no box keeps nothing.** "Screens" is a meaningless
 *    unit for a canvas measuring 0×0, and the old reading of that case —
 *    return `null`, meaning keep everything — was exactly backwards: the
 *    canvases that measure zero are the ones detached from the document,
 *    which are showing the user nothing at all and were decoding whole
 *    fifty-page proofs to do it.
 * 2. **A hard cap on the margin.** The visible rect is never sacrificed
 *    — whatever is on screen decodes, however much of it there is — but
 *    the read-ahead band around it is capped by count, so zooming out
 *    can't quietly widen the working set to the whole document.
 * 3. **The cap is shared.** Two columns of the same proof are two full
 *    sets of bitmaps, so each budgeted canvas takes a share of one
 *    global allowance rather than a whole allowance of its own.
 */

import type { Camera, Shape } from "./types";
import { screenToCanvas } from "./utils";

/** Below this many image shapes the cache keeps everything — the
 *  bookkeeping isn't worth it, and a notebook with a dozen pasted
 *  images should never pay a re-decode for scrolling. */
export const IMAGE_BUDGET_THRESHOLD = 12;

/** Viewport multiples kept live beyond the visible rect, per side. */
const MARGIN_SCREENS = 1.5;

/** Read-ahead images held decoded at once across every budgeted canvas.
 *  Sized against the surface that motivated the budget: a proof page is
 *  ~2.5 MP decoded, so this is a ceiling of roughly 160 MB of margin.
 *  Generous on purpose — it is a backstop against a pathological camera,
 *  not the mechanism that decides what a reader sees. */
export const MAX_DECODED_IMAGES = 16;

/** Floor on one canvas's share of the above, so a stack of proofs still
 *  reads ahead rather than re-decoding on every scroll frame. */
const MIN_DECODED_IMAGES = 6;

/** Zoom ratio that has to be exceeded before the keep set is recomputed.
 *  Recomputing on every zoom step is what a trackpad pinch does sixty
 *  times a second, and each recompute can evict and immediately
 *  re-decode a page — the margin is a screen and a half, so it absorbs
 *  far more than this much drift without going stale. */
const ZOOM_RECOMPUTE_RATIO = 1.15;

/** What the budget was computed against: the camera *and* the box it was
 *  measured in. A canvas that is laid out after its first frame changes
 *  the second without touching the first. */
export interface BudgetView {
  camera: Camera;
  w: number;
  h: number;
}

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

/** True when this notebook holds enough images to be worth budgeting. */
export function needsImageBudget(shapes: Shape[]): boolean {
  let count = 0;
  for (const s of shapes) {
    if (s.type !== "image") continue;
    if (++count > IMAGE_BUDGET_THRESHOLD) return true;
  }
  return false;
}

/** One canvas's share of the global read-ahead allowance. */
export function imageBudgetShare(budgetedCanvases: number): number {
  const n = Math.max(1, budgetedCanvases);
  return Math.max(MIN_DECODED_IMAGES, Math.floor(MAX_DECODED_IMAGES / n));
}

/** Gap between a shape's world rect and the visible rect — 0 when they
 *  overlap, otherwise the larger of the two axis gaps. Used only to rank
 *  read-ahead candidates, so the cheap metric is the right one. */
function gapToView(
  x0: number, y0: number, x1: number, y1: number,
  view: { minX: number; minY: number; maxX: number; maxY: number },
): number {
  const dx = Math.max(0, view.minX - x1, x0 - view.maxX);
  const dy = Math.max(0, view.minY - y1, y0 - view.maxY);
  return Math.max(dx, dy);
}

/**
 * Image-shape ids worth holding decoded right now, or `null` when the
 * notebook is small enough that everything stays.
 *
 * Shapes with no bytes yet (a Desktop thumbnail mid-hydration) are
 * always kept: they cost nothing decoded and dropping them would restart
 * a load that is already in flight.
 *
 * `maxDecoded` caps the *read-ahead* only. Everything intersecting the
 * visible rect is kept unconditionally, however many that is — a cap
 * that could drop something on screen would paint placeholder cards over
 * a notebook the user is looking at, which is a worse bug than the one
 * the budget exists to fix.
 */
export function imageKeepSet(
  shapes: Shape[],
  camera: Camera,
  canvasW: number,
  canvasH: number,
  maxDecoded: number = MAX_DECODED_IMAGES,
): Set<string> | null {
  if (!needsImageBudget(shapes)) return null;
  // No box: nothing is on screen, so nothing needs to be decoded. This
  // is the detached-canvas case (a torn-down column, a surface replaced
  // mid-load) as well as the pre-layout one, and both want the same
  // answer. The first frame after layout recomputes — `BudgetView`
  // carries the box so a resize alone invalidates the set.
  if (!canvasW || !canvasH) return new Set();

  const view = viewportWorldRect(camera, canvasW, canvasH);
  const padX = (view.maxX - view.minX) * MARGIN_SCREENS;
  const padY = (view.maxY - view.minY) * MARGIN_SCREENS;
  const minX = view.minX - padX, maxX = view.maxX + padX;
  const minY = view.minY - padY, maxY = view.maxY + padY;

  const keep = new Set<string>();
  const nearby: { id: string; gap: number }[] = [];
  for (const s of shapes) {
    if (s.type !== "image") continue;
    if (!s.dataUrl) { keep.add(s.id); continue; }
    // Pocketed shapes render in screen space from the tray, so their
    // world position says nothing about whether they're visible.
    if (s.pocketed) { keep.add(s.id); continue; }
    const x0 = s.position.x, y0 = s.position.y;
    const x1 = x0 + s.width, y1 = y0 + s.height;
    if (x1 < minX || x0 > maxX || y1 < minY || y0 > maxY) continue;
    const gap = gapToView(x0, y0, x1, y1, view);
    if (gap === 0) keep.add(s.id);
    else nearby.push({ id: s.id, gap });
  }

  // Fill the rest of the allowance with the read-ahead band, nearest
  // first, so what survives a cap is what the reader reaches next.
  if (keep.size < maxDecoded) {
    nearby.sort((a, b) => a.gap - b.gap);
    for (const n of nearby) {
      if (keep.size >= maxDecoded) break;
      keep.add(n.id);
    }
  }
  return keep;
}

/**
 * True when the view has moved far enough since `since` that the keep
 * set is worth recomputing. Recomputing on every pan frame would walk
 * the shape list at 60 Hz for a result that changes once per half-screen
 * of travel; recomputing on every zoom step would do the same, and evict
 * and re-decode pages while it was at it.
 */
export function budgetNeedsRecompute(since: BudgetView | null, now: BudgetView): boolean {
  if (!since) return true;
  // A canvas that has just been laid out (or resized, or detached) is
  // measuring a different viewport, whatever the camera says.
  if (since.w !== now.w || since.h !== now.h) return true;
  const a = since.camera, b = now.camera;
  if ((a.rotation || 0) !== (b.rotation || 0)) return true;
  const ratio = b.zoom / a.zoom;
  if (!(ratio < ZOOM_RECOMPUTE_RATIO && ratio > 1 / ZOOM_RECOMPUTE_RATIO)) return true;
  // Travel is measured in *world* px, against a half-screen of world.
  // `camera.x/y` is a screen-space offset, so comparing it directly made
  // the threshold depend on where in the document the reader was: pivot
  // zoom scales the offset along with everything else, and twenty pages
  // down a proof `camera.y` is tens of thousands of px, so a 2 % pinch
  // step moved it by more than a screen and forced a recompute — the
  // ratio test above bought nothing, and a fast pinch still evicted and
  // re-decoded pages sixty times a second. In world units the same step
  // barely moves the viewport, which is the truth of it.
  const wx = Math.abs(a.x / a.zoom - b.x / b.zoom);
  const wy = Math.abs(a.y / a.zoom - b.y / b.zoom);
  return wx > (now.w * 0.5) / b.zoom || wy > (now.h * 0.5) / b.zoom;
}
