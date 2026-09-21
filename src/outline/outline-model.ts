/**
 * Outlines — the shared markdown model.
 *
 * An outline is nothing but a nested markdown checklist: every item is a
 * `- [ ]` / `- [x]` line, and nesting is the leading whitespace. That is
 * the whole data format, which is what lets one outline be a block of
 * text in a Doc and a text shape on a Notebook canvas without a
 * conversion step between them — the bytes are the same either way, and
 * a doc dragged onto a canvas (or a subtree dragged into a doc) is
 * already in the other surface's format.
 *
 * Nothing in here touches the DOM, CodeMirror or the canvas: it is the
 * one place that decides what counts as an outline item, how deep it
 * sits, and which item is "next". Both renderers read their model from
 * here so they can never disagree about a document they are both
 * showing — which is the failure mode a second parser would introduce
 * the first time one of them was taught a new marker.
 */

/** One checklist line. */
export interface OutlineItem {
  /** 0-based index of the source line inside the text it was parsed from. */
  line: number;
  /** Nesting level — tabs plus every two leading spaces (see `indentDepth`). */
  depth: number;
  checked: boolean;
  /** The line with its `- [ ] ` prefix removed. Still carries inline
   *  markdown (`**bold**`, `[[wikilinks]]`, …) for the renderer to parse. */
  text: string;
}

/** A maximal run of consecutive checklist lines — one outline. */
export interface OutlineBlock {
  /** 0-based inclusive line indices bounding the run. */
  startLine: number;
  endLine: number;
  items: OutlineItem[];
}

/** A checklist line: optional indent, a bullet, a `[ ]` / `[x]` box. The
 *  space after the box is optional so a freshly-emptied item still parses
 *  (the writers below always put one back). */
const CHECK_RE = /^(\s*)([-*+])[ \t]+\[([ xX])\][ \t]?(.*)$/;

/** A plain list line — bullet or numbered, with no checkbox. What
 *  "Convert to Outline" turns into an item. */
const LIST_RE = /^(\s*)([-*+]|\d+[.)])[ \t]+(.*)$/;

/**
 * Leading whitespace → nesting level. A tab is one level and every two
 * spaces is one level, matching `heading-indent.js#listNestingDepth` and
 * the canvas's own `listDepth`, so an outline steps in by the same
 * amount on both surfaces and a round trip never re-levels itself.
 */
export function indentDepth(leading: string): number {
  const tabs = (leading.match(/\t/g) || []).length;
  return tabs + Math.floor((leading.length - tabs) / 2);
}

/** Parse one line as a checklist item, or null when it isn't one. */
export function parseOutlineLine(line: string, index = 0): OutlineItem | null {
  const m = CHECK_RE.exec(line);
  if (!m) return null;
  return {
    line: index,
    depth: indentDepth(m[1]),
    checked: m[3] !== " ",
    text: m[4],
  };
}

/** True when `line` is a bullet / numbered list item that is NOT already
 *  a checklist item — the lines "Convert to Outline" has to fix up. */
export function isPlainListLine(line: string): boolean {
  return LIST_RE.test(line) && !CHECK_RE.test(line);
}

/** True when `line` belongs to a list of either kind. */
export function isListLine(line: string): boolean {
  return LIST_RE.test(line) || CHECK_RE.test(line);
}

/**
 * Every outline in `text`: each maximal run of consecutive checklist
 * lines. A run ends at the first line that isn't one — including a blank
 * line, because an item that wrapped onto its own line would otherwise
 * swallow the prose under a list, and "every item in an outline is a
 * checklist item" is the rule that makes the block's edges unambiguous.
 */
export function findOutlineBlocks(text: string): OutlineBlock[] {
  return blocksFromLines(text.split("\n"));
}

/** `findOutlineBlocks` for callers that already hold the split lines
 *  (CodeMirror walks its own `Text`, so it never builds the string). */
