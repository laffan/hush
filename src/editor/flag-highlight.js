import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

export function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function createFlagHighlightPlugin(stateRef) {
  const highlightRegex = /==[^=]+==/g;
  // Match `==NAME==`, `==NAME:==`, or `==NAME:content==`. The colon and
  // any trailing content are optional so a bare flag (`==MISSING==`)
  // still picks up its configured colour.
  const flagRegex = /^==([A-Za-z][A-Za-z0-9_-]{0,24})(?::[^=]*)?==$/;
  const defaultColor = "rgba(255, 208, 0, 0.3)";
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.buildDecorations(view);
      }
      update(update) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.buildDecorations(update.view);
        }
      }
      buildDecorations(view) {
        const builder = new RangeSetBuilder();
        const doc = view.state.doc.toString();
        const colors = stateRef.settings.flagColors || {};
        let match;
        highlightRegex.lastIndex = 0;
        while ((match = highlightRegex.exec(doc)) !== null) {
          const flagMatch = match[0].match(flagRegex);
          let bg = defaultColor;
          if (flagMatch) {
            const color = colors[flagMatch[1].toUpperCase()];
            if (color) bg = hexToRgba(color, 0.3);
          }
          builder.add(
            match.index,
            match.index + match[0].length,
            Decoration.mark({ attributes: { style: `background-color: ${bg}; border-radius: 2px` } })
          );
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}
