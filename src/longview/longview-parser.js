/**
 * Outline View document parser — extracts headings, flags, and callouts from markdown text.
 * Ported from obsidian-long-view/src/utils/documentParser.ts
 */
import { parseTabMarkerPath, pathToLabel } from "../editor/tabs.js";
import { COMMENT_ANCHOR_RE, COMMENT_DEF_RE } from "../editor/comment-syntax.js";

/**
 * @typedef {{ level: number, text: string, startOffset: number, callout?: { type: string, title: string, color: string } }} DocumentHeading
 * @typedef {{ type: string, message: string, startOffset: number }} DocumentFlag
 * @typedef {{ type: string, title: string, startOffset: number, endOffset: number }} DocumentCallout
 * @typedef {{ title: string, path: string[], depth: number, startOffset: number, endOffset: number }} DocumentTab
 */

/**
 * Parse headings from text, including callout detection below headings.
 * @param {string} text
 * @param {number} baseOffset
 * @returns {DocumentHeading[]}
 */
export function parseHeadings(text, baseOffset = 0) {
  const headings = [];
  const lines = text.split("\n");
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      const level = match[1].length;
      // Unwrap Google-Docs comment anchors (`{>text<id}`) so the outline
      // shows the heading prose, not the raw comment syntax.
      const headingText = match[2].replace(COMMENT_ANCHOR_RE, "$1").trim();
      const heading = { level, text: headingText, startOffset: baseOffset + offset };

      // Check if next non-empty line is a callout (> [!type] title)
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j === i + 1 && j < lines.length) {
        const callout = parseCalloutLine(lines[j]);
        if (callout) {
          heading.callout = callout;
        }
      }

      headings.push(heading);
    }
    offset += line.length + 1; // +1 for \n
  }

  return headings;
}

/**
 * Parse a single line to see if it's a callout start.
 * @param {string} line
 * @returns {{ type: string, title: string } | null}
 */
function parseCalloutLine(line) {
  const match = line.match(/^\s*>\s*\[!(\w+)\]\s*(.*)/);
  if (!match) return null;
  return { type: match[1].toUpperCase(), title: match[2].trim() };
}

/**
 * Parse inline flags: ==FLAG: message== and %% comments %%
 * @param {string} text
 * @param {number} baseOffset
 * @returns {DocumentFlag[]}
 */
export function parseFlags(text, baseOffset = 0) {
  const flags = [];

  // ==FLAG==, ==FLAG:==, or ==FLAG: message== — colon + message are
  // optional so a bare `==MISSING==` is still recognised (matches the
  // editor's flag-highlight regex).
  const flagRegex = /==([A-Za-z][A-Za-z0-9_-]{0,24})(?::\s*([^=]*))?==/g;
  let match;
  while ((match = flagRegex.exec(text)) !== null) {
    flags.push({
      type: match[1].toUpperCase(),
      message: (match[2] || "").trim(),
      startOffset: baseOffset + match.index,
    });
  }

  // %% comments %% — except `%%cmnt …%%`, which is the Google-Docs
  // comment definitions' hidden machine metadata, not a user note.
  const commentRegex = /%%([^%]+)%%/g;
  while ((match = commentRegex.exec(text)) !== null) {
    const message = match[1].trim();
    if (/^cmnt\b/.test(message)) continue;
    flags.push({
      type: "COMMENT",
      message,
      startOffset: baseOffset + match.index,
    });
  }

  flags.sort((a, b) => a.startOffset - b.startOffset);
  return flags;
}

/**
 * Parse callout blocks from text. Returns ranges for tinting.
 * @param {string} text
 * @param {number} baseOffset
 * @returns {DocumentCallout[]}
 */
export function parseCallouts(text, baseOffset = 0) {
  const callouts = [];
  const lines = text.split("\n");
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const calloutMatch = line.match(/^\s*>\s*\[!(\w+)\]\s*(.*)/);
    if (calloutMatch) {
      const startOffset = baseOffset + offset;
      const type = calloutMatch[1].toUpperCase();
      const title = calloutMatch[2].trim();

      // Consume all continuation lines (lines starting with >)
      let endOffset = startOffset + line.length;
      let j = i + 1;
      let runningOffset = offset + line.length + 1;
      while (j < lines.length && /^\s*>/.test(lines[j])) {
        endOffset = baseOffset + runningOffset + lines[j].length;
        runningOffset += lines[j].length + 1;
        j++;
      }

      callouts.push({ type, title, startOffset, endOffset });
    }
    offset += line.length + 1;
  }

  return callouts;
}

