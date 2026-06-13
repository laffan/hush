/**
 * Doc folding — mirrors code folding for Markdown.
 *
 * Built on CodeMirror's `@codemirror/language` fold primitives
 * (`codeFolding` state field + `foldEffect` / `unfoldEffect`).  Two
 * flavours of fold are supported:
 *
 *   - **Header folding** — collapses the body under a `#…######` heading.
 *     The fold starts at the *end* of the heading line so the heading
 *     itself stays visible and the unwrap pill sits beside it.
 *   - **Selection folding** — collapses an arbitrary selected range.
 *
 * `buildFoldingExtension()` wires the shared state field with a custom
 * placeholder (the "N lines" unwrap pill).  The hover / selection fold
 * arrow lives in `fold-arrow.js`; the command-palette entries call the
 * `fold*` command helpers exported here.
 */
import { codeFolding, foldEffect, unfoldEffect, foldedRanges } from "@codemirror/language";

const HEADING_RE = /^(#{1,6})\s+\S/;

/** Heading level (1–6) of a line's text, or 0 if it isn't a heading. */
export function headingLevel(text) {
  const m = HEADING_RE.exec(text);
  return m ? m[1].length : 0;
}

/** Walk down from `line` until `isBoundary(level)` is true (or EOF) and
 *  return the fold range hiding the body (heading line stays visible),
 *  or null when there's nothing under the heading to fold. */
function rangeUntil(state, line, isBoundary) {
  const doc = state.doc;
  let endLineNum = doc.lines;
  for (let i = line.number + 1; i <= doc.lines; i++) {
    if (isBoundary(headingLevel(doc.line(i).text))) {
      endLineNum = i - 1;
      break;
    }
  }
  if (endLineNum <= line.number) return null;
  const from = line.to;
  const to = doc.line(endLineNum).to;
  if (to <= from) return null;
  return { from, to };
}

/** Section fold: hide everything under the heading up to the next
 *  heading of the SAME or HIGHER level — so folding an H1 also hides its
 *  H2 / H3 bodies.  Used by the hover arrow, "fold current section", and
 *  the per-level "Fold all Hn" commands. */
export function foldRangeForHeading(state, line) {
  const level = headingLevel(line.text);
  if (!level) return null;
  return rangeUntil(state, line, (lvl) => lvl > 0 && lvl <= level);
}

/** Body fold: hide content under the heading up to the NEXT heading of
 *  ANY level — keeps the full outline visible.  Used by "fold all
 *  sections" so every heading line survives the collapse. */
export function foldBodyForHeading(state, line) {
  if (!headingLevel(line.text)) return null;
  return rangeUntil(state, line, (lvl) => lvl > 0);
}

/** True when two ranges share interior space (touching edges don't count). */
function overlaps(a, b) {
  return a.from < b.to && b.from < a.to;
}

/** Snapshot of every currently-folded range. */
function currentFolds(state) {
  const out = [];
  const cur = foldedRanges(state).iter();
  while (cur.value) {
    out.push({ from: cur.from, to: cur.to });
    cur.next();
  }
  return out;
}

/** Find a fold that starts at, or fully contains, `pos`. */
export function findFoldAt(state, pos) {
  let res = null;
  foldedRanges(state).between(pos, pos, (from, to) => {
    if (from === pos || (from < pos && to > pos)) {
      res = { from, to };
      return false;
    }
  });
  return res;
}

/** True when `range` is already (exactly or by containment) folded. */
export function isRangeFolded(state, range) {
  let folded = false;
  foldedRanges(state).between(range.from, range.to, (from, to) => {
    if (from <= range.from && to >= range.to) {
      folded = true;
      return false;
    }
  });
  return folded;
}

/** Dispatch fold effects for `candidates`, dropping any that would
 *  overlap an existing fold or an earlier candidate — overlapping
 *  replace decorations would otherwise crash the view layer. Returns
 *  true when at least one fold was applied. */
export function applyFolds(view, candidates) {
  const accepted = currentFolds(view.state);
  const added = [];
  for (const r of candidates) {
    if (!r || r.to <= r.from) continue;
    if (accepted.some((x) => overlaps(x, r) || (x.from === r.from && x.to === r.to))) continue;
    accepted.push(r);
    added.push(r);
  }
  if (!added.length) return false;
  const spec = { effects: added.map((r) => foldEffect.of(r)) };
  // CodeMirror auto-clears a fold whose interior holds the caret on the
  // next selection-bearing transaction. If the caret (or selection)
  // would be stranded inside a freshly folded range, park a cursor at
  // the fold's start (heading line / selection start) so it sticks.
  const sel = view.state.selection.main;
  const strand = added.find(
    (r) => (sel.head > r.from && sel.head <= r.to) ||
           (!sel.empty && sel.from >= r.from && sel.to <= r.to)
  );
  if (strand) spec.selection = { anchor: strand.from };
  view.dispatch(spec);
  return true;
}

/** Nearest heading line at or above `lineNumber`, or null. */
function headingAtOrAbove(state, lineNumber) {
  for (let i = lineNumber; i >= 1; i--) {
    const line = state.doc.line(i);
    if (headingLevel(line.text)) return line;
  }
  return null;
}

/** Fold the section the cursor sits in (nearest heading at/above). */
export function foldCurrentSection(view) {
  const { state } = view;
  const head = state.selection.main.head;
  const hLine = headingAtOrAbove(state, state.doc.lineAt(head).number);
  if (!hLine) return false;
  const range = foldRangeForHeading(state, hLine);
  return range ? applyFolds(view, [range]) : false;
}

/** Unfold the fold at the cursor, else the section of the nearest
 *  heading at/above the cursor. */
export function unfoldCurrentSection(view) {
  const { state } = view;
  const head = state.selection.main.head;
  const direct = findFoldAt(state, head);
  if (direct) {
    view.dispatch({ effects: unfoldEffect.of(direct) });
    return true;
  }
  const hLine = headingAtOrAbove(state, state.doc.lineAt(head).number);
  if (!hLine) return false;
  const range = foldRangeForHeading(state, hLine);
  if (!range) return false;
  const f = findFoldAt(state, range.from) || (isRangeFolded(state, range) ? range : null);
  if (!f) return false;
  view.dispatch({ effects: unfoldEffect.of(f) });
  return true;
}

/** Fold the current (non-empty) selection. */
export function foldSelection(view) {
  const sel = view.state.selection.main;
  if (sel.empty) return false;
  return applyFolds(view, [{ from: sel.from, to: sel.to }]);
}

/** Fold the section under every heading of `level` (1/2/3…). */
export function foldAllAtLevel(view, level) {
  const { state } = view;
  const ranges = [];
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    if (headingLevel(line.text) === level) {
      const r = foldRangeForHeading(state, line);
      if (r) ranges.push(r);
    }
  }
  return applyFolds(view, ranges);
}

