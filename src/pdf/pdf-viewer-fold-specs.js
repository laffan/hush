/**
 * Which regions of the document the folded view shows: each annotation
 * passing the filter, padded by a couple of lines above and below and
 * merged with its neighbours on the page. Pure geometry — the folds
 * themselves (drawing, scrolling, the filter's state) are
 * pdf-viewer-folds.js's.
 */
import { parseAnnotationPosition, pdfPointToViewport } from "./pdf-viewer-annotations.js";

const FOLD_PAD = 28;   // page units (~2 text lines) above/below the annotation
const MERGE_GAP = 16;  // merge folds whose padded regions come this close

/** The filter's key for an annotation: its type and colour. */
export const comboKey = (a) => `${a.type}:${(a.color || "").toLowerCase()}`;

/** Every type:colour pair present on a page, with how many of each:
 *  Map key → `{ type, color, count }`. */
export function availableCombos(annotations) {
  const map = new Map();
  for (const a of annotations) {
    if (typeof parseAnnotationPosition(a)?.pageIndex !== "number") continue;
    const key = comboKey(a);
    const entry = map.get(key) || { type: a.type, color: (a.color || "").toLowerCase(), count: 0 };
    entry.count++;
    map.set(key, entry);
  }
  return map;
}

/** The filter before anyone changes it: every type and colour there is.
 *  (It used to start on red highlights and red ink alone; the folded
 *  view now starts on all the annotations, and the filter narrows it.) */
export function defaultFilter(combos) {
  return new Set(combos.keys());
}

/** Vertical extent of an annotation in top-based page units, or null.
 *  Points map through the viewport transform so crop-box origins / page
 *  rotation can't shift the folds off the annotations they're built
 *  around. */
export function annotationExtent(annot, viewport) {
  const pos = parseAnnotationPosition(annot);
  if (!pos) return null;
  let top = Infinity;
  let bottom = -Infinity;
  const take = (x, y) => {
    const [, vy] = pdfPointToViewport(viewport, x, y);
    top = Math.min(top, vy);
    bottom = Math.max(bottom, vy);
  };
  for (const r of pos.rects || []) {
    if (!Array.isArray(r) || r.length < 4) continue;
    take(r[0], r[1]);
    take(r[2], r[3]);
  }
  for (const path of pos.paths || []) {
    if (!Array.isArray(path)) continue;
    for (let i = 1; i < path.length; i += 2) take(path[i - 1], path[i]);
  }
  return top === Infinity ? null : { top, bottom };
}

/** The pages any annotation passing `active` is on. */
export function foldedPages(annotations, active) {
  const out = new Set();
  for (const a of annotations) {
    const idx = parseAnnotationPosition(a)?.pageIndex;
    if (typeof idx === "number" && active.has(comboKey(a))) out.add(idx);
  }
  return out;
}

/** Padded, per-page-merged fold intervals for the filter `active`:
 *  `{ pageIndex, top, bottom }` in page units, in reading order. */
export function computeFolds(annotations, pages, active) {
  const byPage = new Map();
  for (const a of annotations) {
    if (!active.has(comboKey(a))) continue;
    const pos = parseAnnotationPosition(a);
    const p = pos ? pages[pos.pageIndex] : undefined;
    if (!pos || !p?.viewport) continue;
    const ext = annotationExtent(a, p.viewport);
    if (!ext) continue;
    const list = byPage.get(pos.pageIndex) || [];
    list.push({
      top: Math.max(0, ext.top - FOLD_PAD),
      bottom: Math.min(p.viewport.height, ext.bottom + FOLD_PAD),
    });
    byPage.set(pos.pageIndex, list);
  }
  const out = [];
  for (const idx of [...byPage.keys()].sort((a, b) => a - b)) {
    const list = byPage.get(idx).sort((a, b) => a.top - b.top);
    let cur = null;
    for (const iv of list) {
      if (cur && iv.top <= cur.bottom + MERGE_GAP) cur.bottom = Math.max(cur.bottom, iv.bottom);
      else {
        cur = { pageIndex: idx, top: iv.top, bottom: iv.bottom };
        out.push(cur);
      }
    }
  }
  return out;
}
