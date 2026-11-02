/**
 * A brief light over a range of a document — where a jump has just
 * landed (the Desk Dashboard's search results), so the eye finds it.
 *
 * The field is appended to a view's configuration the first time that
 * view is lit, rather than joining both extension lists (editor.js and
 * base-extensions.js) for a decoration that is almost never on. A later
 * full reconfigure drops it again, which is harmless: the next flash
 * appends it afresh, and a pending fade checks it is still there.
 */

import { StateField, StateEffect } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";

const setFlash = StateEffect.define();
const flashMark = Decoration.mark({ class: "cm-flash-range" });

const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFlash)) deco = e.value ? Decoration.set([flashMark.range(e.value.from, e.value.to)]) : Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** How long the light stays; its fade is the CSS animation's. */
const FLASH_MS = 1600;
const timers = new WeakMap();

/** Light `from`–`to` in `view` for a moment. */
export function flashRange(view, from, to) {
  if (!view || from >= to) return;
  const has = () => view.state.field(flashField, false) !== undefined;
  // Added in a transaction of its own: a field appended alongside an
  // effect starts from `create` and never sees that effect.
  if (!has()) view.dispatch({ effects: StateEffect.appendConfig.of(flashField) });
  view.dispatch({ effects: setFlash.of({ from, to }) });
  clearTimeout(timers.get(view));
  timers.set(view, setTimeout(() => {
    if (view.dom.isConnected && has()) view.dispatch({ effects: setFlash.of(null) });
  }, FLASH_MS));
}
