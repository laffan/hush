/**
 * Cards — the markdown model both surfaces read.
 *
 * A card is a chunk of markdown fenced by a line that is exactly `<<<`
 * and a later line that is exactly `>>>`:
 *
 *     <<<
 *     Card ==content== here!
 *     %%card {"xPos":520,"yPos":12,"bgColor":"#42a5f5"}%%
 *     >>>
 *
 * The line before the closing fence may hold the card's metadata: a Hush
 * comment (`%%…%%`) opening with `card ` and holding a JSON object. That
 * is where a card keeps what the text has no way to say — its colour,
 * its width, whether it is collapsed, and, in a Doc, where it was put in
 * a margin and whether it is pinned in view (`xPos` / `yPos`, `pinned` /
 * `pinY`: see card-doc-float.js). Being a comment is what keeps
 * it out of word counts and exports for free, and it is markdown nothing
 * else reads as a heading or a rule. Anything that doesn't parse is part
 * of the body.
 *
 * Pairing is by scan order: an opening fence pairs with the next closing
 * fence, and a later opening fence before that close replaces it (so a
 * card can never contain a fence line — the card editor refuses one).
 * Fences inside frontmatter or a ``` code block don't count.
 *
 * This file is the one parser: the Doc plugin, the notebook's card
 * shapes, the sidebar rows, the drag and Courier all read cards through
 * it, so no two of them can disagree about where a card starts or what
 * it holds.
 */

import { countWords } from "../editor/plugins/word-count.js";

export const CARD_OPEN = "<<<";
export const CARD_CLOSE = ">>>";
/** A card holds at most this many words; past it the card turns red and
 *  takes nothing more. */
export const CARD_MAX_WORDS = 100;
/** Making a card longer than this asks first. */
export const CARD_CONFIRM_WORDS = 50;
export const CARD_DEFAULT_WIDTH = 300;
/** A card is as tall as its text and one line more; this is only the
 *  estimate used before one has been measured (and the grid pitch). */
export const CARD_DEFAULT_HEIGHT = 100;
export const CARD_MIN_WIDTH = 160;
/** Height of the header strip (drag handle + buttons), in CSS px. Shared
 *  by the DOM card and the canvas painter so a collapsed card is the
 *  same size on both surfaces. */
export const CARD_HEADER_HEIGHT = 18;

/** What a card carries besides its text. Every key is optional and only
 *  written when it differs from the default; keys this build doesn't
 *  know are kept as they are. */
export interface CardMeta {
  /** In a Doc: from the text column's left edge (card-doc-float.js). */
  xPos?: number;
  /** In a Doc: from the top of the line the card sits beside. */
  yPos?: number;
  /** In a Doc: held in view rather than scrolling with the text, `pinY`
   *  below the top of the editor's visible area. */
  pinned?: boolean;
  pinY?: number;
  bgColor?: string;
  width?: number;
  height?: number;
  collapsed?: boolean;
  [key: string]: unknown;
}

/** One card found in a text. Offsets are into that text. */
export interface CardSpan {
  /** Start of the `<<<` line. */
  from: number;
  /** End of the `>>>` line (before its newline, if any). */
  to: number;
  /** Start of the first body line — `from + 4`. */
  bodyFrom: number;
  /** End of the last body line. Equal to `bodyFrom` when there is none. */
  bodyTo: number;
  /** False for `<<<` directly followed by `>>>` (or by the metadata):
   *  there is no line to write into, so an edit rewrites the card. */
  hasBodyLine: boolean;
  body: string;
  meta: CardMeta;
  /** Raw metadata line, or null. */
  metaText: string | null;
  /** 0-based position among the text's cards. */
  index: number;
}

interface LineInfo { from: number; to: number; text: string }

