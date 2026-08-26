/**
 * Image paste — when the clipboard holds image bytes (a screenshot,
 * "Copy Image" from another app, an image copied out of a file
 * browser), save them to the Images folder and insert a markdown ref at
 * the cursor.
 *
 * Mirrors the drag-drop image path so the same Local Sync sibling-write
 * rule applies for Local Sync docs. Lives in its own module so editor.js
 * stays under the line limit and pane editors pick it up via the same
 * `createBaseExtensions` extension list.
 *
 * Three sources, cheapest and least permissioned first:
 *
 *   1. The event's own `clipboardData` files — synchronous, no
 *      permission, and when it yields anything nothing else is needed.
 *   2. An `<img>` in the event's `text/html` whose `src` is a `data:` or
 *      `blob:` URL. WebKit routinely answers an image paste with markup
 *      instead of bytes, and this is the image arriving under another
 *      name — still no permission, still no prompt.
 *   3. The OS clipboard, via `clipboard-image.js`. Desktop goes through
 *      the Tauri plugin rather than `navigator.clipboard.read()`, whose
 *      answer on macOS is a system "Paste from …" prompt; an image that
 *      only arrives behind a prompt may as well not arrive.
 *
 * Every step says what it found in the Activity Log (Settings → Debug,
 * source `paste`), because on iPad that is the only console there is,
 * and every one of these failures used to look identical from outside:
 * nothing happened.
 */
import { EditorView } from "@codemirror/view";
import { defaultLocalSyncContext } from "./base-extensions.js";
import {
  imageFilesFromDataTransfer, readClipboardImageDataUrl, dataUrlToFile,
  fetchableImageSrcsFromHtml, filesFromImageSrcs,
} from "../clipboard-image.js";
import { logActivity } from "../activity-log.js";
import { describeClipboard } from "../paste-diagnostics.js";

export function createImagePasteExtension(state, opts) {
  const getImageContext = opts?.getImageContext || (() => defaultLocalSyncContext(state));
  function localSyncFromCtx() {
    const ctx = getImageContext();
    return ctx?.kind === "localSync"
      ? { folderId: ctx.folderId, baseDir: ctx.baseDir || "" }
      : null;
  }
  function insert(view, files) {
    if (!files.length) return;
    const pos = view.state.selection.main.head;
    logActivity("paste", "info", "Inserting pasted image(s) into the document", {
      count: files.length,
      names: files.map((f) => f?.name),
      types: files.map((f) => f?.type),
      sizes: files.map((f) => f?.size),
      pos,
      localSync: !!localSyncFromCtx(),
    });
    import("./file-drop.js")
      .then((m) => m.insertImagesAtPos(state, view, files, pos, localSyncFromCtx()))
      .then(() => logActivity("paste", "info", "Pasted image insert finished"))
      .catch((e) => logActivity("paste", "error", "Pasted image insert failed", {
        error: String(e?.message || e), stack: e?.stack,
      }));
  }
  /** Last resort: ask the OS clipboard. Started in the paste handler's
   *  own task so the browser read still holds the gesture's transient
   *  activation. We can't await the answer before deciding whether to
   *  preventDefault, so CodeMirror gets the (empty) event and the image
   *  goes in when it lands. */
  function readClipboardFallback(view) {
    readClipboardImageDataUrl()
      .then((dataUrl) => {
        if (dataUrl) insert(view, [dataUrlToFile(dataUrl)]);
        else logActivity("paste", "warn", "Doc paste found no image anywhere — the event was empty and the clipboard read came back with nothing");
      })
      .catch((e) => logActivity("paste", "error", "Doc paste clipboard read threw", {
        error: String(e?.message || e),
      }));
  }
  return EditorView.domEventHandlers({
    paste(event, view) {
      logActivity("paste", "info", "Doc paste event", describeClipboard(event.clipboardData));
      const sync = imageFilesFromDataTransfer(event.clipboardData);
      if (sync.length > 0) {
        event.preventDefault();
        insert(view, sync);
        return true;
      }
      // No image on the event. Ask the OS clipboard — but only when the
      // event carried no text either. A clipboard holding text is a
      // text paste, and macOS hands out an image representation of some
      // rich-text copies (Word, Excel), so reading unconditionally would
      // drop a picture of the words in place of the words. The reported
      // failure is the other case exactly: WKWebView strips image bytes
      // and leaves `clipboardData` empty.
      if ((event.clipboardData?.getData("text/plain") || "").length > 0) {
        logActivity("paste", "info", "Doc paste carried text — treated as a text paste, clipboard not read");
        return false;
      }
      // Before the OS clipboard: the event's own `text/html`. WebKit
      // routinely answers an image paste with markup instead of bytes —
      // no files, no text, just an `<img>` — and where its `src` is a
      // `data:` or `blob:` URL the image is already in hand, no
      // permission and no gesture required. The decision to take that
      // route is made synchronously, before any `await`, precisely so
      // that not taking it leaves the gesture's activation intact for
      // the clipboard read below.
      const html = event.clipboardData?.getData("text/html") || "";
      const { fetchable, skipped } = fetchableImageSrcsFromHtml(html);
      if (fetchable.length) {
        logActivity("paste", "info", "Doc paste: taking images from the event's HTML", { count: fetchable.length });
        filesFromImageSrcs(fetchable).then((files) => {
          if (files.length) insert(view, files);
          else readClipboardFallback(view);
        });
        return false;
      }
      if (skipped.length) {
        // `webkit-fake-url:` lands here — WebKit naming bytes it kept
        // back. Worth saying, because it means the clipboard read below
        // is the only route left.
        logActivity("paste", "info", "Doc paste HTML held images we can't fetch", { schemes: skipped });
      }
      readClipboardFallback(view);
      return false;
    },
  });
}
