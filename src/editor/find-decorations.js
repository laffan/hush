/**
 * Editor decorations driven by the Find panel.
 *
 * The sidebar Find panel pushes its current set of matches (and which one
 * is "current") into the active editor via `setFindHighlights`. We hold
 * them in a StateField so they survive transactions and repaint via the
 * `cm-find-match` / `cm-find-match-current` classes.
 */

import { StateField, StateEffect } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";

export const setFindHighlightsEffect = StateEffect.define();

const matchDeco = Decoration.mark({ class: "cm-find-match" });
const currentDeco = Decoration.mark({ class: "cm-find-match cm-find-match-current" });

function buildSet(matches, current) {
  if (!matches || matches.length === 0) return Decoration.none;
  const sorted = matches
    .map((m, i) => ({ from: m.from, to: m.to, i }))
    .sort((a, b) => a.from - b.from);
  const ranges = sorted.map(m =>
    (m.i === current ? currentDeco : matchDeco).range(m.from, m.to)
  );
  return Decoration.set(ranges, true);
}

export const findHighlightField = StateField.define({
  create() { return Decoration.none; },
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFindHighlightsEffect)) {
        next = buildSet(e.value.matches, e.value.current);
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Push a fresh set of matches to the editor.
 *  `matches` is an array of `{from, to}`; `current` is the index of the
 *  highlighted-as-current match (or -1 for none). */
export function setFindHighlights(view, matches, current) {
  if (!view) return;
  view.dispatch({ effects: setFindHighlightsEffect.of({ matches: matches || [], current: current ?? -1 }) });
}

export function clearFindHighlights(view) {
  setFindHighlights(view, [], -1);
}
