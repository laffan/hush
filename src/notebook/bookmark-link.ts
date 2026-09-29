/**
 * `hush-nb://<notebookFileId>/<bookmarkId>` — the link to a notebook
 * bookmark, the canvas twin of a PDF's `hush-pdf://<fileId>/<bookmarkId>`.
 * Dependency-free so the app side (link routing, ⌘-drag into a Doc) can
 * read and write links without pulling canvas modules into its chunk.
 *
 * `hush-pin://` is the same link under the name the feature shipped with
 * for a day (proofread pins); it still resolves.
 *
 * A link may carry `?c=rrggbb`, the bookmark's colour when the link was
 * made — only a hint for the icon a Doc draws beside it
 * (links/bookmark-colors.js), until the notebook's live colours are known.
 */

export const NB_BOOKMARK_SCHEME = "hush-nb://";

export function isNotebookBookmarkUrl(url: string): boolean {
  return /^hush-(nb|pin):\/\//.test(url || "");
}

export function notebookBookmarkUrl(fileId: string, bookmarkId: string, color?: string): string {
  const hex = /^#?([0-9a-fA-F]{6})$/.exec(color || "");
  return `${NB_BOOKMARK_SCHEME}${fileId}/${bookmarkId}${hex ? `?c=${hex[1].toLowerCase()}` : ""}`;
}

export function parseNotebookBookmarkUrl(url: string): { fileId: string; bookmarkId: string } | null {
  const m = /^hush-(?:nb|pin):\/\/([^/]+)\/([^/?#\s]+)(?:\?[^\s#]*)?$/.exec((url || "").trim());
  return m ? { fileId: m[1], bookmarkId: m[2] } : null;
}

/** `[Name](hush-nb://…)` — what a bookmark pastes into a Doc as. */
export function notebookBookmarkLink(fileId: string, bm: { id: string; name: string; color?: string }): string {
  const name = (bm.name || "").replace(/[[\]]/g, "").replace(/\s+/g, " ").trim() || "Bookmark";
  return `[${name}](${notebookBookmarkUrl(fileId, bm.id, bm.color)})`;
}
