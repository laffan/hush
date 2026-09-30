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
 * its size, whether it is collapsed, and, in a Doc, where it floats
 * (`xPos` / `yPos`: see card-doc-float.js). Being a comment is what keeps
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
export const CARD_DEFAULT_HEIGHT = 100;
export const CARD_MIN_WIDTH = 160;
export const CARD_MIN_HEIGHT = 60;
/** Height of the header strip (drag handle + buttons), in CSS px. Shared
 *  by the DOM card and the canvas painter so a collapsed card is the
 *  same size on both surfaces. */
export const CARD_HEADER_HEIGHT = 18;

/** What a card carries besides its text. Every key is optional and only
 *  written when it differs from the default; keys this build doesn't
 *  know are kept as they are. */
export interface CardMeta {
  xPos?: number;
  yPos?: number;
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
    if (k === "collapsed" && v !== true) continue;
    if (k === "xPos" || k === "yPos") { if (typeof v === "number" && isFinite(v)) out[k] = Math.round(v); continue; }
    if (k === "width" && (typeof v !== "number" || Math.round(v) === CARD_DEFAULT_WIDTH)) continue;
    if (k === "height" && (typeof v !== "number" || Math.round(v) === CARD_DEFAULT_HEIGHT)) continue;
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

export function cardSize(meta: CardMeta | null | undefined): { width: number; height: number } {
  const w = typeof meta?.width === "number" ? meta.width : CARD_DEFAULT_WIDTH;
  const h = typeof meta?.height === "number" ? meta.height : CARD_DEFAULT_HEIGHT;
  return {
    width: Math.max(CARD_MIN_WIDTH, Math.round(w)),
    height: Math.max(CARD_MIN_HEIGHT, Math.round(h)),
  };
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

/** Drop the Doc float offsets — a card going into the flow, or onto a
 *  canvas, where its position is the shape's own. */
export function withoutPosition(meta: CardMeta | null | undefined): CardMeta {
  const { xPos: _x, yPos: _y, ...rest } = meta || {};
  return rest;
}

/** Whether a Doc card floats beside its anchor rather than sitting in the
 *  text (card-doc-float.js). */
export function isFloating(meta: CardMeta | null | undefined): boolean {
  return typeof meta?.xPos === "number" && typeof meta?.yPos === "number";
}

/** A line the card editor must never produce: it would end the card (or
 *  start another) in the text around it. */
export function isFenceLine(text: string): boolean {
  return text === CARD_OPEN || text === CARD_CLOSE;
}
