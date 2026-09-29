/**
 * Which colour a bookmark link's icon is, for the Doc's link rendering
 * (`editor/plugins/link-decorator.js`). A link to a bookmark —
 * `hush-pdf://<fileId>/<bookmarkId>` or `hush-nb://<fileId>/<bookmarkId>`
 * — renders with the bookmark's ribbon beside it, in that bookmark's
 * colour.
 *
 *  - **PDF** colours are read live off the PDF registry, which is in
 *    memory from boot (`pdf-bookmarks.js` registers the lookup).
 *  - **Notebook** bookmarks live inside the notebook file, and reading a
 *    notebook to colour a link would mean unpacking it — a proof is tens
 *    of MB. So every canvas that shows a notebook publishes its bookmarks
 *    here as they change (`publishNotebookBookmarks`), kept per device in
 *    localStorage; and a link made on this branch carries the colour it
 *    had when it was made (`?c=rrggbb`), which stands in until the
 *    notebook has been open on this device.
 *
 * A bookmark link whose colour is known nowhere (a deleted bookmark, an
 * old link to a notebook this device hasn't opened) still gets the icon,
 * in a neutral tint. Changes are announced as `BOOKMARK_COLORS_EVENT` on
 * window, which the decorators rebuild on.
 */

export const BOOKMARK_COLORS_EVENT = "hush-bookmark-colors-changed";
const STORE_KEY = "hush-nb-bookmark-colors";

/** { [notebookFileId]: { [bookmarkId]: "#rrggbb" } } */
let nbColors = load();
let pdfLookup = null;

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(nbColors)); } catch { /* storage unavailable */ }
}

let pending = false;
function announce() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    window.dispatchEvent(new Event(BOOKMARK_COLORS_EVENT));
  });
}

/** `getPdfBookmarks` from the PDF registry — registered by pdf-bookmarks
 *  so this module doesn't pull the registry into the editor's chunk. */
export function setPdfBookmarkLookup(fn) {
  pdfLookup = fn;
  announce();
}

/** A PDF's bookmarks changed (the registry emits the file id). */
export function pdfBookmarksChanged() {
  announce();
}

/** A canvas showing notebook `fileId` has these bookmarks now. */
export function publishNotebookBookmarks(fileId, bookmarks) {
  if (!fileId) return;
  const next = {};
  for (const b of bookmarks || []) if (b && b.id && b.color) next[b.id] = b.color;
  const prev = nbColors[fileId];
  if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
  if (!prev && !Object.keys(next).length) return;
  nbColors = { ...nbColors, [fileId]: next };
  save();
  announce();
}

const PDF_RE = /^hush-pdf:\/\/([^/]+)\/([^/?#\s]+?)(?:\?[^\s#]*)?$/;
const NB_RE = /^hush-(?:nb|pin):\/\/([^/]+)\/([^/?#\s]+)(?:\?([^\s#]*))?$/;

/**
 * For a link url: `null` when it isn't a bookmark link, else
 * `{ color }` — the bookmark's colour, or null when nobody knows it.
 */
export function bookmarkLinkInfo(url) {
  if (!url) return null;
  let m = PDF_RE.exec(url);
  if (m) {
    const bm = pdfLookup ? (pdfLookup(m[1]) || []).find((b) => b.id === m[2]) : null;
    return { color: bm?.color || null };
  }
  m = NB_RE.exec(url);
  if (m) {
    const live = nbColors[m[1]]?.[m[2]];
    if (live) return { color: live };
    // No live record for this notebook: the colour the link was made with.
    const hint = /(?:^|&)c=([0-9a-fA-F]{6})(?:&|$)/.exec(m[3] || "");
    return { color: hint && !nbColors[m[1]] ? `#${hint[1].toLowerCase()}` : null };
  }
  return null;
}
