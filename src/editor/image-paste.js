/**
 * Image paste — when the clipboard payload contains image bytes
 * (e.g. a screenshot or "Copy Image" from another app), save them to
 * the Images folder and insert a markdown ref at the cursor.
 *
 * Mirrors the drag-drop image path so the same Local Sync sibling-write
 * rule applies for Local Sync docs. Lives in its own module so editor.js
 * stays under the line limit and pane editors pick it up via the same
 * `createBaseExtensions` extension list.
 *
 * Three sources are checked, in order, because WKWebView's clipboard
 * exposure varies by platform:
 *   1. `event.clipboardData.items` — standard browser path.
 *   2. `event.clipboardData.files` — populated when items isn't (some
 *      WKWebView builds; some "Copy image" sources).
 *   3. `navigator.clipboard.read()` — async fallback for macOS Tauri,
 *      where WKWebView sometimes strips the synchronous payload but
 *      keeps the system clipboard reachable while transient activation
 *      from the paste gesture is alive.
 */
import { EditorView } from "@codemirror/view";
import { defaultLocalSyncContext } from "./editor.js";

function collectImageFilesFromEvent(event) {
  const cd = event.clipboardData;
  if (!cd) return [];
  const out = [];
  const items = cd.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file" && (it.type || "").startsWith("image/")) {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  if (out.length === 0 && cd.files) {
    for (let i = 0; i < cd.files.length; i++) {
      const f = cd.files[i];
      if (f && (f.type || "").startsWith("image/")) out.push(f);
    }
  }
  return out;
}

async function readImagesViaClipboardApi() {
  if (typeof navigator === "undefined" || !navigator.clipboard?.read) return [];
  try {
    const items = await navigator.clipboard.read();
    const out = [];
    for (const item of items) {
      for (const t of item.types || []) {
        if (typeof t === "string" && t.startsWith("image/")) {
          try {
            const blob = await item.getType(t);
            const ext = (t.split("/")[1] || "png").split(";")[0];
            out.push(new File([blob], `pasted-${Date.now()}.${ext}`, { type: t }));
          } catch (_) { /* skip this type */ }
          break; // one image per item is enough
        }
      }
    }
    return out;
  } catch (_) {
    return [];
  }
}

export function createImagePasteExtension(state, opts) {
  const getImageContext = opts?.getImageContext || (() => defaultLocalSyncContext(state));
  function localSyncFromCtx() {
    const ctx = getImageContext();
    return ctx?.kind === "localSync"
      ? { folderId: ctx.folderId, baseDir: ctx.baseDir || "" }
      : null;
  }
  return EditorView.domEventHandlers({
    paste(event, view) {
      const sync = collectImageFilesFromEvent(event);
      if (sync.length > 0) {
        event.preventDefault();
        const pos = view.state.selection.main.head;
        import("./file-drop.js")
          .then((m) => m.insertImagesAtPos(state, view, sync, pos, localSyncFromCtx()))
          .catch((e) => console.error("Image paste failed:", e));
        return true;
      }
      // Async fallback — only fires when sync paths returned nothing.
      // On macOS Tauri WKWebView the synchronous clipboardData is
      // sometimes empty for image bytes even though the OS clipboard
      // has them. The async Clipboard API still works while the paste
      // gesture's transient activation is alive, so kick it off without
      // preventDefault — if it finds an image we insert, otherwise CM's
      // own paste handles the (likely empty) text payload.
      readImagesViaClipboardApi().then((files) => {
        if (!files.length) return;
        const pos = view.state.selection.main.head;
        import("./file-drop.js")
          .then((m) => m.insertImagesAtPos(state, view, files, pos, localSyncFromCtx()))
          .catch((e) => console.error("Image paste (async) failed:", e));
      }).catch((e) => console.warn("[paste] clipboard.read failed:", e));
      return false;
    },
  });
}
