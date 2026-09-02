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
 * Four things bound that working set:
 *
 * 1. **A canvas with no box keeps nothing.** "Screens" is a meaningless
 *    unit for a canvas measuring 0×0, and the old reading of that case —
 *    return `null`, meaning keep everything — was exactly backwards: the
 *    canvases that measure zero are the ones detached from the document,
 *    which are showing the user nothing at all and were decoding whole
 *    fifty-page proofs to do it.
 * 2. **The ceiling is in pixels, because the memory is.** Counting
 *    images cannot express this: a proof page rasterises to 2800 ×
 *    ~3600 (`pdf-proofread.js#MAX_PAGE_RASTER_WIDTH`) — 10 MP, **40 MB**
 *    decoded — while a pasted screenshot is a fiftieth of that. A cap of
 *    "sixteen images" reads as modest and licenses two thirds of a
 *    gigabyte, which is what a fast zoom-out kept walking into: zooming
 *    out is the one gesture that grows the viewport, so it drives the
 *    keep set straight to whatever the cap allows.
 * 3. **Nothing new decodes mid-zoom.** A zoom sweep passes through
 *    twenty viewports the reader never looks at. Growing the set for
 *    each one spends the whole budget several times over in the seconds
 *    before any of it can be freed — so while the zoom is moving the set
 *    is what's on screen and nothing more, and the read-ahead refills
 *    once it settles.
 * 4. **The ceiling is shared.** Two columns of the same proof are two
 *    full sets of bitmaps, so each budgeted canvas takes a share of one
 *    global allowance rather than a whole allowance of its own.
 *
 * The ceiling says what may be *held*. It says nothing about how fast
 * the working set may turn over, and on a long proof that is the half
 * the reader feels — so admission and eviction are deliberately not
 * symmetric:
 *
 *  - **Admission is rate-limited, not just size-limited.** The keep set
 *    iterates nearest-first (see `imageKeepSet`) and the caller keeps at
 *    most `MAX_INFLIGHT_MEGAPIXELS` of them decoding at a time. A
 *    ceiling alone bounds what is resident and not what is *in flight*,
 *    and a wheel flick across ten pages turned the set over faster than
 *    the decodes finished — ten 40 MB buffers alive at once, several
 *    times the ceiling they were being admitted under. That peak is what
 *    iPadOS answers, and on a transparent window the answer looks like
 *    the page briefly not painting at all.
 *  - **What the ceiling can't hold is drawn small, not dropped.** Three
 *    sharp pages is all a fifty-page proof gets, and the fourth used to
 *    paint as the renderer's grey "broken image" card. Scrolling a proof
 *    therefore *flickered* — pages popping between paper and grey slab
 *    as the band slid over them — which reads as the canvas failing, and
 *    is most of what "scrolling is jerky" means here. A proof already
 *    carries a 480 px thumbnail of every page (baked for the rail), and
 *    a thumbnail is a **thirty-fourth** of a page, so a slice of the
 *    ceiling too small to hold one more page holds a dozen of them
 *    (`proxyReserve`). So the budget has two tiers — a narrow band
 *    of sharp pages inside a wide band of soft ones — the reader always
 *    sees their document, and the whole thing costs nothing against the
 *    ceiling, which matters because the configuration that needs it
 *    most (several proofs in a stack) is the one with no room to spare.
 *    Being able to fall back on the proxy is also what lets the page
 *    tier stay this tight without the tightness showing.
 *
 * Both rules come from `pdf/pdf-viewer-render.js`, which solved them for
 * the PDF viewer: rendering drains "a small priority queue ... with
 * limited concurrency ... so a fling never stacks up stale raster work",
 * and a drag "only *stretches* existing rasters" rather than showing the
 * reader a hole.
 */

import type { Camera, Shape } from "./types";
import { screenToCanvas } from "./utils";

/** Below this many image shapes the cache keeps everything — the
 *  bookkeeping isn't worth it, and a notebook with a dozen pasted
 *  images should never pay a re-decode for scrolling. */
export const IMAGE_BUDGET_THRESHOLD = 12;

/** Viewport multiples kept live beyond the visible rect, per side. */
const MARGIN_SCREENS = 1.5;

/** Decoded bitmap held at once across every budgeted canvas, in
 *  megapixels. RGBA, so 1 MP is 4 MB and this ceiling is ~160 MB.
 *
 *  Four proof pages, near enough. That is deliberately not much
 *  read-ahead — it is roughly a screen either side at zoom 1 — but the
 *  alternative is not "more read-ahead", it is the content process being
 *  killed: the drawing layer's own canvas backings already account for a
 *  few hundred MB before a single page decodes. Raise it only against a
 *  measurement of what the surface actually has left. */
export const MAX_DECODED_MEGAPIXELS = 40;

/** Floor on one canvas's share of the above, so a proof in a stack of
 *  three still decodes the page you are looking at. */
const MIN_DECODED_MEGAPIXELS = 12;

/** What an image not yet decoded is assumed to cost, in megapixels.
 *  Pessimistic on purpose — it is a proof page, the case that matters —
 *  and self-correcting: the visible rect is ranked first and so decodes
 *  regardless, and `costOf` reports its real size from then on. Also
 *  what the caller costs a cached image it has somehow never measured,
 *  so the two halves of the accounting agree. */
