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
 * The event's own `clipboardData` is checked first — it's synchronous
 * and needs no permission. When it comes up empty (WKWebView routinely
 * strips image bytes from it) the read falls to `clipboard-image.js`,
 * which goes through the Tauri clipboard plugin rather than
 * `navigator.clipboard.read()`. That ordering is the fix for "pasting
 * an image into a Doc does nothing": the browser API's answer on macOS
 * is a system "Paste from …" prompt, and an image that only arrives
 * behind a prompt may as well not arrive.
 */
import { EditorView } from "@codemirror/view";
import { defaultLocalSyncContext } from "./base-extensions.js";
import {
  imageFilesFromDataTransfer, readClipboardImageDataUrl, dataUrlToFile,
} from "../clipboard-image.js";

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
    import("./file-drop.js")
      .then((m) => m.insertImagesAtPos(state, view, files, pos, localSyncFromCtx()))
      .catch((e) => console.error("Image paste failed:", e));
  }
  return EditorView.domEventHandlers({
    paste(event, view) {
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
      if ((event.clipboardData?.getData("text/plain") || "").length > 0) return false;
      // Started here, in the handler's own task, so the browser fallback
      // still holds the paste gesture's transient activation. We can't
      // await the answer before deciding whether to preventDefault, so
      // let CodeMirror have the (empty) event and insert the image when
      // it lands.
      readClipboardImageDataUrl()
        .then((dataUrl) => { if (dataUrl) insert(view, [dataUrlToFile(dataUrl)]); })
        .catch((e) => console.warn("[paste] clipboard image read failed:", e));
      return false;
    },
  });
}
