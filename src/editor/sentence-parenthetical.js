/**
 * Bounded spans for Select sentence (⌘L); parentheticals for Delete
 * sentence (⌘⌫).
 *
 * A caret inside a part of the sentence that the same punctuation bounds
 * at both ends means that part first: ⌘L selects it, the punctuation
 * included (as it does from a selection inside one), and a second ⌘L on
 * the selected span selects the sentence that contains it. The bounds are
 *
 * - a pair that opens and closes: `(…)`, `"…"`, `“…”`, `'…'`, `‘…’`;
 * - the same mark twice: `,…,` and `—…—` — the nearest one on each side
 *   of the caret, inside the caret's sentence and at its own depth, so a
 *   comma inside a quote or a parenthetical never pairs with one outside
 *   it, and a comma between digits (`1,000`) is no bound at all.
 *
 * The innermost span wins: in `(see, for one, the map)` a caret on "for"
 * selects `, for one,`, and on "see" the parenthetical.
 *
 * ⌘⌫ deletes a parenthetical the same way — what's left is the sentence
 * without it, which the next ⌘⌫ takes as usual — but only a
 * parenthetical: deleting `, for one,` would weld its neighbours
 * together. `parentheticalAt` is its half.
 *
 * That is an origin-only rule. It is decided from the caret the first
 * press starts from and from a selection that is exactly one span; once a
 * sentence is selected, ⌘L grows sentence by sentence (`selectSentence`)
 * and the spans it passes over are ordinary text.
 *
 * Pairs are matched within one line, like sentences. A link or image
 * target — `](…)` — is not a parenthetical, and no span is empty.
 */
import { EditorSelection } from "@codemirror/state";
import { selectSentence } from "./sentence-navigator.js";
import { findSentenceStart, findSentenceEnd, posToOffset } from "./sentence-core.js";

/** Every balanced `(…)` on a line — or `[…]`, given those codes — as
 *  character indexes. Unmatched marks on either side are left out. */
function parenPairs(text, openCode = 40, closeCode = 41) {
  const pairs = [];
  const open = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === openCode) open.push(i);
    else if (c === closeCode && open.length) pairs.push({ open: open.pop(), close: i });
  }
  return pairs;
}

function isParenthetical(text, pair) {
  if (pair.open > 0 && text.charAt(pair.open - 1) === "]") return false;
  return /\S/.test(text.slice(pair.open + 1, pair.close));
}

const isWordChar = (ch) => /[\p{L}\p{N}]/u.test(ch);

/** Every quoted stretch on a line. Straight double quotes pair in order;
 *  curly ones open and close. A single quote is also the apostrophe, so
 *  `'` opens only where a word can start (not after a letter) and closes
 *  only where one has ended (not before a letter); `’` closes the same
 *  way — `don’t` inside `‘…’` stays a word. */
function quotePairs(text) {
  const pairs = [];
  let straight = -1;
  let single = -1;
  const curly = [];
  const curlySingle = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    const before = text.charAt(i - 1);
    const after = text.charAt(i + 1);
    if (c === '"') {
      if (straight < 0) straight = i;
      else { pairs.push({ open: straight, close: i }); straight = -1; }
    } else if (c === "“") curly.push(i);
    else if (c === "”") { if (curly.length) pairs.push({ open: curly.pop(), close: i }); }
    else if (c === "‘") curlySingle.push(i);
    else if (c === "’") {
      if (curlySingle.length && !isWordChar(after)) pairs.push({ open: curlySingle.pop(), close: i });
    } else if (c === "'") {
      if (single >= 0 && /\S/.test(before) && !isWordChar(after)) { pairs.push({ open: single, close: i }); single = -1; }
      else if (single < 0 && !isWordChar(before) && /\S/.test(after)) single = i;
    }
  }
  return pairs.filter((p) => /\S/.test(text.slice(p.open + 1, p.close)));
}

/** Stretches that are markup rather than prose — a link or image target
 *  `](…)` and inline code — as `[start, end]` (inclusive). No span starts
 *  in one or pairs a mark inside one with a mark outside. */
function opaqueRanges(text) {
  const ranges = parenPairs(text)
    .filter((p) => p.open > 0 && text.charAt(p.open - 1) === "]")
    .map((p) => [p.open, p.close]);
  let tick = -1;
  for (let i = 0; i < text.length; i++) {
    if (text.charAt(i) !== "`") continue;
    if (tick < 0) tick = i;
    else { ranges.push([tick, i]); tick = -1; }
  }
  return ranges;
}

/** The pairs that open and close: parentheticals and quotes, which ⌘L
 *  selects, and square brackets — a link's text, a wikilink — which it
 *  doesn't, but which no comma or dash pair may straddle either. */
function groupPairs(text, opaque) {
  const inOpaque = (i) => opaque.some(([s, e]) => s <= i && i <= e);
  const selectable = parenPairs(text).filter((p) => isParenthetical(text, p)).concat(quotePairs(text));
  const brackets = parenPairs(text, 91, 93).map((p) => ({ ...p, bracket: true }));
  return selectable.concat(brackets).filter((p) => !inOpaque(p.open) && !inOpaque(p.close));
}

/** Marks that bound a span by appearing at both of its ends. */
const SEPARATORS = [",", "—"];

