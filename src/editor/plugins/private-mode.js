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
 * Decoy mode: each document position maps to a fixed decoy character
 * via (position % decoyLength).  This means editing in the middle only
 * shifts the new character's mapping — surrounding text stays stable.
 * ALL non-newline characters (including spaces) are replaced.
 */
function buildDecoyDecorations(view, decoyText) {
  const builder = new RangeSetBuilder();
  const decoyLen = decoyText.length;
  if (decoyLen === 0) return Decoration.none;

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") continue;
      const decoyChar = decoyText[(from + i) % decoyLen];
      builder.add(from + i, from + i + 1, Decoration.mark({
        class: "hush-decoy-char",
        attributes: { "data-decoy": decoyChar },
      }));
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
