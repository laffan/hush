/**
 * Opening an Inbox document from its preview card: the caret goes back
 * to where the preview says the work stopped, that line is scrolled to
 * the middle, and the stretch of text the preview showed glows for a
 * moment — so the card and the page are visibly the same words.
 *
 * The glow is a mark decoration from a field added to the editor the
 * first time it is needed (`StateEffect.appendConfig`), so editors that
 * never open from the Inbox carry nothing. The range comes from the
 * same excerpt the card drew (inbox-preview.js#docExcerpt), read from the
 * editor's own text, and maps through any edit made while it glows.
 */
import { EditorView, Decoration } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import { docExcerpt } from "./inbox-preview.js";
import { docCaret } from "./inbox-preview-store.js";

const GLOW_MS = 1400;

const setFlash = StateEffect.define();
const flashMark = Decoration.mark({ class: "hush-inbox-flash" });
const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setFlash)) return e.value ? Decoration.set([flashMark.range(e.value.from, e.value.to)]) : Decoration.none;
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

let clearTimer = 0;

/** Put the caret at the document's remembered spot in `view` and glow
 *  the excerpt round it. Does nothing when there is no remembered spot. */
export function flashInboxExcerpt(view, fileId) {
  const caret = docCaret(fileId);
  if (!view || !Number.isFinite(caret)) return;
  const text = view.state.doc.toString();
  const head = Math.max(0, Math.min(caret, text.length));
  const { from, to } = docExcerpt(text, head);
  const effects = [EditorView.scrollIntoView(head, { y: "center" })];
  if (!view.state.field(flashField, false)) effects.unshift(StateEffect.appendConfig.of(flashField));
  if (to > from) effects.push(setFlash.of({ from, to }));
  view.dispatch({ selection: { anchor: head }, effects });
  view.focus();
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    if (view.state.field(flashField, false)) view.dispatch({ effects: setFlash.of(null) });
  }, GLOW_MS);
}