const META_RE = /^%%card (\{.*\})%%$/;
const FENCE_RE = /^\s{0,3}(```|~~~)/;

/** Parse a `%%card {…}%%` metadata line. Null unless it holds a JSON
 *  object. */
export function parseMetaLine(text: string): CardMeta | null {
  const m = META_RE.exec(text);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as CardMeta) : null;
  } catch {
    return null;
  }
}

/**
 * Scan lines for cards. `line(n)` is 1-based, like CodeMirror's.
 */
export function scanCards(lineCount: number, line: (n: number) => LineInfo): CardSpan[] {
  const out: CardSpan[] = [];
  let open = -1;
  let inFence = false;
  let start = 1;
  // Frontmatter: a `---` first line up to the next `---`.
  if (lineCount >= 1 && line(1).text === "---") {
    for (let n = 2; n <= lineCount; n++) {
      if (line(n).text === "---") { start = n + 1; break; }
    }
  }
  for (let n = start; n <= lineCount; n++) {
    const text = line(n).text;
    if (FENCE_RE.test(text)) {
      // A code fence opened inside a pending card is card content; it
      // still suspends fence matching until it closes.
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (text === CARD_OPEN) { open = n; continue; }
    if (text === CARD_CLOSE && open > 0) {
      out.push(buildSpan(open, n, line, out.length));
      open = -1;
    }
  }
  return out;
}

function buildSpan(openN: number, closeN: number, line: (n: number) => LineInfo, index: number): CardSpan {
  const openL = line(openN);
  const closeL = line(closeN);
  let lastBody = closeN - 1;
  let meta: CardMeta = {};
  let metaText: string | null = null;
  if (closeN - openN >= 2) {
    const metaL = line(closeN - 1);
    const parsed = parseMetaLine(metaL.text);
    if (parsed) {
      meta = parsed;
      metaText = metaL.text;
      lastBody = closeN - 2;
    }
  }
  const hasBodyLine = lastBody > openN;
  const bodyFrom = openL.to + 1;
  const bodyTo = hasBodyLine ? line(lastBody).to : bodyFrom;
  const lines: string[] = [];
  for (let n = openN + 1; n <= lastBody; n++) lines.push(line(n).text);
  return {
    from: openL.from, to: closeL.to, bodyFrom, bodyTo, hasBodyLine,
    body: lines.join("\n"), meta, metaText, index,
  };
}

/** Cards in a plain string. */
export function findCards(text: string): CardSpan[] {
  if (!text || text.indexOf(CARD_CLOSE) < 0) return [];
  const lines: LineInfo[] = [];
  let pos = 0;
  for (const t of text.split("\n")) {
    lines.push({ from: pos, to: pos + t.length, text: t });
    pos += t.length + 1;
  }
  return scanCards(lines.length, (n) => lines[n - 1]);
}

/** Cards in a CodeMirror `Text`. */
export function findCardsInDoc(doc: { lines: number; line(n: number): LineInfo }): CardSpan[] {
  return scanCards(doc.lines, (n) => doc.line(n));
}

/** Drop keys holding a default (or nothing), so a plain card writes no
 *  metadata at all. */
export function cleanMeta(meta: CardMeta | null | undefined): CardMeta {
  const out: CardMeta = {};
  if (!meta) return out;
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null || v === "") continue;
    if ((k === "collapsed" || k === "pinned") && v !== true) continue;
    if (k === "xPos" || k === "yPos" || k === "pinY") { if (typeof v === "number" && isFinite(v)) out[k] = Math.round(v); continue; }
    if (k === "width" && (typeof v !== "number" || Math.round(v) === CARD_DEFAULT_WIDTH)) continue;
    // Height follows the text; a stored one (from before it did) is dropped.
    if (k === "height") continue;
    out[k] = typeof v === "number" ? Math.round(v) : v;
  }
  return out;
}

/** The card's markdown, fences and all. Metadata is written only when
 *  something in it is worth keeping. */
export function serializeCard(body: string, meta?: CardMeta | null): string {
  const m = cleanMeta(meta);
  const tail = Object.keys(m).length ? `%%card ${JSON.stringify(m)}%%\n` : "";
  return `${CARD_OPEN}\n${body}\n${tail}${CARD_CLOSE}`;
}

export function cardSize(meta: CardMeta | null | undefined): { width: number } {
  const w = typeof meta?.width === "number" ? meta.width : CARD_DEFAULT_WIDTH;
  return { width: Math.max(CARD_MIN_WIDTH, Math.round(w)) };
}

export function cardWordCount(body: string): number {
  return countWords(body || "");
}

/** Strip the markdown that would otherwise be counted as words in a
 *  title: list / heading / quote markers, emphasis, links. */
function plainLine(text: string): string {
  return text
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/%%[\s\S]*?%%/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => b || a)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|==|~~|`|\*|_)/g, "");
}

