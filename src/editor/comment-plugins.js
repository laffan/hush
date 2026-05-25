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
        // Pair up delimiters — only decorate pairs that span multiple
        // lines. Three decorations per pair so the literal `%%` markers
        // can fade out further than the comment body. Order matters
        // for RangeSetBuilder: ranges must be added in start-position
        // order, hence open-mark / body / close-mark.
        for (let i = 0; i + 1 < positions.length; i += 2) {
          const open = positions[i];
          const close = positions[i + 1];
          const openLine = view.state.doc.lineAt(open).number;
          const closeLine = view.state.doc.lineAt(close).number;
          if (openLine !== closeLine) {
            // Multi-line comment body opacity rides the same
            // --comment-opacity CSS var as the inline plugin so the
            // user's slider covers both. Inline `style` lets the var
            // resolve against the surrounding cascade.
            builder.add(open, open + 2, Decoration.mark({ attributes: { style: "opacity: var(--comment-mark-opacity, 0.33)" } }));
            builder.add(open + 2, close, Decoration.mark({ attributes: { style: "opacity: var(--comment-opacity, 0.5)" } }));
            builder.add(close, close + 2, Decoration.mark({ attributes: { style: "opacity: var(--comment-mark-opacity, 0.33)" } }));
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}

// Plugin that handles the "comment after" marker: ---% makes everything
// after it semi-gray, scoped to the current doc segment in project view.
// In a project the joined editor buffer concatenates several files
// separated by `---hush-separator---` lines, so the dim must close at
// the next separator rather than running through to the buffer end.
export function createCommentAfterPlugin() {
  const SEPARATOR_LINE = "---hush-separator---";
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
        let activeFrom = -1;
        for (let i = 1; i <= doc.lines; i++) {
          const line = doc.line(i);
          const trimmed = line.text.trim();
          if (activeFrom !== -1) {
            if (trimmed === SEPARATOR_LINE) {
              if (line.from > activeFrom) {
                builder.add(activeFrom, line.from, Decoration.mark({ attributes: { style: "opacity: 0.35" } }));
              }
              activeFrom = -1;
            }
            continue;
          }
          if (line.text.includes("---%")) activeFrom = line.from;
        }
        if (activeFrom !== -1 && doc.length > activeFrom) {
          builder.add(activeFrom, doc.length, Decoration.mark({ attributes: { style: "opacity: 0.35" } }));
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}
