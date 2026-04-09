/**
 * Private mode — CodeMirror ViewPlugin that either:
 * 1. "blackout" — wraps each non-whitespace character with opaque boxes
 * 2. "decoy"   — replaces visible text with characters from a decoy document
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
      // Only decorate non-whitespace characters
      if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
        builder.add(from + i, from + i + 1, privateCharMark);
      }
    }
  }
  return builder.finish();
}

function buildDecoyDecorations(view, decoyText) {
  const builder = new RangeSetBuilder();
  const decoyLen = decoyText.length;
  if (decoyLen === 0) return Decoration.none;

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\n" || ch === "\r") continue; // keep line breaks as-is
      // Map document position to a decoy character
      const docPos = from + i;
      const decoyChar = decoyText[docPos % decoyLen];
      // Use a widget-like replacement: wrap the char and use CSS content
      const replacement = (ch === " " || ch === "\t")
        ? decoyChar === " " || decoyChar === "\t" ? null : null // keep whitespace
        : Decoration.mark({
            class: "hush-decoy-char",
            attributes: { "data-decoy": decoyChar }
          });
      if (replacement) {
        builder.add(from + i, from + i + 1, replacement);
      }
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
        // Rebuild on doc changes, viewport changes, or mode toggle
        this.decorations = buildDecorations(update.view, stateRef);
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
