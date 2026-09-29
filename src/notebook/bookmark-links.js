/**
 * Following a `hush-nb://<notebookFileId>/<bookmarkId>` link (or the
 * older `hush-pin://`): open the notebook in the main canvas (in place,
 * if it's already the one open) and bring the bookmark to the middle of
 * the view. The PDF twin is `pdf/pdf-bookmarks.js#openPdfAtBookmark`;
 * the jump is handed to the mount the same way (`takePending…` →
 * `applyPendingBookmarkJump`), so it lands after the saved camera is
 * restored rather than racing it.
 */
import { parseNotebookBookmarkUrl } from "./bookmark-link.ts";

let _state = null;
let _pending = null;

export function initNotebookBookmarkLinks(state) {
  _state = state;
  // Canvas text shapes route url clicks through a window hook — the
  // canvas bundle doesn't import app modules (see __hushOpenPdfBookmark).
  window.__hushOpenNotebookBookmark = (url) => { void openNotebookBookmarkUrl(url); };
}

export async function openNotebookBookmarkUrl(url) {
  const parsed = parseNotebookBookmarkUrl(url);
  const state = _state;
  if (!parsed || !state) return;
  const { getCanvasInstance, getCurrentNotebookFileId } = await import("./notebook-bridge.js");
  const canvas = getCanvasInstance();
  if (state.currentNotebookFileId === parsed.fileId && canvas && getCurrentNotebookFileId() === parsed.fileId) {
    const { focusBookmark } = await import("./bookmarks.ts");
    focusBookmark(canvas.state, parsed.bookmarkId);
    return;
  }
  _pending = parsed;
  await state.openNotebook(parsed.fileId);
}

/** Called by the bridge once a mount has restored its camera: perform a
 *  jump requested for this file, if there is one. */
export function applyPendingBookmarkJump(fileId, canvas) {
  const jump = _pending && _pending.fileId === fileId ? _pending : null;
  _pending = null;
  if (!jump || !canvas) return;
  // A frame later, so the canvas has its size and the visible centre is
  // the real one.
  requestAnimationFrame(() => {
    import("./bookmarks.ts").then(({ focusBookmark }) => focusBookmark(canvas.state, jump.bookmarkId)).catch(() => {});
  });
}
