import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

// Plugin that handles multi-line %% comment %% blocks (the inline parser only works within a single line)
export function createMultiLineCommentPlugin() {
  const commentRegex = /%%/g;
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
        const positions = [];
        let m;
        commentRegex.lastIndex = 0;
        while ((m = commentRegex.exec(doc)) !== null) {
          // Skip %%% (triple percent)
          if (doc[m.index + 2] === "%" || (m.index > 0 && doc[m.index - 1] === "%")) continue;
          positions.push(m.index);
        }
        // Pair up delimiters — only decorate pairs that span multiple lines
        for (let i = 0; i + 1 < positions.length; i += 2) {
          const open = positions[i];
          const close = positions[i + 1];
          const openLine = view.state.doc.lineAt(open).number;
          const closeLine = view.state.doc.lineAt(close).number;
          if (openLine !== closeLine) {
            builder.add(open, close + 2, Decoration.mark({ attributes: { style: "opacity: 0.4" } }));
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}

// Plugin that handles the "comment after" marker: ---% makes everything after it semi-gray
export function createCommentAfterPlugin() {
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
        const doc = view.state.doc;
        const text = doc.toString();
        const marker = "---%";
        const idx = text.indexOf(marker);
        if (idx !== -1) {
          // Apply dim styling from the marker to end of document
          const markerLine = doc.lineAt(idx);
          builder.add(markerLine.from, doc.length, Decoration.mark({ attributes: { style: "opacity: 0.35" } }));
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}
