/**
 * Opening an Inbox document from its preview card: the caret goes back
 * to where the preview says the work stopped, that line is scrolled to
 * the middle, and the word just before the caret and the word just after
 * it glow for a moment — the spot the card's text ends at, marked on the
 * page.
 *
 * The glow is a mark decoration from a field added to the editor the
 * first time it is needed (`StateEffect.appendConfig`), so editors that
 * never open from the Inbox carry nothing. The words are read from the
 * editor's own text, and the mark maps through any edit made while it
 * glows.
 */
import { EditorView, Decoration } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
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

/** The word ending at or before `pos` and the word starting at or after
 *  it, as one range — the caret in the space between them, or inside a
 *  word (which then counts as both). Empty when there are none. */
function wordsAround(text, pos) {
  const before = /\S+\s*$/.exec(text.slice(Math.max(0, pos - 200), pos));
  const after = /^\s*\S+/.exec(text.slice(pos, pos + 200));
  const from = before ? pos - before[0].length : pos;
  let to = after ? pos + after[0].length : pos;
  // Inside a word, "after" is the rest of it; take the next one too.
  if (after && !/^\s/.test(after[0]) && before && !/\s$/.test(before[0])) {
    const next = /^\s*\S+/.exec(text.slice(to, to + 200));
    if (next) to += next[0].length;
  }
  return { from, to };
}

/** Put the caret at the document's remembered spot in `view` and glow the
 *  words either side of it. Does nothing when there is no remembered
 *  spot. */
export function flashInboxExcerpt(view, fileId) {
  const caret = docCaret(fileId);
  if (!view || !Number.isFinite(caret)) return;
  const text = view.state.doc.toString();
  const head = Math.max(0, Math.min(caret, text.length));
  const { from, to } = wordsAround(text, head);
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
