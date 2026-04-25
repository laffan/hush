import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

// Plugin that hides heading `#` markers unless the cursor is on that
// heading line. When the user enters the line, the markers re-appear
// inline so they can be edited; leaving the line collapses them away.
// Previously this plugin pulled the markers into the left margin, which
// got cropped inside narrow panes.
const headingMarkerHideDeco = Decoration.replace({});

// Hang-indent wrapped list lines so the continuation aligns with the text
// after the marker. Pixel-accurate: we measure the marker's actual rendered
// width via an offscreen canvas using the editor's computed font, so the
// wrapped lines sit exactly under the first character of content — not under
// the marker, and not visibly offset as `ch` units would cause in
// proportional fonts.
let _listMarkerMeasureCtx = null;

function measureListMarkerPx(view, text) {
  if (!_listMarkerMeasureCtx) {
    _listMarkerMeasureCtx = document.createElement("canvas").getContext("2d");
  }
  const cs = window.getComputedStyle(view.contentDOM);
  _listMarkerMeasureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return _listMarkerMeasureCtx.measureText(text).width;
}

function listIndentLineDeco(px) {
  return Decoration.line({
    class: "list-indent",
    attributes: { style: `padding-left: ${px}px; text-indent: -${px}px;` },
  });
}

const blockquoteLineDeco = Decoration.line({ class: "cm-blockquote" });

export const headingIndentPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.buildDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged || update.geometryChanged
          || update.selectionSet
          || update.transactions.some(tr => tr.effects.length > 0)) {
        this.decorations = this.buildDecorations(update.view);
      }
    }
    buildDecorations(view) {
      const builder = new RangeSetBuilder();
      const { from, to } = view.viewport;
      const doc = view.state.doc;
      // A heading's markers reveal themselves when any cursor or selection
      // overlaps that line; otherwise they collapse away entirely. We check
      // ranges (not just the primary selection) so multi-cursor edits still
      // show all affected heading markers.
      const selRanges = view.state.selection.ranges;
      const lineTouchesSelection = (lineFrom, lineTo) => {
        for (const r of selRanges) {
          const rFrom = Math.min(r.from, r.to);
          const rTo = Math.max(r.from, r.to);
          if (rTo >= lineFrom && rFrom <= lineTo) return true;
        }
        return false;
      };
      for (let pos = from; pos <= to;) {
        const line = doc.lineAt(pos);
        const headingMatch = line.text.match(/^(#{1,6})\s/);
        const blockquoteMatch = !headingMatch && /^>+\s?/.test(line.text);
        const listMatch = !headingMatch && !blockquoteMatch && line.text.match(/^(\s*)([-*+]|\d+[.)])(\s+)/);
        if (headingMatch) {
          const markerEnd = line.from + headingMatch[0].length;
          // When the cursor is on the heading line, leave the markers
          // visible inline (no decoration needed — the syntax highlighter
          // already dims them to 40% opacity via tags.processingInstruction).
          // When it's not, collapse the "## " prefix away entirely.
          if (!lineTouchesSelection(line.from, line.to)) {
            builder.add(line.from, markerEnd, headingMarkerHideDeco);
          }
        } else if (blockquoteMatch) {
          // Line-level decoration so the indent + left border span the
          // wrapped continuation as well as the leading `>`.
          builder.add(line.from, line.from, blockquoteLineDeco);
        } else if (listMatch) {
          // Hang-indent wrapped lines by the actual pixel width of the
          // marker + space so continuation lines line up with the content.
          const markerPx = measureListMarkerPx(view, listMatch[0]);
          builder.add(line.from, line.from, listIndentLineDeco(markerPx));
        }
        pos = line.to + 1;
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations }
);
