/**
 * Zen Focus keeps its hands off titles. The line a document is named by
 * (state-naming.js#deriveName's: the first content-bearing line after
 * the frontmatter, cards and tab markers — one per part in a project's
 * joined buffer) is drawn faded, takes no edits and can't hold the
 * caret: a caret sent onto it lands on the line after it (or, moving
 * up, on the line before it, when there is one).
 *
 * The titles are the ones the document had when Zen opened, mapped
 * through the edits made since. Detecting them live would lock the
 * first line of an empty document the moment its first letter was
 * typed. A document that is nothing but its title is given a line
 * under it to write on.
 *
 * This is what made Write Now's ten blank lines unnecessary: they were
 * there to keep the caret clear of the timestamp it heads the document
 * with.
 */
import { EditorView, Decoration } from "@codemirror/view";
import { StateField, EditorState, Annotation, RangeSetBuilder } from "@codemirror/state";
import { findFrontmatterRange } from "./frontmatter.js";
import { parseTabMarkerLine } from "./tabs.js";
import { programmaticChange } from "./base-extensions.js";

const SEPARATOR_LINE = "---hush-separator---";
/** Lets the lock's own edit (the line under a lone title) through. */
const lockEdit = Annotation.define();
const titleLine = Decoration.line({ class: "zen-title-locked" });

/** The title lines of `doc` as `{ from, to }` (line start and end). */
export function findTitleLines(doc) {
  const out = [];
  const text = doc.toString();
  let partStart = true;   // at the head of a part, looking for its title
  let fmEnd = -1;         // end of this part's frontmatter, if any
  let inCard = false;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (line.text === SEPARATOR_LINE) { partStart = true; inCard = false; fmEnd = -1; continue; }
    if (!partStart) continue;
    if (fmEnd < 0) {
      const fm = findFrontmatterRange(text.slice(line.from));
      fmEnd = fm ? line.from + fm.to : line.from - 1;
      if (fm) continue;
    }
    if (line.from <= fmEnd) continue;
    if (line.text === "<<<") { inCard = true; continue; }
    if (line.text === ">>>") { inCard = false; continue; }
    const trimmed = line.text.trim();
    if (inCard || !trimmed || parseTabMarkerLine(trimmed)) continue;
    if (!trimmed.replace(/^#+\s*/, "").trim()) continue;
    out.push({ from: line.from, to: line.to });
    partStart = false;
  }
  return out;
}

const titlesField = StateField.define({
  create: (state) => findTitleLines(state.doc),
  update(titles, tr) {
    if (!tr.docChanged) return titles;
    return titles
      .map((t) => ({ from: tr.changes.mapPos(t.from, 1), to: tr.changes.mapPos(t.to, -1) }))
      .filter((t) => t.to >= t.from);
  },
  provide: (f) => EditorView.decorations.from(f, (titles) => {
    const b = new RangeSetBuilder();
    for (const t of titles) b.add(t.from, t.from, titleLine);
    return b.finish();
  }),
});

const inTitle = (titles, pos) => titles.find((t) => pos >= t.from && pos <= t.to);

/** Where a caret sent to `pos` inside `title` goes instead: the line
 *  after the title, or — moving up from below it — the end of the line
 *  before it, if there is one. */
function caretOutside(state, title, pos, prevHead) {
  const doc = state.doc;
  if (prevHead > title.to && title.from > 0) return title.from - 1;
  if (title.to < doc.length) return title.to + 1;
  return title.from > 0 ? title.from - 1 : pos;
}

const lockFilter = EditorState.transactionFilter.of((tr) => {
  if (tr.annotation(lockEdit) || tr.annotation(programmaticChange)) return tr;
  const titles = tr.startState.field(titlesField, false);
  if (!titles?.length) return tr;
  if (tr.docChanged) {
    let touches = false;
    tr.changes.iterChangedRanges((fromA, toA) => {
      if (titles.some((t) => fromA <= t.to && toA >= t.from)) touches = true;
    });
    if (touches) return [];
  }
  if (!tr.selection) return tr;
  // Only a caret is moved off a title: a selection running across one
  // (select-all, a drag) may still be made — it's only refused an edit.
  const sel = tr.selection.main;
  if (!sel.empty) return tr;
  const after = tr.docChanged ? tr.state.field(titlesField, false) || titles : titles;
  const title = inTitle(after, sel.head);
  if (!title) return tr;
  const prev = tr.startState.selection.main.head;
  const head = caretOutside(tr.state, title, sel.head, tr.docChanged ? tr.changes.mapPos(prev) : prev);
  if (head === sel.head) return tr;
  return [tr, { selection: { anchor: head }, sequential: true }];
});

/** The extension Zen's editor carries. */
export function zenTitleLock() {
  return [titlesField, lockFilter];
}

/** Once Zen's editor is up: give a lone title a line to write on, and
 *  move a caret that opened on a title off it. */
export function settleZenTitleLock(view) {
  const titles = view.state.field(titlesField, false);
  if (!titles?.length) return;
  const last = titles[titles.length - 1];
  if (last.to === view.state.doc.length) {
    view.dispatch({ changes: { from: last.to, insert: "\n" }, annotations: lockEdit.of(true), userEvent: "input" });
  }
  const head = view.state.selection.main.head;
  const title = inTitle(view.state.field(titlesField), head);
  if (title && view.state.selection.main.empty) {
    view.dispatch({ selection: { anchor: caretOutside(view.state, title, head, -1) }, annotations: lockEdit.of(true), scrollIntoView: true });
  }
}
