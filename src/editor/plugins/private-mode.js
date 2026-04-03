/**
 * Private mode — CodeMirror ViewPlugin that wraps each non-whitespace
 * character in a Decoration.mark with class "hush-private-char",
 * rendering them as opaque boxes.
 */
import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

const privateCharMark = Decoration.mark({ class: "hush-private-char" });

function buildDecorations(view, enabled) {
  if (!enabled) return Decoration.none;

  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      // Only decorate non-whitespace characters
      if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
        builder.add(from + i, from + i + 1, privateCharMark);
      }
    }
  }
  return builder.finish();
}

export function createPrivateModePlugin(stateRef) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = buildDecorations(view, stateRef.privateMode);
      }

      update(update) {
        // Rebuild on doc changes, viewport changes, or mode toggle
        this.decorations = buildDecorations(update.view, stateRef.privateMode);
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