/**
 * Parse `---Tab name---` (and nested `---Parent---/---Child---`) markers
 * into ordered tab sections with explicit start/end offsets so the
 * outline + files sidebar can render foldable, hierarchically-nested
 * containers. The first entry's `path` is empty when no marker is
 * present before the first real content — that mirrors the round-trip
 * representation in `editor/tabs.js#parseTabs`. Top-level tabs have
 * `depth: 0`; child tabs `depth: 1`; grandchildren `depth: 2`; etc.
 * `title` is the leaf segment for convenience.
 * @param {string} text
 * @param {number} baseOffset
 * @returns {DocumentTab[]}
 */
export function parseTabSections(text, baseOffset = 0) {
  const lines = text.split("\n");
  const out = [];
  let cursor = {
    title: null,
    path: [],
    depth: 0,
    label: "",
    startOffset: baseOffset,
    headerEnd: baseOffset,
  };
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const path = parseTabMarkerPath(line);
    if (path != null) {
      cursor.endOffset = baseOffset + offset;
      out.push(cursor);
      const markerStart = baseOffset + offset;
      const markerEnd = markerStart + line.length;
      cursor = {
        title: path[path.length - 1],
        path,
        depth: path.length - 1,
        label: pathToLabel(path),
        startOffset: markerStart,
        headerEnd: markerEnd,
      };
    }
    offset += line.length + 1;
  }
  cursor.endOffset = baseOffset + text.length;
  out.push(cursor);
  return out;
}

/**
 * Build minimap data from document text.
 * @param {string} text
 * @returns {{ headings: DocumentHeading[], flags: DocumentFlag[], callouts: DocumentCallout[], tabs: DocumentTab[] }}
 */
export function parseDocument(text) {
  if (!text || text.trim().length === 0) {
    return { headings: [], flags: [], callouts: [], tabs: [] };
  }
  return {
    headings: parseHeadings(text, 0),
    flags: parseFlags(text, 0),
    callouts: parseCallouts(text, 0),
    tabs: parseTabSections(text, 0),
  };
}

/**
 * Compute heading callout stacks — for each heading, determine which callouts
 * are active (based on heading being immediately followed by a callout).
 * @param {DocumentHeading[]} headings
 * @returns {Map<number, Array<{ type: string, color: string }>>}
 */
export function computeHeadingCalloutStacks(headings, sectionFlagColors) {
  const stacks = new Map();
  const calloutStack = [];

  for (const heading of headings) {
    // Pop callouts for headings at same or higher level
    while (calloutStack.length > 0 && calloutStack[calloutStack.length - 1].level >= heading.level) {
      calloutStack.pop();
    }

    if (heading.callout) {
      const color = sectionFlagColors[heading.callout.type] || "#086ddd";
      calloutStack.push({ level: heading.level, type: heading.callout.type, color });
    }

    stacks.set(heading.startOffset, calloutStack.map(c => ({ type: c.type, color: c.color })));
  }

  return stacks;
}

/**
 * Get first N words from a string.
 */
export function getFirstWords(text, n) {
  const words = text.trim().split(/\s+/);
  if (words.length <= n) return text.trim();
  return words.slice(0, n).join(" ") + "…";
}

/**
 * Sanitize a line of text, stripping markdown syntax. With
 * `keepComments`, Google-Docs comment anchors (`{>text<id}` and the
 * dangling `{>` / `<id}` halves of a multi-line anchor) survive so the
 * caller can render the commented runs as highlights; everything else is
 * stripped the same either way.
 */
export function sanitizeLine(line, { keepComments = false } = {}) {
  // Google-Docs comment scaffolding: a `[>id]:` definition line is pure
  // metadata (drop it whole); an inline `{>text<id}` anchor unwraps to
  // its commented prose.
  if (COMMENT_DEF_RE.test(line)) return "";
  if (!keepComments) {
    line = line
      .replace(COMMENT_ANCHOR_RE, "$1")
      // A multi-line anchor leaves a dangling `{>` or `<id}` on this line —
      // the pair sits on different lines, so the full-anchor unwrap above
      // can't catch it.
      .replace(/\{>/g, "")
      .replace(/<[A-Za-z0-9]{1,4}\}/g, "");
  }
  return line
    .replace(/^#{1,6}\s+/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    // Blockquote markers — leading only, so the `>` inside a kept comment
    // anchor (`{>`) survives.
    .replace(/^(?:>\s*)+/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/==[A-Za-z][A-Za-z0-9_-]*:[^=]+==/g, "")
    .replace(/%%[^%]+%%/g, "")
    .trim();
}
