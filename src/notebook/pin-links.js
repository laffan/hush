/**
 * Following a `hush-pin://<notebookFileId>/<pinId>` link: open the proof
 * in the main canvas (in place, if it's already the one open) and bring
 * the pin to the middle of the view, selected. The PDF-bookmark twin is
 * `pdf/pdf-bookmarks.js#openPdfAtBookmark`; the jump is handed to the
 * mount the same way (`takePendingPinJump`), so it lands after the saved
 * camera is restored rather than racing it.
 */
import { parsePinUrl } from "./pin-link.ts";

let _state = null;
let _pending = null;

export function initPinLinks(state) {
  _state = state;
  // Canvas text shapes route url clicks through a window hook — the
  // canvas bundle doesn't import app modules (see __hushOpenPdfBookmark).
  window.__hushOpenPin = (url) => { void openPinUrl(url); };
}

export async function openPinUrl(url) {
  const parsed = parsePinUrl(url);
  const state = _state;
  if (!parsed || !state) return;
  const { getCanvasInstance, getCurrentNotebookFileId } = await import("./notebook-bridge.js");
  const canvas = getCanvasInstance();
  if (state.currentNotebookFileId === parsed.fileId && canvas && getCurrentNotebookFileId() === parsed.fileId) {
    const { focusPin } = await import("./pins.ts");
    focusPin(canvas.state, parsed.pinId);
    return;
  }
  _pending = parsed;
  await state.openNotebook(parsed.fileId);
}

/** Called by the bridge once a mount has restored its camera: perform a
 *  jump requested for this file, if there is one. */
export function applyPendingPinJump(fileId, canvas) {
  const jump = _pending && _pending.fileId === fileId ? _pending : null;
  _pending = null;
  if (!jump || !canvas) return;
  // A frame later, so the canvas has its size and the visible centre is
  // the real one.
  requestAnimationFrame(() => {
    import("./pins.ts").then(({ focusPin }) => focusPin(canvas.state, jump.pinId)).catch(() => {});
  });
}
