/**
 * Obsidian-style callout support for CodeMirror 6.
 *
 * Renders callout blocks like:
 *   > [!note] Title
 *   > Content here
 *
 * As styled blocks with colored left border, tinted background, and formatted title.
 */
import { ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

/** Default callout colors matching Obsidian defaults */
export const CALLOUT_COLORS = {
  NOTE: "#086ddd",
  INFO: "#086ddd",
  TIP: "#00bfbc",
  HINT: "#00bfbc",
  IMPORTANT: "#00bfbc",
  WARNING: "#ec7500",
  CAUTION: "#ec7500",
  ATTENTION: "#ec7500",
  DANGER: "#e93147",
  BUG: "#e93147",
  ERROR: "#e93147",
  FAIL: "#e93147",
  SUCCESS: "#08b94e",
  CHECK: "#08b94e",
  DONE: "#08b94e",
  QUESTION: "#ec7500",
  HELP: "#ec7500",
  FAQ: "#ec7500",
  EXAMPLE: "#7852ee",
  QUOTE: "#7852ee",
  CITE: "#7852ee",
  ABSTRACT: "#00bfbc",
  TLDR: "#00bfbc",
  SUMMARY: "#b8b8b8",
  TODO: "#ffd700",
  MISSING: "#e93147",
  DEFAULT: "#086ddd",
};

/**
 * Get the color for a callout type.
 */
export function getCalloutColor(type) {
  return CALLOUT_COLORS[type.toUpperCase()] || CALLOUT_COLORS.DEFAULT;
}

/**
 * Parse hex color to rgb components.
 */
function hexToRgb(hex) {
  hex = hex.replace("#", "");
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

/**
 * Create a CodeMirror ViewPlugin that decorates callout blocks.
 */
export function createCalloutPlugin() {
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

        for (let i = 1; i <= doc.lines; i++) {
          const line = doc.line(i);
          const text = line.text;

          // Check for callout start: > [!type] optional title
          const match = text.match(/^\s*>\s*\[!(\w+)\]\s*(.*)/);
          if (!match) continue;

          const type = match[1].toUpperCase();
          const color = getCalloutColor(type);
          const { r, g, b } = hexToRgb(color);

          // Find all continuation lines (lines starting with >)
          let endLine = i;
          for (let j = i + 1; j <= doc.lines; j++) {
            if (/^\s*>/.test(doc.line(j).text)) {
              endLine = j;
            } else {
              break;
            }
          }

          // Decorate each line of the callout block
          for (let j = i; j <= endLine; j++) {
            const calloutLine = doc.line(j);
            const isFirst = j === i;
            builder.add(
              calloutLine.from,
              calloutLine.from,
              Decoration.line({
                class: isFirst
                  ? "cm-callout-line cm-callout-first"
                  : "cm-callout-line",
                attributes: {
                  style: `border-left: 3px solid ${color}; background: rgba(${r},${g},${b},0.06); padding-left: 8px; margin-left: -11px;`,
                  "data-callout-type": type.toLowerCase(),
                },
              })
            );
          }
        }

        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}