export const ASSUMED_MEGAPIXELS = 10;

const IS_IOS = typeof navigator !== "undefined" && (
  /iP(ad|hone|od)/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** Decoded bitmap allowed to be *arriving* at once, in megapixels.
 *
 *  The ceiling bounds what a canvas holds; this bounds what is on its
 *  way in, which is the other half of the same memory and the half
 *  nothing was counting. A flick down a fifty-page proof turns the keep
 *  set over faster than a 40 MB page decodes, so every pass started
 *  another one — for pages the camera had already passed — and the
 *  resident peak became the ceiling plus however many the gesture had
 *  managed to stack up. `pdf-viewer-render.js` bounds its render queue
 *  the same way ("a fling never stacks up stale raster work").
 *
 *  In megapixels rather than in images, for the reason the ceiling is:
 *  one proof page is fifty pasted screenshots. 12 is one page at a time
 *  on iOS and two elsewhere, while a Desktop's thumbnails — a fiftieth
 *  the size — still go in a batch. */
export const MAX_INFLIGHT_MEGAPIXELS = IS_IOS ? 12 : 24;

/** Ceiling on what `proxyReserve` will set aside for the proxy tier,
 *  in megapixels. A proof page's thumbnail is 480 px wide
 *  (`pdf-proofread.js`), so 6 MP is about twenty pages.
 *
 *  Sized for the worst case the page tier has to cope with rather than
 *  for ordinary reading: splits can put fifteen pages on screen at zoom
 *  0.25, and a soft tier that can't cover what is *visible* leaves
 *  exactly the holes it exists to fill. Ordinary reading uses a third
 *  of it. It comes out of the page tier's own ceiling, not on top —
 *  see `proxyReserve`. */
export const MAX_PROXY_MEGAPIXELS = 6;

/** Proxy read-ahead, in viewport multiples per side. Far wider than the
 *  page tier's, because that is the whole point of it: the band a
 *  fifty-page proof can hold *sharp* is three pages, and the band it can
 *  hold *at all* is most of a chapter. */
export const PROXY_MARGIN_SCREENS = 8;

/** What a thumbnail not yet decoded is assumed to cost. A page's is
 *  480 × ~620 (`pdf-proofread.js#THUMB_RASTER_WIDTH`); rounding up keeps
 *  the first pass from over-admitting before anything has been
 *  measured. */
export const ASSUMED_PROXY_MEGAPIXELS = 0.35;

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

/** One canvas's share of the global decode allowance, in megapixels. */
export function imageBudgetShare(budgetedCanvases: number): number {
  const n = Math.max(1, budgetedCanvases);
  return Math.max(MIN_DECODED_MEGAPIXELS, MAX_DECODED_MEGAPIXELS / n);
}

/** Megapixels set aside out of a canvas's `share` for the proxy tier —
 *  taken off the page tier's ceiling before it admits anything, so the
 *  two tiers together never exceed the share and the whole two-tier
 *  scheme costs nothing against the global ceiling.
 *
 *  **Reserved, not left over.** Sizing the soft tier from whatever the
 *  page tier didn't spend sounds tidier and fails in the one state that
 *  matters: pages are admitted at `ASSUMED_MEGAPIXELS` until they have
 *  been measured, so a scroll into fresh pages fills the share exactly,
 *  leaves no slack, and the soft tier vanishes — during scrolling,
 *  which is the only time anything needed it.
 *
 *  **Zero whenever the ceiling is shared.** `MIN_DECODED_MEGAPIXELS` is
 *  a floor under each canvas's share, so with several budgeted canvases
 *  the shares already sum past the global ceiling and a reserve on each
 *  is memory the old policy never took. Several proofs in a stack is
 *  also the tightest thing the app can be asked to hold — three columns
 *  is three drawing layers before a page decodes — and a soft tier is a
 *  comfort, which is the first thing to give up when documents are
 *  sharing memory. A stack therefore gets exactly the page tier, and
 *  exactly the footprint it had before this tier existed. */
export function proxyReserve(share: number, budgetedCanvases: number): number {
  if (budgetedCanvases > 1) return 0;
  // Never more than a quarter of the share, so the reserve can't crowd
  // out the pages on a canvas with a small one.
  return Math.min(MAX_PROXY_MEGAPIXELS, share / 4);
}

/** Gap between a shape's world rect and the visible rect — 0 when they
 *  overlap, otherwise the larger of the two axis gaps. Used only to rank
 *  candidates, so the cheap metric is the right one. */
function gapToView(
  x0: number, y0: number, x1: number, y1: number,
  view: { minX: number; minY: number; maxX: number; maxY: number },
): number {
  const dx = Math.max(0, view.minX - x1, x0 - view.maxX);
  const dy = Math.max(0, view.minY - y1, y0 - view.maxY);
  return Math.max(dx, dy);
}

export interface KeepSetOptions {
  /** Megapixels this canvas may hold decoded. */
  maxMegapixels?: number;
  /** Measured decoded size of an image, in megapixels — whatever the
   *  caller has actually seen. Undefined for one never decoded here,
   *  which is costed at `assumedMegapixels`. Callers should remember
   *  measurements across an eviction: costing a page as a guess while it
   *  is out and as its real size while it is in makes the budget
   *  oscillate around the boundary. */
  costOf?: (id: string) => number | undefined;
  /** False while the camera is mid-zoom: keep what is on screen and
   *  nothing else, and let the read-ahead refill when it settles. */
  readAhead?: boolean;
  /** Viewport multiples kept beyond the visible rect, per side. The
   *  proxy tier reads much further ahead than the page tier — its
   *  entries cost a thirty-fourth as much, so the band that is worth
   *  holding is correspondingly wider. */
  marginScreens?: number;
  /** Cost assumed for an entry the caller has never measured. */
  assumedMegapixels?: number;
}

/**
 * Image-shape ids worth holding decoded right now, or `null` when the
 * notebook is small enough that everything stays.
 *
 * Shapes with no bytes yet (a Desktop thumbnail mid-hydration) are
 * always kept: they cost nothing decoded and dropping them would restart
 * a load that is already in flight.
 *
 * Candidates are ranked — everything on screen first, nearest to the
 * middle of it, then the read-ahead band by distance — and admitted
 * while the budget lasts. Ranking rather than exempting the visible rect
 * matters at the far end of the zoom range: a fifty-page proof whose
 * pages have been pulled apart by splits can put fifteen pages on screen
 * at zoom 0.25, which is six hundred megabytes if "visible" means
 * "always decoded". Placeholder cards over the pages furthest from where
 * the reader is looking is a bad outcome; dying is a worse one. The
 * nearest image is always admitted, whatever it costs, so a canvas can
 * never paint nothing at all.
 *
 * **The returned set iterates in that rank order**, and the caller's
 * decode queue depends on it: with only `MAX_INFLIGHT_MEGAPIXELS`
 * decoding at a time, the order the ids come out in is the order the
 * reader gets their pages back. (Shapes with no bytes and pocketed ones
 * are added ahead of the ranking, which costs nothing — neither starts a
 * page decode.)
 */
export function imageKeepSet(
  shapes: Shape[],
  camera: Camera,
  canvasW: number,
  canvasH: number,
  opts?: KeepSetOptions,
): Set<string> | null {
  const maxMegapixels = opts?.maxMegapixels ?? MAX_DECODED_MEGAPIXELS;
  const readAhead = opts?.readAhead !== false;
  const costOf = opts?.costOf;
  const marginScreens = opts?.marginScreens ?? MARGIN_SCREENS;
  const assumed = opts?.assumedMegapixels ?? ASSUMED_MEGAPIXELS;
  if (!needsImageBudget(shapes)) return null;
  // No box: nothing is on screen, so nothing needs to be decoded. This
  // is the detached-canvas case (a torn-down column, a surface replaced
  // mid-load) as well as the pre-layout one, and both want the same
  // answer. The first frame after layout recomputes — `BudgetView`
  // carries the box so a resize alone invalidates the set.
  if (!canvasW || !canvasH) return new Set();

  const view = viewportWorldRect(camera, canvasW, canvasH);
  const padX = (view.maxX - view.minX) * marginScreens;
  const padY = (view.maxY - view.minY) * marginScreens;
  const minX = view.minX - padX, maxX = view.maxX + padX;
  const minY = view.minY - padY, maxY = view.maxY + padY;

  const cx = (view.minX + view.maxX) / 2, cy = (view.minY + view.maxY) / 2;

  const keep = new Set<string>();
  const ranked: { id: string; onScreen: number; dist: number; mp: number }[] = [];
  for (const s of shapes) {
    if (s.type !== "image") continue;
    if (!s.dataUrl) { keep.add(s.id); continue; }
    // Pocketed shapes render in screen space from the tray, so their
    // world position says nothing about whether they're visible.
    if (s.pocketed) { keep.add(s.id); continue; }
    const x0 = s.position.x, y0 = s.position.y;
    const x1 = x0 + s.width, y1 = y0 + s.height;
    if (x1 < minX || x0 > maxX || y1 < minY || y0 > maxY) continue;
    const onScreen = gapToView(x0, y0, x1, y1, view) === 0 ? 0 : 1;
    if (onScreen && !readAhead) continue;
    ranked.push({
      id: s.id,
      onScreen,
      dist: Math.hypot((x0 + x1) / 2 - cx, (y0 + y1) / 2 - cy),
      mp: costOf?.(s.id) ?? assumed,
    });
  }

  // On screen first, then nearest, and admit while the budget lasts.
  // Skipping rather than stopping at the first item that doesn't fit
  // lets a later, cheaper one in — the ordering already put the
  // important ones first, so nothing distant can displace anything.
  ranked.sort((a, b) => (a.onScreen - b.onScreen) || (a.dist - b.dist));
  let used = 0;
  for (const c of ranked) {
    if (used > 0 && used + c.mp > maxMegapixels) continue;
    used += c.mp;
    keep.add(c.id);
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
