/**
 * CodeMirror paste handler that intercepts rich HTML (Google Docs, Word,
 * Notion, browser selections) and inserts the converted markdown at the
 * cursor instead of the raw text. When the clipboard payload doesn't
 * look rich, returns false so CodeMirror's default plain-text paste
 * (or the image-paste extension behind it) handles the event.
 *
 * Image paste outranks this (`Prec.high` in both extension lists), so a
 * clipboard payload carrying image bytes never reaches here — image-paste
 * calls preventDefault and stops the chain.
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
      // Empty is a refusal, not a result. WebKit hands over `text/html`
      // for some image copies — `<p><img …></p>` passes the rich-tag
      // test and renders to nothing — and claiming the event to insert
      // "" swallowed the paste whole.
      if (!md) return false;
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