function isSeparatorAt(text, i, mark) {
  if (text.charAt(i) !== mark) return false;
  // 1,000 — a digit group, not a clause.
  return !(mark === "," && /\d/.test(text.charAt(i - 1)) && /\d/.test(text.charAt(i + 1)));
}

function toRange(line, pair, group) {
  return { from: line.from + pair.open, to: line.from + pair.close + 1, line, pair, group };
}

/** The innermost pair from `pairs` that the line-relative range `a`–`b`
 *  sits inside — after its opening mark and at or before its closing
 *  one — or null. */
function innermost(pairs, a, b) {
  let best = null;
  for (const pair of pairs) {
    if (pair.open < a && b <= pair.close && (!best || pair.open > best.open)) best = pair;
  }
  return best;
}

/** The innermost parenthetical the range `from`–`to` (a bare caret when
 *  they're equal) sits inside, or null. */
export function parentheticalAt(doc, from, to = from) {
  const line = doc.lineAt(from);
  if (to > line.to) return null;
  const pairs = parenPairs(line.text).filter((p) => isParenthetical(line.text, p));
  const best = innermost(pairs, from - line.from, to - line.from);
  return best && toRange(line, best, true);
}

/** The innermost bounded span the range `from`–`to` sits inside (see the
 *  header), or null. */
function boundedSpanAt(doc, from, to = from) {
  const line = doc.lineAt(from);
  if (to > line.to) return null;
  const text = line.text;
  const a = from - line.from;
  const b = to - line.from;
  const opaque = opaqueRanges(text);
  if (opaque.some(([s, e]) => s < a && b <= e)) return null;
  const groups = groupPairs(text, opaque);
  const group = innermost(groups, a, b);
  // A separator pair stays inside the caret's own group and sentence.
  const ln = line.number - 1;
  const lo = Math.max(group ? group.open + 1 : 0, findSentenceStart(doc, { line: ln, ch: a }).ch);
  const hi = Math.min(group ? group.close : text.length, findSentenceEnd(doc, { line: ln, ch: b }).ch);
  // Characters inside a group nested in that stretch are a level down.
  const hidden = new Uint8Array(text.length);
  for (const g of groups) {
    if (g.open >= lo && g.close < hi) hidden.fill(1, g.open, g.close + 1);
  }
  for (const [start, end] of opaque) hidden.fill(1, start, end + 1);
  let best = null;
  for (const mark of SEPARATORS) {
    let left = -1;
    for (let i = a - 1; i >= lo; i--) {
      if (!hidden[i] && isSeparatorAt(text, i, mark)) { left = i; break; }
    }
    if (left < 0) continue;
    let right = -1;
    for (let i = b; i < hi; i++) {
      if (!hidden[i] && isSeparatorAt(text, i, mark)) { right = i; break; }
    }
    if (right < 0 || !/\S/.test(text.slice(left + 1, right))) continue;
    if (!best || right - left < best.close - best.open) best = { open: left, close: right };
  }
  // Any separator span lies inside the group, so it is the inner one.
  if (best) return toRange(line, best, false);
  const pick = innermost(groups.filter((g) => !g.bracket), a, b);
  return pick && toRange(line, pick, true);
}

/** The span `sel` covers exactly, its bounds included, or null. */
function selectedSpan(doc, sel) {
  if (sel.to - sel.from < 3) return null;
  const span = boundedSpanAt(doc, sel.from + 1, sel.to - 1);
  return span && span.from === sel.from && span.to === sel.to ? span : null;
}

/** The sentence around a span. Terminators inside it don't split it —
 *  the sentence starts before its opening mark and ends after its
 *  closing one — unless a parenthetical or quote closes on one, `(…like
 *  this.)`, which ends the sentence where it ends. */
function sentenceAround(doc, span) {
  const { line, pair, group } = span;
  const ln = line.number - 1;
  const text = line.text;
  let endFrom = pair.close;
  if (group) {
    let probe = pair.close;
    while (probe > pair.open + 1 && /["')\]}*_`=~”’]/.test(text.charAt(probe - 1))) probe--;
    if (/[.!?]/.test(text.charAt(probe - 1))) endFrom = probe - 1;
  }
  const from = posToOffset(doc, findSentenceStart(doc, { line: ln, ch: pair.open }));
  const to = posToOffset(doc, findSentenceEnd(doc, { line: ln, ch: endFrom }));
  // Sentence ends don't step over a curly closing quote; never return
  // less than the span itself.
  return { from: Math.min(from, span.from), to: Math.max(to, span.to) };
}

/** Select sentence (⌘L), bounded spans first. */
export function selectSentenceOrSpan(view) {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  // Checked first: a selected span nested in another sits inside that
  // one too, and goes to its sentence, not to the outer span.
  const span = selectedSpan(doc, sel);
  if (span) {
    const s = sentenceAround(doc, span);
    // A span that is a sentence of its own has no larger sentence to
    // grow into; the ordinary grow takes the next one.
    if (s.from < span.from || /\S/.test(doc.sliceString(span.to, s.to))) {
      view.dispatch({ selection: EditorSelection.single(s.from, s.to) });
      return true;
    }
    return selectSentence(view);
  }
  // A caret — or a few words selected — inside the span.
  const inside = boundedSpanAt(doc, sel.from, sel.to);
  if (inside) {
    view.dispatch({ selection: EditorSelection.single(inside.from, inside.to) });
    return true;
  }
  return selectSentence(view);
}
