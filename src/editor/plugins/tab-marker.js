/**
 * Renders `---Tab name---` (and nested `---Parent---/---Child---`)
 * lines as a compact pill in the editor and adds the matching
 * `.cm-tab-marker-line` class to the line itself so styles in
 * `editor.css` can adjust margins, font weight, etc.
 *
 * The pill replaces the entire line's contents while the cursor is on
 * a different line; when the caret enters the marker line, the raw
 * text re-appears so the user can edit the name(s) or remove the
 * marker. A caret strictly past `line.from` is required for the
 * reveal so a fresh file open (caret at offset 0) keeps the pill
 * rendered on a line-1 marker.
 *
 * Nested markers display as `Parent / Child / …` in the pill label.
 */
import { ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { parseTabMarkerPath, pathToLabel } from "../tabs.js";
import { GOOGLE_DOCS_ICON_SVG } from "../../google-docs/icon.js";

class TabPillWidget extends WidgetType {
  constructor(path) {
    super();
    this.path = path;
    this.label = pathToLabel(path);
  }
  eq(other) { return other instanceof TabPillWidget && other.label === this.label; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-tab-marker-pill";
    if (this.path.length > 1) span.classList.add("cm-tab-marker-nested");
    const icon = document.createElement("span");
    icon.className = "cm-tab-marker-icon";
    icon.innerHTML = GOOGLE_DOCS_ICON_SVG;
    span.appendChild(icon);
    const label = document.createElement("span");
    label.className = "cm-tab-marker-label";
    label.textContent = this.label;
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
        const ranges = view.state.selection.ranges.map((r) => ({
          from: Math.min(r.from, r.to),
          to: Math.max(r.from, r.to),
          empty: r.empty,
        }));
        for (let i = 1; i <= doc.lines; i++) {
          const line = doc.line(i);
          const path = parseTabMarkerPath(line.text);
          if (path == null) continue;
          builder.add(
            line.from,
            line.from,
            Decoration.line({ class: "cm-tab-marker-line" }),
          );
          const cursorInside = ranges.some((c) => {
            if (!c.empty) return c.from <= line.to && c.to >= line.from;
            return c.from > line.from && c.from <= line.to;
          });
          if (cursorInside) continue;
          builder.add(
            line.from,
            line.to,
            Decoration.replace({ widget: new TabPillWidget(path) }),
          );
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}
