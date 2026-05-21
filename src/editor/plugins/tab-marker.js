/**
 * Renders `---Tab name---` lines as a compact pill in the editor and
 * adds the matching `.cm-tab-marker-line` class to the line itself so
 * styles in `editor.css` can adjust margins, font weight, etc.
 *
 * The pill replaces the entire line's contents while the cursor is on
 * a different line; when the cursor enters the marker line, the raw
 * text re-appears so the user can edit the name or remove the marker.
 *
 * Mirrors the on/off behaviour the heading-indent plugin uses for `#`
 * markers — markers should be visible exactly when the user needs them.
 */
import { ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { parseTabMarkerLine } from "../tabs.js";

class TabPillWidget extends WidgetType {
  constructor(name) {
    super();
    this.name = name;
  }
  eq(other) { return other instanceof TabPillWidget && this.name === other.name; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-tab-marker-pill";
    const label = document.createElement("span");
    label.className = "cm-tab-marker-label";
    label.textContent = this.name;
    span.appendChild(label);
    return span;
  }
  ignoreEvent() { return false; }
}

export function createTabMarkerPlugin() {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.build(view);
      }
      update(update) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = this.build(update.view);
        }
      }
      build(view) {
        const builder = new RangeSetBuilder();
        const doc = view.state.doc;
        const cursors = view.state.selection.ranges.map((r) => ({
          from: Math.min(r.from, r.to),
          to: Math.max(r.from, r.to),
        }));
        for (let i = 1; i <= doc.lines; i++) {
          const line = doc.line(i);
          const name = parseTabMarkerLine(line.text);
          if (name == null) continue;
          builder.add(
            line.from,
            line.from,
            Decoration.line({ class: "cm-tab-marker-line" }),
          );
          const cursorInside = cursors.some(
            (c) => c.from <= line.to && c.to >= line.from,
          );
          if (cursorInside) continue;
          builder.add(
            line.from,
            line.to,
            Decoration.replace({ widget: new TabPillWidget(name) }),
          );
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}
