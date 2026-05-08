/**
 * Image paste — when the clipboard payload contains image bytes
 * (e.g. a screenshot or "Copy Image" from another app), save them to
 * the Images folder and insert a markdown ref at the cursor.
 *
 * Mirrors the drag-drop image path so the same Local Sync sibling-write
 * rule applies for Local Sync docs. Lives in its own module so editor.js
 * stays under the line limit and pane editors pick it up via the same
 * `createBaseExtensions` extension list.
 */
import { EditorView } from "@codemirror/view";
import { defaultLocalSyncContext } from "./editor.js";

export function createImagePasteExtension(state, opts) {
  const getImageContext = opts?.getImageContext || (() => defaultLocalSyncContext(state));
  return EditorView.domEventHandlers({
    paste(event, view) {
      const items = event.clipboardData?.items;
      if (!items || !items.length) return false;
      const files = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === "file" && (it.type || "").startsWith("image/")) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return false;
      event.preventDefault();
      const ctx = getImageContext();
      const localSync = ctx?.kind === "localSync"
        ? { folderId: ctx.folderId, baseDir: ctx.baseDir || "" }
        : null;
      const pos = view.state.selection.main.head;
      import("./file-drop.js").then((m) => m.insertImagesAtPos(state, view, files, pos, localSync))
        .catch((e) => console.error("Image paste failed:", e));
      return true;
    },
  });
}
