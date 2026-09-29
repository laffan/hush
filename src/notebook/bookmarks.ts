/**
 * Notebook bookmarks — named, coloured points on the canvas, one UI with
 * the PDF viewer's (the shared `ui/bookmark-ui.js`): the toolbar's
 * bookmark button opens the list, **Add Bookmark** at its foot arms the
 * stamp, and the next click on the canvas drops one there
 * (`placeBookmark`, via `tool: "bookmark"`). Each is drawn as a DOM
 * marker — ribbon + label in the app's UI font — by
 * `ui/bookmark-layer.ts`: drag it to move it, click the ribbon for the
 * palette, click the label to rename it.
 *
 * They replace two things. The old notebook "Bookmarks" were saved
 * camera views; they are gone, and `bookmark-model.ts#normalizeBookmarks`
 * drops them on load. Proofread pins were text shapes; this is the same
 * idea made a first-class object, and old pins load as bookmarks.
 *
 * A bookmark is not a shape — no bounds, layer or selection — but it is
 * content: it rides the undo checkpoint, the envelope's `bookmarks`
 * field, pane / stack mirroring, and Splits and Grabs carry it with the
 * page it sits on (`translateBookmarks`, called from state-splits.ts).
 * A Doc links to one as `hush-nb://<fileId>/<bookmarkId>`
 * (bookmark-link.ts); `bookmark-links.js` follows the link.
 */

import type { DrawingState } from "./state";
import type { NotebookBookmark, Point } from "./types";
import { canvasToScreen, generateId } from "./utils";
import { DEFAULT_BOOKMARK_COLOR } from "./bookmark-model";
import { notebookBookmarkLink } from "./bookmark-link";
import { endBookmarkStamp, startBookmarkStamp } from "../ui/bookmark-ui.js";

export function makeBookmark(at: Point, opts: { name: string; color?: string }): NotebookBookmark {
  return {
    id: generateId(),
    name: opts.name,
    color: opts.color || DEFAULT_BOOKMARK_COLOR,
    x: at.x,
    y: at.y,
    createdAt: Date.now(),
  };
}

function commit(state: DrawingState, next: NotebookBookmark[], record = true): void {
  state.bookmarks = next;
  if (record) state.recordHistory();
  state.notify("bookmarks");
}

/** The shared stamp's key for this canvas (`nb:` puts the ribbon cursor
 *  on bookmark markers too — styles/notebook.css). */
export function bookmarkStampKeyFor(state: DrawingState): string {
  return `nb:${state.hostFileId || "canvas"}`;
}

/** Arm the stamp on this canvas (the list's Add Bookmark). */
export function armBookmarkStamp(state: DrawingState): void {
  if (state.tool !== "bookmark") state.dismissSplits();
  state.tool = "bookmark";
  state.brainstormMode = false;
  state.notify("tool");
  startBookmarkStamp(bookmarkStampKeyFor(state), () => {
    if (state.tool === "bookmark") { state.tool = "select"; state.notify("tool"); }
  });
}

/** The stamp landed: drop a bookmark at `at`, hand back to Select, and
 *  open its label for naming. */
export function placeBookmark(state: DrawingState, at: Point): void {
  const bm = makeBookmark(at, { name: `Bookmark ${state.bookmarks.length + 1}` });
  state.tool = "select";
  state.notify("tool");
  endBookmarkStamp();
  state.renamingBookmarkId = bm.id;
  commit(state, [...state.bookmarks, bm]);
}

export function updateBookmark(
  state: DrawingState, id: string, patch: Partial<Omit<NotebookBookmark, "id">>, record = true,
): void {
  let changed = false;
  const next = state.bookmarks.map((b) => {
    if (b.id !== id) return b;
    changed = true;
    return { ...b, ...patch };
  });
  if (changed) commit(state, next, record);
}

export function deleteBookmark(state: DrawingState, id: string): void {
  if (!state.bookmarks.some((b) => b.id === id)) return;
  commit(state, state.bookmarks.filter((b) => b.id !== id));
}

/** `[Name](hush-nb://…)`, or null on a canvas with no file of its own. */
export function bookmarkLinkText(state: DrawingState, bm: NotebookBookmark): string | null {
  return state.hostFileId ? notebookBookmarkLink(state.hostFileId, bm) : null;
}

/** Bring a bookmark to the middle of the visible canvas — a list row, a
 *  shelf row, the far end of a link. Returns false for an unknown id. */
export function focusBookmark(state: DrawingState, id: string): boolean {
  const bm = state.bookmarks.find((b) => b.id === id);
  if (!bm) return false;
  const target = canvasToScreen({ x: bm.x, y: bm.y }, state.camera);
  const center = state.visibleScreenCenter();
  state.camera = { ...state.camera, x: state.camera.x + center.x - target.x, y: state.camera.y + center.y - target.y };
  // A camera move is repaint-only; the flash rides it rather than a
  // "bookmarks" notify, which would mark the notebook dirty.
  state.flashBookmarkId = id;
  state.notify("camera");
  return true;
}
