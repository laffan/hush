/**
 * The scroll area's layout for the viewer's modes: the CSS layout class
 * each one uses (pdf-viewer.css), the scale it fits pages at, and the
 * paged view's spacing and wheel. The modes themselves — which one is
 * on, and switching between them — are pdf-viewer.js's.
 *
 * **The paged view** ("Paged" on the toolbar, against "Continuous"): one
 * set of pages at a time — one, two or three, as the fit buttons say —
 * fitted whole and centred, and a swipe moves exactly one set: left /
 * right when the pages run side by side, up / down when they run top to
 * bottom (in rows of the set's size). ("fixed" is the fixed-zoom layout,
 * pages wrapping in rows at a set zoom.)
 *
 * The pages stay the one strip the continuous view uses, so the
 * renderer, links, search, bookmarks and annotations work unchanged; CSS
 * scroll snapping does the paging (`.pdf-paged`): each set's first page
 * is a snap point, and scroll-padding centres the set on it. A swipe, a
 * trackpad flick, the arrow keys and a scrollbar drag all come to rest
 * on a set, and `scroll-snap-stop` keeps a hard flick from skipping past
 * the next one. The space between sets is just wide enough to keep the
 * neighbours out of sight, so a swipe travels about one view.
 *
 * A set is fitted to all of the view but a hair (`PAGED_PAD`): the
 * reading is the point, so there is no frame of margin around it, and
 * the pages of a set sit `SET_GAP` apart.
 */
import { cropWrapper, croppedSize } from "./pdf-viewer-crop.js";

/** Pages side by side within a set (pdf-viewer.css matches it). */
export const SET_GAP = 4;
/** The room left around a set, both ways together (CSS px). */
export const PAGED_PAD = 8;

const LAYOUT_CLASSES = [
  "pdf-layout-fit", "pdf-layout-fixed", "pdf-layout-horizontal", "pdf-layout-folded", "pdf-layout-pagedv",
  "pdf-paged", "pdf-paged-1", "pdf-paged-2", "pdf-paged-3", "pdf-cropped",
];

/**
 * The layout state the helpers below read:
 * `{ layoutMode, fitMode, folded, paged, perSet, foldedZoom, fixedZoom, crop }`
 * — `paged` the paged view is on (never while folded or at a fixed
 * zoom), `perSet` its pages to a set, `crop` the reading crop in effect
 * (pdf-viewer-crop.js) or null.
 */
export function applyLayoutClasses(area, s) {
  area.classList.remove(...LAYOUT_CLASSES);
  if (s.paged) {
    // Top to bottom, a grid of rows the set's size; side by side, the
    // usual row, with sets spaced apart by CSS.
    area.classList.add(
      s.layoutMode === "vertical" ? "pdf-layout-pagedv" : "pdf-layout-horizontal",
      "pdf-paged",
      `pdf-paged-${s.perSet}`,
    );
    area.style.setProperty("--pdf-paged-cols", String(s.perSet));
  } else if (s.folded) area.classList.add("pdf-layout-folded");
  else if (s.layoutMode === "vertical") {
    area.classList.add(s.fitMode === "fit" ? "pdf-layout-fit" : "pdf-layout-fixed");
  } else if (s.layoutMode === "horizontal") area.classList.add("pdf-layout-horizontal");
  else area.classList.add("pdf-layout-fixed");
  // A reading crop applies in every view but the folded one.
  if (s.crop && !s.folded) area.classList.add("pdf-cropped");
}

/** The scale at which a set of `n` pages fits the view, both ways. */
function pagedFitZoom(area, page, n) {
  const across = (area.clientWidth - PAGED_PAD - (n - 1) * SET_GAP - 4) / (n * page.width);
  return Math.min(across, (area.clientHeight - PAGED_PAD) / page.height);
}

/** CSS px per PDF unit for the mode, from page 1's scale-1 viewport —
 *  trimmed by a reading crop, so what is left of a page is what fits. */
export function fitZoom(area, page1, s) {
  const first = croppedSize(page1, s.crop);
  const pad = 40;
  const gap = 12;
  if (s.paged) return pagedFitZoom(area, first, s.perSet);
  if (s.layoutMode === "vertical") {
    const availW = area.clientWidth - pad;
    // Folded: fit-width scale × the folded zoom multiplier.
    if (s.folded) return (availW / first.width) * s.foldedZoom;
    if (s.fitMode === "fit-2") return (availW - gap - 4) / (first.width * 2);
    if (s.fitMode === "fit-3") return (availW - gap * 2 - 4) / (first.width * 3);
    return availW / first.width;
  }
  if (s.layoutMode === "horizontal") return (area.clientHeight - pad) / first.height;
  return s.fixedZoom;
}

/** Size a page's wrapper at `scale` — and, under a reading crop, close
 *  up the room its trimmed edges would take. */
export function sizePage(p, scale, crop) {
  const w = Math.round(p.viewport.width * scale);
  const h = Math.round(p.viewport.height * scale);
  p.wrapper.style.width = `${w}px`;
  p.wrapper.style.height = `${h}px`;
  cropWrapper(p.wrapper, w, h, crop);
}

/** The paged view's spacing, from page 1's (trimmed) size at this
 *  scale: a set is n pages across side by side, one page tall top to
 *  bottom. Sized to the view, so the neighbours stay out of sight and
 *  the first and last set get as much room outside them. */
export function sizePagedGap(area, pages, scale, s) {
  const vp = pages[0] ? croppedSize(pages[0].viewport, s.crop) : null;
  if (!s.paged || !vp) {
    area.style.removeProperty("--pdf-paged-pad");
    area.style.removeProperty("--pdf-paged-gap");
    return;
  }
  const horiz = s.layoutMode === "horizontal";
  const n = s.perSet;
  const setSize = horiz ? n * vp.width * scale + (n - 1) * SET_GAP : vp.height * scale;
  const view = horiz ? area.clientWidth : area.clientHeight;
  const pad = Math.max(0, Math.floor((view - setSize) / 2));
  area.style.setProperty("--pdf-paged-pad", `${pad}px`);
  area.style.setProperty("--pdf-paged-gap", `${pad + 24}px`);
}

/** Wheel and trackpad in the paged view: one gesture, one set. Left to
 *  snapping, a wheel notch is too short a scroll to reach the next set
 *  and settles back on the same one; a trackpad swipe's momentum keeps
 *  sending events, so a set is turned only once the wheel has been
 *  quiet for a moment. Pinch (ctrl + wheel) is left alone. */
export function attachPagedWheel(area, isPaged, step) {
  let inGesture = false;
  let quiet = 0;
  area.addEventListener("wheel", (e) => {
    if (!isPaged() || e.ctrlKey) return;
    e.preventDefault();
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    clearTimeout(quiet);
    quiet = setTimeout(() => { inGesture = false; }, 200);
    if (inGesture || Math.abs(d) < 4) return;
    inGesture = true;
    step(d > 0 ? 1 : -1);
  }, { passive: false });
}
