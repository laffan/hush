/**
 * Low-opacity highlight of every occurrence of the current "select
 * instance" target (Cmd+D / Cmd+Shift+D). As the user steps from one
 * instance to the next, the matching ranges stay faintly highlighted so
 * it's obvious where the remaining instances are. Any selection change
 * that *isn't* produced by the select-instance commands clears the
 * highlights (the user has moved on).
 */

import { StateField, StateEffect } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";

export const setInstanceHighlightsEffect = StateEffect.define();

const instanceDeco = Decoration.mark({ class: "cm-instance-match" });

export const instanceHighlightField = StateField.define({
  create() { return Decoration.none; },
  update(value, tr) {
    let next = value.map(tr.changes);
    let handled = false;
    for (const e of tr.effects) {
      if (e.is(setInstanceHighlightsEffect)) {
        const ranges = (e.value || [])
          .slice()
          .sort((a, b) => a.from - b.from)
          .map((r) => instanceDeco.range(r.from, r.to));
        next = Decoration.set(ranges, true);
        handled = true;
      }
    }
    // A selection change we didn't author means the user moved on — drop
    // the highlights so they don't linger.
    if (!handled && tr.selection) return Decoration.none;
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** All occurrences of `needle` in `docText` as `{from,to}` ranges. */
export function findAllOccurrences(docText, needle) {
  const out = [];
  if (!needle) return out;
  let i = 0;
  while (true) {
    const idx = docText.indexOf(needle, i);
    if (idx === -1) break;
    out.push({ from: idx, to: idx + needle.length });
    i = idx + Math.max(1, needle.length);
  }
  return out;
}
