/**
 * Private mode — CodeMirror ViewPlugin that either:
 * 1. "blackout" — wraps each non-whitespace character with opaque boxes
 * 2. "decoy"   — replaces ALL visible characters with a streaming decoy document
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
 * Decoy mode: walk through every non-newline character in the visible ranges
 * and replace it with the next character from the decoy text (cycling).
 * Keystrokes act as momentum — no whitespace-matching, just a straight stream.
 */
function buildDecoyDecorations(view, decoyText) {
  const builder = new RangeSetBuilder();
  const decoyLen = decoyText.length;
  if (decoyLen === 0) return Decoration.none;

  // Count non-newline chars from doc start to the first visible range
  // so we know where we are in the decoy stream.
  const firstVisible = view.visibleRanges[0]?.from ?? 0;
  let decoyIdx = 0;

  // Count chars before the visible area to keep the decoy stream consistent
  if (firstVisible > 0) {
    const preText = view.state.sliceDoc(0, firstVisible);
    for (let i = 0; i < preText.length; i++) {
      if (preText[i] !== "\n") decoyIdx++;
    }
    decoyIdx = decoyIdx % decoyLen;
  }

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") continue; // keep line breaks as-is
      const decoyChar = decoyText[decoyIdx % decoyLen];
      decoyIdx++;
      builder.add(from + i, from + i + 1, Decoration.mark({
        class: "hush-decoy-char",
        attributes: { "data-decoy": decoyChar }
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