export function blocksFromLines(lines: string[]): OutlineBlock[] {
  const blocks: OutlineBlock[] = [];
  let current: OutlineBlock | null = null;
  for (let i = 0; i < lines.length; i++) {
    const item = parseOutlineLine(lines[i], i);
    if (item) {
      if (current) { current.items.push(item); current.endLine = i; }
      else current = { startLine: i, endLine: i, items: [item] };
    } else if (current) {
      blocks.push(current);
      current = null;
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/** Index (into `items`) of the first unchecked item, or -1 when the
 *  outline is finished. This is the item both surfaces paint in the
 *  style's header colour: the one thing still to do. */
export function firstOpenIndex(items: OutlineItem[]): number {
  for (let i = 0; i < items.length; i++) if (!items[i].checked) return i;
  return -1;
}

/** Flip one checklist line's box. Returns the rewritten line, or null
 *  when the line isn't a checklist item. */
export function toggleChecklistLine(line: string): string | null {
  const m = CHECK_RE.exec(line);
  if (!m) return null;
  const next = m[3] === " " ? "x" : " ";
  return `${m[1]}${m[2]} [${next}] ${m[4]}`;
}

/**
 * Give every plain list line in `lines` a checkbox, leaving lines that
 * already have one alone. Returns the rewritten lines. Numbered items
 * lose their number: a checklist marker is a bullet, and `1. [ ] foo`
 * is not a task list in any markdown dialect that renders one.
 */
export function addCheckboxes(lines: string[]): string[] {
  return lines.map((line) => {
    if (!isPlainListLine(line)) return line;
    const m = LIST_RE.exec(line)!;
    const bullet = /^\d/.test(m[2]) ? "-" : m[2];
    return `${m[1]}${bullet} [ ] ${m[3]}`;
  });
}

/** The shape of a flowchart node this module needs — id, text, position. */
export interface FlowNodeLike {
  id: string;
  text?: string;
  position: { x: number; y: number };
}

/** A flowchart edge: `from` is the parent, `to` the child. */
export interface FlowEdgeLike { from: string; to: string }

/**
 * Render a flowchart subtree as a nested markdown list, using `edges` to
 * nest children under their parents. Roots are the nodes whose parent
 * isn't in the supplied set; siblings sort top-to-bottom, left-to-right,
 * so the list reads in the order the chart is laid out.
 *
 * With `checkbox` set, every line comes out as `- [ ] …` — which is the
 * whole of "Convert to Outline" on the notebook side, because a flowchart
 * and an outline are the same tree written two ways.
 *
 * A node's text is flattened onto one line. An outline item IS a line
 * (see `findOutlineBlocks`), so a two-line text shape has to become one
 * item or two, and one is the reading that keeps the tree intact.
 */
export function outlineFromFlowchart(
  shapes: FlowNodeLike[],
  edges: FlowEdgeLike[],
  anchorId?: string,
  opts: { checkbox?: boolean } = {},
): string {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const ids = new Set(shapes.map((s) => s.id));
  const parentOf = new Map<string, string>();
  for (const e of edges) parentOf.set(e.to, e.from);

  const positional = (a: FlowNodeLike, b: FlowNodeLike) =>
    (a.position.y - b.position.y) || (a.position.x - b.position.x);

  let roots = shapes.filter((s) => {
    const p = parentOf.get(s.id);
    return !p || !ids.has(p);
  });
  // An edge list with a cycle in it has no root, and a walk that starts
  // nowhere emits nothing — an outline that silently came out empty
  // would be the worst reading of a chart the user asked to convert.
  // Every node is a candidate root instead; `seen` keeps the walk finite
  // and the first one reached carries the rest.
  if (roots.length === 0) roots = [...shapes];
  roots.sort((a, b) => {
    if (a.id === anchorId) return -1;
    if (b.id === anchorId) return 1;
    return positional(a, b);
  });

  const prefix = opts.checkbox ? "- [ ] " : "- ";
  const lines: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string, depth: number) => {
    // An edge list can carry a cycle (nothing forbids one); without this
    // the walk would recurse until the stack gave out.
    if (seen.has(id)) return;
    seen.add(id);
    const node = byId.get(id);
    if (!node) return;
    const text = (node.text || "").split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
    lines.push(`${"  ".repeat(depth)}${prefix}${text}`);
    const children = edges
      .filter((e) => e.from === id && ids.has(e.to) && !seen.has(e.to))
      .map((e) => byId.get(e.to)!)
      .filter(Boolean)
      .sort(positional);
    for (const c of children) walk(c.id, depth + 1);
  };
  for (const r of roots) walk(r.id, 0);
  return lines.join("\n");
}

/**
 * An item's text with the inline markdown taken off — `**bold**`,
 * `*em*`, `==highlight==`, `` `code` ``, `[label](url)` and
 * `[[Wikilink]]` all collapse to the words they carry.
 *
 * Only the pinned Doc panel uses this: it is chrome docked to the frame,
 * not the document, so it shows the item the way the user reads it
 * rather than the way it is stored. Everywhere the outline IS the
 * document — the editor lines, the canvas shape — the real markdown
 * parser runs instead and the formatting renders.
 */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[\[([^\[\]\n]+?)\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
    .replace(/(^|[^_])_([^_]+)_/g, "$1$2")
    .replace(/==([^=]+)==/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}
