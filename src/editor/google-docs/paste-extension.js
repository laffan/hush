/**
 * CodeMirror paste handler that intercepts rich HTML (Google Docs, Word,
 * Notion, browser selections) and inserts the converted markdown at the
 * cursor instead of the raw text. When the clipboard payload doesn't
 * look rich, returns false so CodeMirror's default plain-text paste
 * (or the image-paste extension behind it) handles the event.
 *
 * Mounted in `editor.js` *after* `createImagePasteExtension`, so an image
 * paste still wins for clipboard payloads that include image bytes —
 * image-paste calls preventDefault and stops the chain before this
 * handler sees the event.
 */
import { EditorView } from "@codemirror/view";
import { htmlToMarkdown } from "./html-to-markdown.js";

export function createGoogleDocsPasteExtension() {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const cd = event.clipboardData;
      if (!cd) return false;
      const html = cd.getData("text/html");
      if (!html) return false;
      const md = htmlToMarkdown(html);
      if (md == null) return false;
      event.preventDefault();
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: md },
        selection: { anchor: sel.from + md.length },
        scrollIntoView: true,
      });
      return true;
    },
  });
}