/** Collapse the body of every heading, leaving the full outline visible. */
export function foldAllSections(view) {
  const { state } = view;
  const ranges = [];
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    if (headingLevel(line.text)) {
      const r = foldBodyForHeading(state, line);
      if (r) ranges.push(r);
    }
  }
  return applyFolds(view, ranges);
}

/** Unfold everything in the document. */
export function unfoldAllSections(view) {
  const folds = currentFolds(view.state);
  if (!folds.length) return false;
  view.dispatch({ effects: folds.map((f) => unfoldEffect.of(f)) });
  return true;
}

/** The shared fold state field + custom unwrap pill. The pill reports
 *  how many lines the fold hides and unfolds itself on click. */
export function buildFoldingExtension() {
  return codeFolding({
    preparePlaceholder: (state, range) => {
      const lines = state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number;
      return { lines: Math.max(1, lines) };
    },
    placeholderDOM: (view, onclick, prepared) => {
      const el = document.createElement("span");
      el.className = "hush-fold-pill";
      const n = prepared?.lines || 1;
      el.textContent = `▸ ${n} ${n === 1 ? "line" : "lines"}`;
      el.title = "Unfold";
      el.setAttribute("aria-label", `Unfold ${n} ${n === 1 ? "line" : "lines"}`);
      el.onclick = onclick;
      return el;
    },
  });
}
