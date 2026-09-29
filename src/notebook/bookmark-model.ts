/**
 * Notebook bookmarks, the pure half: reading them off disk and moving
 * them with Splits and Grabs. No DOM, no state — `notebook-content.ts`
 * decodes through this, so it stays light enough for the app chunk.
 * The rest (stamping, focusing, editing) is `bookmarks.ts`; the marker
 * is `ui/bookmark-layer.ts`.
 */

import type { Axis, NotebookBookmark, Shape, TextShape } from "./types";
import { LINE_HEIGHT_RATIO } from "./types";

/** The first swatch of the shared palette (ui/bookmark-ui.js). */
export const DEFAULT_BOOKMARK_COLOR = "#ef5350";

function isPoint(b: unknown): b is NotebookBookmark {
  const o = b as NotebookBookmark;
  return !!o && typeof o === "object" && typeof o.id === "string"
    && Number.isFinite(o.x) && Number.isFinite(o.y);
}

/**
 * The stored `bookmarks` list as point bookmarks. The field used to hold
 * camera bookmarks (`{ id, name, camera }` — saved views), a feature
 * that is gone; those have no point, so they're dropped here and the
 * next save leaves them behind.
 */
export function normalizeBookmarks(raw: unknown): NotebookBookmark[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPoint).map((b) => ({
    id: b.id,
    name: typeof b.name === "string" ? b.name : "Bookmark",
    color: typeof b.color === "string" && b.color ? b.color : DEFAULT_BOOKMARK_COLOR,
    x: b.x,
    y: b.y,
    ...(Number.isFinite(b.createdAt) ? { createdAt: b.createdAt } : {}),
  }));
}

/**
 * Proofread pins — the text shapes with `pin: true` this replaced — as
 * bookmarks. Same id, so a `hush-pin://` link still lands; placed where
 * the pin's dot was drawn.
 */
export function pinsToBookmarks(shapes: Shape[]): { shapes: Shape[]; bookmarks: NotebookBookmark[] } {
  const pins = shapes.filter((s) => s.type === "text" && (s as TextShape & { pin?: boolean }).pin) as TextShape[];
  if (!pins.length) return { shapes, bookmarks: [] };
  const ids = new Set(pins.map((p) => p.id));
  return {
    shapes: shapes.filter((s) => !ids.has(s.id)),
    bookmarks: pins.map((p) => ({
      id: p.id,
      name: (p.text || "").split("\n")[0] || "Bookmark",
      color: p.color && p.color !== "auto" && p.color !== "#000000" ? p.color : DEFAULT_BOOKMARK_COLOR,
      x: p.position.x - 13,
      y: p.position.y + (p.fontSize * LINE_HEIGHT_RATIO) / 2,
      createdAt: p.createdAt,
    })),
  };
}

/** A bookmark's coordinate across a split of `orientation`. */
export function bookmarkCross(b: NotebookBookmark, orientation: Axis): number {
  return orientation === "horizontal" ? b.y : b.x;
}

/**
 * Carry bookmarks along with a split / grab translation — the same test
 * split lines get (`translateSplits`): a bookmark on the moving side
 * moves by `d` on the cross axis. A bookmark is a point on the page, so
 * this is exactly "it stays with the paragraph it was dropped on".
 */
export function translateBookmarks(
  bookmarks: NotebookBookmark[],
  orientation: Axis,
  d: number,
  moves: (pos: number) => boolean,
): NotebookBookmark[] {
  if (d === 0 || !bookmarks.length) return bookmarks;
  let changed = false;
  const out = bookmarks.map((b) => {
    if (!moves(bookmarkCross(b, orientation))) return b;
    changed = true;
    return orientation === "horizontal" ? { ...b, y: b.y + d } : { ...b, x: b.x + d };
  });
  return changed ? out : bookmarks;
}

/** Collapse a split: bookmarks stamped in the gap after the split was
 *  cut go with the writing there; older ones close up onto the seam;
 *  everything past the far line comes back by the gap. */
export function collapseBookmarks(
  bookmarks: NotebookBookmark[], orientation: Axis, a: number, b: number, splitCreatedAt: number,
): NotebookBookmark[] {
  const kept = bookmarks.filter((bm) => {
    const c = bookmarkCross(bm, orientation);
    return !(c > a && c < b && (bm.createdAt || 0) > splitCreatedAt);
  });
  if (b <= a) return kept.length === bookmarks.length ? bookmarks : kept;
  const seamed = kept.map((bm) => {
    const c = bookmarkCross(bm, orientation);
    if (c <= a || c > b) return bm;
    return orientation === "horizontal" ? { ...bm, y: a } : { ...bm, x: a };
  });
  return translateBookmarks(seamed, orientation, -(b - a), (p) => p > b);
}

/** Apply a grab of the band [a, b]: the bookmarks inside it go into the
 *  buffer, rebased to `a`; those past it close up by the band's height. */
export function liftBookmarks(
  bookmarks: NotebookBookmark[], orientation: Axis, a: number, b: number,
): { buffer: NotebookBookmark[]; kept: NotebookBookmark[] } {
  const inBand = (bm: NotebookBookmark) => {
    const c = bookmarkCross(bm, orientation);
    return c >= a && c <= b;
  };
  return {
    buffer: translateBookmarks(bookmarks.filter(inBand), orientation, -a, () => true),
    kept: translateBookmarks(bookmarks.filter((bm) => !inBand(bm)), orientation, -(b - a), (p) => p > b),
  };
}

/** Place a grab at `pos`: what's past it moves on by the height, and the
 *  buffered bookmarks land in the gap. Ids are kept, so links still land. */
export function landBookmarks(
  bookmarks: NotebookBookmark[], buffer: NotebookBookmark[], orientation: Axis, pos: number, height: number,
): NotebookBookmark[] {
  return [
    ...translateBookmarks(bookmarks, orientation, height, (p) => p > pos),
    ...translateBookmarks(buffer, orientation, pos, () => true),
  ];
}
