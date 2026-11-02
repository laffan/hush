/**
 * The query language of the Desk Dashboard's Search all Desks — the one
 * a web search box has. Pure: text in, hits out; no state, no DOM.
 *
 * - Plain words are separate terms, each matched anywhere, inside longer
 *   words too (`harb` finds "harbour"), and a file must hold every one.
 * - "Quoted text" is one exact phrase: the words in that order, each a
 *   whole word (`"harb"` finds nothing in "harbour"), spaces between them
 *   matching any run of spaces on the line. A quote still open while it
 *   is being typed runs to the end of the query.
 *
 * Both ignore case. Straight and curly quotes both count, since an iPad
 * keyboard's smart punctuation types the curly ones.
 */

import { escapeRegExp, lineAndSnippet } from "./find-panel-search.js";

/** Letters and digits of any script, and the underscore — what a word is
 *  made of, for the edges of an exact phrase. */
const WORD = "[\\p{L}\\p{N}_]";

/** `[{ text, exact }]`, in the order typed. */
export function parseQuery(query) {
  const terms = [];
  const re = /["“”]([^"“”]*)["“”]?|([^\s"“”]+)/g;
  let m;
  while ((m = re.exec(query || ""))) {
    const exact = m[1] !== undefined;
    const text = (exact ? m[1] : m[2]).trim();
    if (text) terms.push({ text, exact });
  }
  return terms;
}

/** The global regex one term matches with. */
export function termRegex(term) {
  const body = escapeRegExp(term.text).replace(/\s+/g, "[ \\t\\u00a0]+");
  return new RegExp(term.exact ? `(?<!${WORD})${body}(?!${WORD})` : body, "giu");
}

/** Every `{ from, to }` the regex matches in `text`. */
export function matchesOf(text, re) {
  const out = [];
  if (!text) return out;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    if (!m[0].length) { re.lastIndex++; continue; }
    out.push({ from: m.index, to: m.index + m[0].length });
    if (out.length >= 5000) break;
  }
  return out;
}

/**
 * The hits of `terms` in one file, made of `segments` (`[{ text,
 * shapeId? }]` — a document is one segment, a notebook one per text
 * shape). Empty unless every term is found somewhere in the file. Hits
 * come rarest term first, then in reading order, so the word that picked
 * the file out leads rather than a common one beside it. Each is
 * `{ term, nth, shapeId, snippet }` — `nth` its place among that term's
 * hits, which is how a document hit is found again once opened — and
 * only the first `limit` carry a snippet; `total` counts them all.
 */
export function fileHits(segments, terms, limit) {
  const perTerm = terms.map((term) => {
    const re = termRegex(term);
    const hits = [];
    for (const seg of segments) {
      for (const m of matchesOf(seg.text, re)) hits.push({ ...m, seg, term, nth: hits.length });
    }
    return hits;
  });
  if (!perTerm.length || perTerm.some((h) => !h.length)) return { hits: [], total: 0 };
  const all = perTerm.sort((a, b) => a.length - b.length).flat();
  const hits = all.slice(0, limit).map(({ from, to, seg, term, nth }) => ({
    term, nth, shapeId: seg.shapeId, snippet: lineAndSnippet(seg.text, from, to),
  }));
  return { hits, total: all.length };
}
