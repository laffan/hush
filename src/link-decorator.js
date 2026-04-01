/**
 * Markdown link decorator — hides URL portion of [text](url) links
 * when the cursor is not inside them, and makes rendered links clickable.
 */
import { ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

// Matches [text](url) but not ![alt](img)
const LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;

class LinkWidget extends WidgetType {
  constructor(text, url) {
    super();
    this.text = text;
    this.url = url;
  }

  eq(other) {
    return this.text === other.text && this.url === other.url;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-link-rendered";
    span.textContent = this.text;
    span.title = this.url;
    span.addEventListener("mousedown", (e) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        window.open(this.url, "_blank");
      }
    });
    return span;
  }

  ignoreEvent(e) {
    // true = CM ignores the event (our DOM handler still fires)
    // false = CM processes the event (cursor moves into link, widget removed)
    if (e.type === "mousedown" && (e.metaKey || e.ctrlKey)) {
      return true; // CM ignores → widget stays, our handler opens URL
    }
    return false; // CM processes → cursor enters link, raw markdown shown
  }
}

function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  const cursors = view.state.selection.ranges.map(r => ({
    from: Math.min(r.from, r.to),
    to: Math.max(r.from, r.to),
  }));

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    LINK_RE.lastIndex = 0;
    let match;
    while ((match = LINK_RE.exec(line.text)) !== null) {
      const from = line.from + match.index;
      const to = from + match[0].length;
      const text = match[1];
      const url = match[2];

      // Skip if any cursor/selection overlaps this link
      const cursorInside = cursors.some(c =>
        (c.from >= from && c.from <= to) || (c.to >= from && c.to <= to) ||
        (c.from <= from && c.to >= to)
      );
      if (cursorInside) continue;

      builder.add(from, to, Decoration.replace({
        widget: new LinkWidget(text, url),
      }));
    }
  }
  return builder.finish();
}

export function createLinkDecoratorPlugin() {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = buildDecorations(view);
      }
      update(update) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
}