/** The card's name in the sidebar: the first three words of its first
 *  line (the first one with words on it). */
export function cardTitle(body: string): string {
  for (const raw of (body || "").split("\n")) {
    const words = plainLine(raw).trim().split(/\s+/).filter(Boolean);
    if (words.length) return words.slice(0, 3).join(" ");
  }
  return "Empty card";
}

/** The card's row in the sidebar: all of its words on one line, its
 *  markdown dropped — the row's CSS crops it to the width there is. Held
 *  to a length no sidebar shows, since a notebook's are stored in the
 *  per-device index. */
export function cardPreview(body: string): string {
  const text = (body || "").split("\n").map((l) => plainLine(l).trim()).filter(Boolean).join(" ").replace(/\s+/g, " ");
  return text ? text.slice(0, 240) : "Empty card";
}

/** True when `text` is a single card and nothing else (whitespace
 *  aside) — what a paste or a drop has to be to arrive as a card. */
export function parseWholeCard(text: string): { body: string; meta: CardMeta } | null {
  const trimmed = (text || "").replace(/^\s*\n/, "").replace(/\n\s*$/, "");
  const cards = findCards(trimmed);
  if (cards.length !== 1) return null;
  const c = cards[0];
  if (c.from !== 0 || c.to !== trimmed.length) return null;
  return { body: c.body, meta: c.meta };
}

/** The keys that say where a card sits in a Doc — beside which line, in
 *  which margin, pinned in view — and mean nothing anywhere else. */
export const DOC_PLACEMENT_KEYS = ["xPos", "yPos", "pinned", "pinY"];

/** Drop a Doc card's placement — a card dropped over a Doc's text (beside
 *  a line, in the default place), or onto a canvas, where its position is
 *  the shape's own. */
export function withoutPosition(meta: CardMeta | null | undefined): CardMeta {
  const out: CardMeta = { ...(meta || {}) };
  for (const k of DOC_PLACEMENT_KEYS) delete out[k];
  return out;
}

/**
 * Where a card placed beside the line starting at `pos` can go: that
 * line, unless it is inside frontmatter or a ``` block — where the fences
 * wouldn't count and the card would be text — and then the line after
 * that block.
 */
type DocLike = { lines: number; length: number; line(n: number): LineInfo; lineAt(pos: number): LineInfo & { number: number } };

export function cardAnchorPos(doc: DocLike, pos: number): number {
  const target = doc.lineAt(pos).number;
  let blockEnd = 0;
  let n = 1;
  if (doc.lines >= 1 && doc.line(1).text === "---") {
    for (let k = 2; k <= doc.lines; k++) {
      if (doc.line(k).text === "---") { blockEnd = k; break; }
    }
    if (blockEnd && target <= blockEnd) return blockEnd < doc.lines ? doc.line(blockEnd + 1).from : doc.length;
    n = blockEnd + 1;
  }
  let open = 0;
  for (; n <= doc.lines; n++) {
    if (!FENCE_RE.test(doc.line(n).text)) continue;
    if (!open) { open = n; continue; }
    if (target > open && target <= n) return n < doc.lines ? doc.line(n + 1).from : doc.length;
    open = 0;
    if (n >= target) break;
  }
  if (open && target > open) return doc.length;
  return pos;
}

/** The change that puts card markdown `text` on lines of its own
 *  before the line at `pos` (see `cardAnchorPos`). */
export function cardInsertion(doc: DocLike, pos: number, text: string): { from: number; insert: string } {
  const at = cardAnchorPos(doc, pos);
  if (doc.lineAt(at).from === at) return { from: at, insert: `${text}\n` };
  return { from: at, insert: `\n${text}\n` };
}

/** The span a card's removal takes: its lines plus one newline, so no
 *  blank line is left where it was. */
export function cardRemovalRange(doc: { length: number }, span: { from: number; to: number }): { from: number; to: number } {
  if (span.to < doc.length) return { from: span.from, to: span.to + 1 };
  if (span.from > 0) return { from: span.from - 1, to: span.to };
  return { from: span.from, to: span.to };
}

/** A line the card editor must never produce: it would end the card (or
 *  start another) in the text around it. */
export function isFenceLine(text: string): boolean {
  return text === CARD_OPEN || text === CARD_CLOSE;
}
