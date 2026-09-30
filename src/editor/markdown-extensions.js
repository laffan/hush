import { Tag } from "@lezer/highlight";

// Custom tags for our extensions. Comment / Highlight content and their
// `%%` / `==` delimiters get separate tags so the markers can render at
// a much lower opacity than the wrapped content — otherwise the dense
// punctuation reads louder than the prose it's annotating.
export const commentTag = Tag.define();
export const commentMarkTag = Tag.define();
export const highlightTag = Tag.define();
export const highlightMarkTag = Tag.define();

// Custom inline parser for %% comments %%
// NB: the node names are deliberately *not* "Comment"/"CommentBlock" —
// @lezer/markdown ships a built-in styleTag mapping those names to
// `tags.comment`, so a node named "Comment" would inherit the active
// theme's code-comment colour (e.g. Smoothy's #CFCFCF) on top of our
// own `commentTag`, fighting the style's text colour and surviving the
// opacity dim. The "Hush" prefix keeps our comments on `commentTag` only.
const CommentDelim = { resolve: "HushComment", mark: "HushCommentMark" };
export const CommentExtension = {
  defineNodes: [
    { name: "HushComment", style: commentTag },
    { name: "HushCommentMark", style: commentMarkTag },
  ],
  parseInline: [{
    name: "HushComment",
    parse(cx, next, pos) {
      if (next !== 37 /* % */ || cx.char(pos + 1) !== 37) return -1;
      // Don't match %%%
      if (cx.char(pos + 2) === 37) return -1;
      return cx.addDelimiter(CommentDelim, pos, pos + 2, true, true);
    },
    after: "Emphasis"
  }]
};

// Custom inline parser for == highlight ==
const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };
export const HighlightExtension = {
  defineNodes: [
    { name: "Highlight", style: highlightTag },
    { name: "HighlightMark", style: highlightMarkTag },
  ],
  parseInline: [{
    name: "Highlight",
    parse(cx, next, pos) {
      if (next !== 61 /* = */ || cx.char(pos + 1) !== 61) return -1;
      // Don't match ===
      if (cx.char(pos + 2) === 61) return -1;
      return cx.addDelimiter(HighlightDelim, pos, pos + 2, true, true);
    },
    after: "Emphasis"
  }]
};

// Card fences (cards/card-model.ts) claimed as blocks of their own, so
// CommonMark never reads them as something else. A line that is exactly
// `>>>` is three nested, empty blockquotes to it — which pulled the line
// after a card into a quote (italic) and made Enter continue it — and
// `<<<` would otherwise run on as part of the paragraph above it. Each
// fence is one line; an unclosed `<<<` claims nothing past itself.
function isCardFenceLine(_cx, line) {
  return line.pos === 0 && (line.text === ">>>" || line.text === "<<<");
}
export const CardFenceExtension = {
  defineNodes: [{ name: "CardFence", block: true }],
  parseBlock: [{
    name: "CardFence",
    before: "Blockquote",
    parse(cx, line) {
      if (!isCardFenceLine(cx, line)) return false;
      cx.addElement(cx.elt("CardFence", cx.lineStart, cx.lineStart + line.text.length));
      cx.nextLine();
      return true;
    },
    endLeaf(cx, line) { return isCardFenceLine(cx, line); },
  }],
};
