/**
 * A to-do's notes — markdown, styled as it is typed with its marks left
 * in view, the way Things does it: `**bold**` turns bold and keeps its
 * asterisks, faint, so the note can be edited as text.
 *
 * Editing happens in a small CodeMirror editor (`mountNotes`), mounted
 * only where a note is being written: the open to-do, the file's to-do
 * at the top of the floating panel, and the composer. Closed to-dos show
 * their note as a faint preview, rendered (`notesPreviewHtml`), so a
 * long list holds no editors.
 *
 * Its own small set of extensions rather than the document editor's
 * (`createBaseExtensions`): that list carries the ratchet, cards,
 * YOU ARE HERE, word caps and the rest, none of which belong in a note
 * and some of which would act on one. The parse is the document's —
 * CommonMark with ~~strikethrough~~ and ==highlight== — so a note reads
 * as it would in a Doc.
 */
import { EditorView, keymap, placeholder as placeholderText } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { Strikethrough } from "@lezer/markdown";
import { HighlightExtension, highlightTag, highlightMarkTag } from "../editor/markdown-extensions.js";
import { markdownToHtml } from "../editor/google-docs/markdown-to-html.js";

/** The marks stay, faint; what they mark is styled. Sizes are kept close
 *  to the note's own: a heading in a note is structure, not a title. */
const noteHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: "650", fontSize: "1.18em" },
  { tag: tags.heading2, fontWeight: "650", fontSize: "1.08em" },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: "650" },
  { tag: tags.strong, fontWeight: "650" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, textDecoration: "underline", textUnderlineOffset: "2px" },
  { tag: tags.url, opacity: "0.55" },
  { tag: tags.monospace, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.92em" },
  { tag: tags.quote, fontStyle: "italic" },
  { tag: tags.processingInstruction, opacity: "0.4" },
  { tag: highlightTag, backgroundColor: "rgba(255, 214, 0, 0.28)", borderRadius: "2px" },
  { tag: highlightMarkTag, opacity: "0.4" },
]);

/** The editor takes the note's type from the list (todo.css); it only
 *  has to stop looking like an editor. */
const noteTheme = EditorView.theme({
  "&": { fontSize: "inherit", color: "inherit", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit", overflow: "visible" },
  ".cm-content": { padding: "0", caretColor: "currentColor", fontFamily: "inherit", minHeight: "inherit" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "inherit", opacity: "0.45" },
});

/**
 * Mount a notes editor into `host`.
 *
 * @param {HTMLElement} host
 * @param {object} opts
 * @param {string} [opts.value]
 * @param {string} [opts.placeholder]
 * @param {(text: string) => void} [opts.onChange]  Every edit.
 * @param {() => boolean | void} [opts.onSubmit]  ⌘↩ (the composer's
 *   "add"); without it ⌘↩ is CodeMirror's own.
 * @returns {{ view, value(): string, setValue(v: string): void,
 *   focus(at?: number | "end"): void, destroy(): void }}
 */
export function mountNotes(host, { value = "", placeholder = "Notes", onChange = null, onSubmit = null } = {}) {
  const submitKeys = onSubmit
    ? [Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => { onSubmit(); return true; } }]))]
    : [];
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: value,
      extensions: [
        ...submitKeys,
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ extensions: [Strikethrough, HighlightExtension] }),
        syntaxHighlighting(noteHighlight),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": placeholder, spellcheck: "false" }),
        placeholderText(placeholder),
        noteTheme,
        EditorView.updateListener.of((u) => { if (u.docChanged) onChange?.(u.state.doc.toString()); }),
      ],
    }),
  });
  return {
    view,
    value: () => view.state.doc.toString(),
    setValue(v) {
      const text = v || "";
      if (text === view.state.doc.toString()) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    focus(at = "end") {
      view.focus();
      const len = view.state.doc.length;
      const pos = at === "end" || at == null ? len : Math.max(0, Math.min(len, at));
      view.dispatch({ selection: { anchor: pos } });
    },
    destroy() { view.destroy(); },
  };
}

/** The element holding a notes editor, from any node inside it. */
export const notesEditorOf = (node) => (node instanceof Element ? node.closest(".cm-editor") : null);

/**
 * A closed to-do's note, rendered. Links are drawn as links but are not
 * ones: a click on a closed to-do opens it, and an `<a href>` followed
 * inside the app's webview would navigate the window away.
 */
export function notesPreviewHtml(notes) {
  if (!notes || !notes.trim()) return "";
  return markdownToHtml(notes)
    .replace(/<a href="[^"]*">/g, '<span class="todo-md-link">')
    .replace(/<\/a>/g, "</span>")
    .replace(/ style="[^"]*"/g, "");
}
