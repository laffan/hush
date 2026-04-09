/**
 * Private mode — CodeMirror ViewPlugin that either:
 * 1. "blackout" — wraps each non-whitespace character with opaque boxes
 * 2. "decoy"   — replaces ALL visible characters with a decoy document
 */
import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

const privateCharMark = Decoration.mark({ class: "hush-private-char" });

function buildDecorations(view, stateRef) {
  if (!stateRef.privateMode) return Decoration.none;

  const mode = stateRef.settings.privacyMode || "blackout";

  if (mode === "decoy" && stateRef.settings.decoyText) {
    return buildDecoyDecorations(view, stateRef.settings.decoyText);
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
 * Decoy mode: each LINE gets a stable offset into the decoy text based
 * on its line number (lineNum * 997, a large prime).  Within the line,
 * characters advance sequentially from that offset.
 *
 * This means editing on line N only shifts decoy chars on line N.
 * All other lines stay completely stable.  The only disruption is when
 * inserting/deleting entire lines (changing line numbers), which is
 * much rarer than character edits.
 */
function buildDecoyDecorations(view, decoyText) {
  const builder = new RangeSetBuilder();
  const decoyLen = decoyText.length;
  if (decoyLen === 0) return Decoration.none;
  const doc = view.state.doc;

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const lineStart = Math.max(line.from, from);
      const lineEnd = Math.min(line.to, to);
      // Stable per-line offset: line number * large prime
      const lineOffset = (line.number * 997) % decoyLen;

      for (let i = lineStart; i <= lineEnd; i++) {
        const ch = doc.sliceDoc(i, i + 1);
        if (ch === "\n" || ch === "") continue;
        const charInLine = i - line.from;
        const decoyChar = decoyText[(lineOffset + charInLine) % decoyLen];
        builder.add(i, i + 1, Decoration.mark({
          class: "hush-decoy-char",
          attributes: { "data-decoy": decoyChar },
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
