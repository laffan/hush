/**
 * Horizontal rules — a markdown thematic break (`---`, `***`, `___`) drawn
 * as a 1px line centred on its row, 70% of the width of the column it
 * sits in (styles/editor.css, `.cm-hush-hr`).
 *
 * The rule is a line decoration; the dashes stay in the document and only
 * stop painting. A caret or selection on the row drops the decoration so
 * the raw markdown is there to edit, like a link's reveal.
 *
 * The syntax tree decides what is a rule, so a `---` under a line of text
 * (a setext heading's underline) is never one. A leading frontmatter block
 * — at the top of the document, or of a part in a project's joined
 * buffer — opens with `---` too, and is skipped.
 */
import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { findFrontmatterRange, FRONTMATTER_SCAN_LIMIT } from "../frontmatter.js";

const SEPARATOR_LINE = "---hush-separator---";
const ruleLine = Decoration.line({ class: "cm-hush-hr" });

/** True when the rule on `line` opens a frontmatter block: the first line
 *  of the document or of a project part, with a closing delimiter below. */
function opensFrontmatter(doc, line) {
  if (line.number > 1 && doc.line(line.number - 1).text !== SEPARATOR_LINE) return false;
  const head = doc.sliceString(line.from, Math.min(doc.length, line.from + FRONTMATTER_SCAN_LIMIT));
  return !!findFrontmatterRange(head);
}

/** End offset of a frontmatter block opening at `line`. */
function frontmatterEnd(doc, line) {
  const head = doc.sliceString(line.from, Math.min(doc.length, line.from + FRONTMATTER_SCAN_LIMIT));
  const range = findFrontmatterRange(head);
  return range ? line.from + range.to : line.to;
}

function selectionTouches(state, line) {
  for (const r of state.selection.ranges) {
    if (r.from <= line.to && r.to >= line.from) return true;
  }
  return false;
}

function buildRules(view) {
  const builder = new RangeSetBuilder();
  const { state } = view;
  const doc = state.doc;
  const tree = syntaxTree(state);
  let skipTo = -1;
  let last = -1;
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (node.name !== "HorizontalRule") return;
        const line = doc.lineAt(node.from);
        if (line.from <= last || line.from < skipTo) return false;
        last = line.from;
        if (opensFrontmatter(doc, line)) {
          skipTo = frontmatterEnd(doc, line);
          return false;
        }
        if (!selectionTouches(state, line)) builder.add(line.from, line.from, ruleLine);
        return false;
      },
    });
  }
  return builder.finish();
}

export function createHorizontalRulePlugin() {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = buildRules(view);
      }

      update(update) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = buildRules(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
}
