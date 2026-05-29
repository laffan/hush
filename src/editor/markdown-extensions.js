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
