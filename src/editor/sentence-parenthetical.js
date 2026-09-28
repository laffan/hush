/**
 * Parentheticals for Select sentence (⌘L) and Delete sentence (⌘⌫).
 *
 * A caret inside a `(…)` means the parenthetical first: ⌘L selects it,
 * parentheses included (as it does from a selection inside one), and ⌘⌫
 * deletes it — what's left is the sentence without it, which the next
 * ⌘⌫ takes as usual. A second ⌘L on the selected parenthetical selects
 * the sentence that contains it.
 *
 * That is an origin-only rule. It is decided from the caret the first
 * press starts from and from a selection that is exactly one
 * parenthetical; once a sentence is selected, ⌘L grows sentence by
 * sentence (`selectSentence`) and the parentheticals it passes over are
 * ordinary text.
 *
 * Pairs are matched within one line, like sentences. A link or image
 * target — `](…)` — is not a parenthetical, and neither is `()` with
 * nothing in it.
 */
import { EditorSelection } from "@codemirror/state";
import { selectSentence } from "./sentence-navigator.js";
import { findSentenceStart, findSentenceEnd, posToOffset } from "./sentence-core.js";

/** Every balanced `(…)` on a line, as character indexes. Unmatched
 *  parentheses on either side are left out. */
function parenPairs(text) {
  const pairs = [];
  const open = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 40) open.push(i);
    else if (c === 41 && open.length) pairs.push({ open: open.pop(), close: i });
  }
  return pairs;
}

function isParenthetical(text, pair) {
  if (pair.open > 0 && text.charAt(pair.open - 1) === "]") return false;
  return /\S/.test(text.slice(pair.open + 1, pair.close));
}

function toRange(line, pair) {
  return { from: line.from + pair.open, to: line.from + pair.close + 1, line, pair };
}

/** The innermost parenthetical the range `from`–`to` (a bare caret when
 *  they're equal) sits inside — after its `(` and at or before its `)` —
 *  or null. */
export function parentheticalAt(doc, from, to = from) {
  const line = doc.lineAt(from);
  if (to > line.to) return null;
  const a = from - line.from;
  const b = to - line.from;
  let best = null;
  for (const pair of parenPairs(line.text)) {
    if (pair.open < a && b <= pair.close && isParenthetical(line.text, pair)
        && (!best || pair.open > best.open)) best = pair;
  }
  return best && toRange(line, best);
}

/** The parenthetical `sel` covers exactly, parentheses included, or null. */
function selectedParenthetical(doc, sel) {
  if (sel.empty) return null;
  const line = doc.lineAt(sel.from);
  if (sel.to > line.to) return null;
  const open = sel.from - line.from;
  const close = sel.to - 1 - line.from;
  const pair = parenPairs(line.text).find((pr) => pr.open === open && pr.close === close);
  return pair && isParenthetical(line.text, pair) ? toRange(line, pair) : null;
}

/** The sentence around a parenthetical. Terminators inside the
 *  parentheses don't split it — the sentence starts before the `(` and
 *  ends after the `)` — unless the parenthetical closes on one, `(…like
 *  this.)`, which ends the sentence where it ends. */
function sentenceAround(doc, paren) {
  const { line, pair } = paren;
  const ln = line.number - 1;
  const text = line.text;
  let probe = pair.close;
  while (probe > pair.open + 1 && /["')\]}*_`]/.test(text.charAt(probe - 1))) probe--;
  const endFrom = /[.!?]/.test(text.charAt(probe - 1)) ? probe - 1 : pair.close;
  return {
    from: posToOffset(doc, findSentenceStart(doc, { line: ln, ch: pair.open })),
    to: posToOffset(doc, findSentenceEnd(doc, { line: ln, ch: endFrom })),
  };
}

/** Select sentence (⌘L), parentheticals first. */
export function selectSentenceOrParenthetical(view) {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  // Checked first: a selected parenthetical nested in another sits
  // inside that one too, and goes to its sentence, not to the outer pair.
  const paren = selectedParenthetical(doc, sel);
  if (paren) {
    const s = sentenceAround(doc, paren);
    // A parenthetical that is a sentence of its own has no larger
    // sentence to grow into; the ordinary grow takes the next one.
    if (s.from < paren.from || /\S/.test(doc.sliceString(paren.to, s.to))) {
      view.dispatch({ selection: EditorSelection.single(s.from, s.to) });
      return true;
    }
    return selectSentence(view);
  }
  // A caret — or a few words selected — inside the parentheses.
  const inside = parentheticalAt(doc, sel.from, sel.to);
  if (inside) {
    view.dispatch({ selection: EditorSelection.single(inside.from, inside.to) });
    return true;
  }
  return selectSentence(view);
}
