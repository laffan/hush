/**
 * Line Indicator — decorates the line under the primary cursor with a
 * class so a style's chosen "highlight the current line" affordance
 * (left arrow / double arrow / left border / border / highlight) can be
 * drawn via CSS. The indicator type and colour come from the active
 * style; rebuilds on selection change and on `style-changed`.
 */
import { ViewPlugin, Decoration } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";

const VARIANT_CLASSES = {
  "left-arrow": "hush-li-left-arrow",
  "double-arrow": "hush-li-double-arrow",
  "left-border": "hush-li-left-border",
  "border": "hush-li-border",
  "highlight": "hush-li-highlight",
};

/** Effect dispatched when the active style's lineIndicator changes so
 *  the plugin rebuilds even without a selection / doc event. */
export const setLineIndicatorEffect = StateEffect.define();

const lineIndicatorField = StateField.define({
  create() { return null; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setLineIndicatorEffect)) return e.value || null;
    }
    return value;
  },
});

function resolveLineIndicator(state) {
  const styleId = state.settings.activeStyleId;
  if (!styleId) return null;
  const style = (state.settings.styles || []).find(s => s.id === styleId);
  if (!style) return null;
  const v = style.lineIndicator;
  if (!v || v === "none") return null;
  return v;
}

export function createLineIndicatorPlugin(state) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.build(view);
      }

      update(update) {
        const indicatorChanged = update.transactions.some(tr =>
          tr.effects.some(e => e.is(setLineIndicatorEffect))
        );
        if (
          indicatorChanged ||
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged
        ) {
          this.decorations = this.build(update.view);
        }
      }

      build(view) {
        const indicator = view.state.field(lineIndicatorField, false) ?? resolveLineIndicator(state);
        const cls = VARIANT_CLASSES[indicator];
        if (!cls) return Decoration.none;
        const head = view.state.selection.main.head;
        const line = view.state.doc.lineAt(head);
        return Decoration.set([
          Decoration.line({ class: `hush-active-line ${cls}` }).range(line.from),
        ]);
      }
    },
    { decorations: (v) => v.decorations }
  );
}

/** Bridge AppState's `style-changed` event into every editor view so
 *  the plugin's StateField picks up the new indicator immediately,
 *  without waiting for the next selection / doc change. Called once
 *  per editor creation (main + each pane). */
export function bindLineIndicatorToState(view, state) {
  const push = () => {
    if (!view || !view.state) return;
    view.dispatch({
      effects: setLineIndicatorEffect.of(resolveLineIndicator(state)),
    });
  };
  push();
  state.on("style-changed", push);
  state.on("settings-changed", push);
}

export { lineIndicatorField };
