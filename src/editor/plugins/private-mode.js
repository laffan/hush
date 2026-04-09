/**
 * Private mode — CodeMirror ViewPlugin that either:
 * 1. "blackout" — wraps each non-whitespace character with opaque boxes
 * 2. "dummy"    — replaces ALL visible characters with a dummy document
 */
import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

const privateCharMark = Decoration.mark({ class: "hush-private-char" });

function buildDecorations(view, stateRef) {
  if (!stateRef.privateMode) return Decoration.none;

  const mode = stateRef.settings.privacyMode || "blackout";

  if (mode === "dummy" && stateRef.settings.dummyText) {
    return buildDummyDecorations(view, stateRef.settings.dummyText);
  }

  // Default: blackout mode
  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
        builder.add(from + i, from + i + 1, privateCharMark);
      }
    }
  }
  return builder.finish();
}

/**
 * Dummy mode: each LINE gets a stable offset into the dummy text based
 * on its line number (lineNum * 997, a large prime).  Within the line,
 * characters advance sequentially from that offset.
 *
 * Editing on line N only shifts dummy chars on line N.
 * All other lines stay completely stable.
 */
function buildDummyDecorations(view, dummyText) {
  const builder = new RangeSetBuilder();
  const dummyLen = dummyText.length;
  if (dummyLen === 0) return Decoration.none;
  const doc = view.state.doc;

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const lineStart = Math.max(line.from, from);
      const lineEnd = Math.min(line.to, to);
      const lineOffset = (line.number * 997) % dummyLen;
      const lineText = line.text;

      for (let i = lineStart; i <= lineEnd; i++) {
        const chIdx = i - line.from;
        if (chIdx >= lineText.length) break;
        if (lineText[chIdx] === "\n") continue;
        const dummyChar = dummyText[(lineOffset + chIdx) % dummyLen];
        builder.add(i, i + 1, Decoration.mark({
          class: "hush-dummy-char",
          attributes: { "data-dummy": dummyChar },
        }));
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export function createPrivateModePlugin(stateRef) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = buildDecorations(view, stateRef);
      }

      update(update) {
        this.decorations = buildDecorations(update.view, stateRef);
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
