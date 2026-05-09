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
// proportional fonts. On top of the hang-indent we also push the marker
// itself in from the left margin by LIST_LEFT_INDENT_PX per nesting level so
// list blocks read as visually offset blocks (closer to Google Docs' ~50px)
// rather than hugging the column edge — and each nested level steps in
// another LIST_LEFT_INDENT_PX so depth is visible at a glance instead of
// being conveyed by the source's 2-space leading whitespace alone.
const LIST_LEFT_INDENT_PX = 30;

let _listMarkerMeasureCtx = null;

function measureListMarkerPx(view, text) {
  if (!_listMarkerMeasureCtx) {
    _listMarkerMeasureCtx = document.createElement("canvas").getContext("2d");
  }
  const cs = window.getComputedStyle(view.contentDOM);
  _listMarkerMeasureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return _listMarkerMeasureCtx.measureText(text).width;
}

// Treat each tab and each pair of leading spaces as one nesting level so
// 2-space and tab-indented lists both step in cleanly. Mixed indentation
// gets a best-effort sum.
function listNestingDepth(leading) {
  const tabs = (leading.match(/\t/g) || []).length;
  const spaces = leading.length - tabs;
  return tabs + Math.floor(spaces / 2);
}

function listIndentLineDeco(paddingPx, textIndentPx) {
  return Decoration.line({
    class: "list-indent",
    attributes: { style: `padding-left: ${paddingPx}px; text-indent: -${textIndentPx}px;` },
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
          // marker + space so continuation lines line up with the content,
          // and step the marker itself in by LIST_LEFT_INDENT_PX per nesting
          // level. The negative text-indent absorbs the source's leading
          // whitespace + marker so the rendered marker lands at the depth
          // offset regardless of how many spaces sit in front of it in
          // markdown source.
          const leading = listMatch[1];
          const markerOnly = listMatch[2] + listMatch[3];
          const fullPrefixPx = measureListMarkerPx(view, listMatch[0]);
          const markerOnlyPx = measureListMarkerPx(view, markerOnly);
          const depth = listNestingDepth(leading);
          const padding = LIST_LEFT_INDENT_PX * (depth + 1) + markerOnlyPx;
          builder.add(line.from, line.from, listIndentLineDeco(padding, fullPrefixPx));
        }
        pos = line.to + 1;
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations }
);
