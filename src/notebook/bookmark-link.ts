/**
 * `hush-nb://<notebookFileId>/<bookmarkId>` — the link to a notebook
 * bookmark, the canvas twin of a PDF's `hush-pdf://<fileId>/<bookmarkId>`.
 * Dependency-free so the app side (link routing, ⌘-drag into a Doc) can
 * read and write links without pulling canvas modules into its chunk.
 *
 * `hush-pin://` is the same link under the name the feature shipped with
 * for a day (proofread pins); it still resolves.
 */

export const NB_BOOKMARK_SCHEME = "hush-nb://";

export function isNotebookBookmarkUrl(url: string): boolean {
  return /^hush-(nb|pin):\/\//.test(url || "");
}

export function notebookBookmarkUrl(fileId: string, bookmarkId: string): string {
  return `${NB_BOOKMARK_SCHEME}${fileId}/${bookmarkId}`;
}

export function parseNotebookBookmarkUrl(url: string): { fileId: string; bookmarkId: string } | null {
  const m = /^hush-(?:nb|pin):\/\/([^/]+)\/([^/?#\s]+)$/.exec((url || "").trim());
  return m ? { fileId: m[1], bookmarkId: m[2] } : null;
}

/** `[Name](hush-nb://…)` — what a bookmark pastes into a Doc as. */
export function notebookBookmarkLink(fileId: string, bm: { id: string; name: string }): string {
  const name = (bm.name || "").replace(/[[\]]/g, "").replace(/\s+/g, " ").trim() || "Bookmark";
  return `[${name}](${notebookBookmarkUrl(fileId, bm.id)})`;
}
