/**
 * Pipe-table model — the markdown half of the table renderer: finding
 * tables in a document, splitting rows into cells, and reading and
 * writing the delimiter row (alignment and column widths).
 *
 * Column widths ride the delimiter row, the convention Pandoc reads:
 * each column's share is its number of dashes. Hush only honours it
 * when the dashes total exactly 100 — hand-typed rows (`|---|---|`) and
 * the ones table formatters pad out to each column's longest cell would
 * otherwise read as deliberate widths, and both are noise. A row Hush
 * writes after a column drag always totals 100, so the widths are
 * percentages of the text column, and any other markdown renderer still
 * sees an ordinary table.
 */

// A GFM delimiter row: pipe-separated cells of `:?-+:?`, with optional
// surrounding whitespace and optional leading / trailing pipes. Requiring
// a pipe (checked separately) keeps a bare `---` thematic break out.
export const DELIM_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** What the dashes of a width-carrying delimiter row add up to. */
export const WIDTH_TOTAL = 100;
/** No column is dragged narrower than this share of the table. */
export const MIN_COL_PCT = 4;

export function hasUnescapedPipe(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "|" && text[i - 1] !== "\\") return true;
  }
  return false;
}

// Split a table row into trimmed cell strings: drop a single leading and
// trailing unescaped pipe, then split on the remaining unescaped pipes
// (an escaped `\|` becomes a literal pipe inside the cell).
export function splitCells(text) {
  let t = text.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && t[t.length - 2] !== "\\") t = t.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "\\" && t[i + 1] === "|") { cur += "|"; i++; continue; }
    if (ch === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// Per-column alignment from the delimiter row's `:` markers.
export function parseAligns(delimText) {
  return splitCells(delimText).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });
}

/** The column widths a delimiter row carries, as percentages — or null
 *  when it carries none (its dashes don't total `WIDTH_TOTAL`, or it
 *  doesn't have one cell per column). */
export function parseWidths(delimText, columns) {
  const dashes = splitCells(delimText).map((c) => c.replace(/:/g, "").length);
  if (dashes.length !== columns) return null;
  const total = dashes.reduce((a, b) => a + b, 0);
  return total === WIDTH_TOTAL ? dashes : null;
}

/** Fractional shares → whole dash counts totalling `WIDTH_TOTAL`, none
 *  under one dash (GFM's minimum), largest remainders rounded up. */
export function roundWidths(shares) {
  const sum = shares.reduce((a, b) => a + Math.max(0, b), 0) || 1;
  const exact = shares.map((s) => (Math.max(0, s) / sum) * WIDTH_TOTAL);
  const out = exact.map((x) => Math.max(1, Math.floor(x)));
  let left = WIDTH_TOTAL - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, rem: x - Math.floor(x) }))
    .sort((a, b) => b.rem - a.rem);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k].i]++;
  // A column floored up to its one dash can push the total over; take
  // the excess back from the widest columns.
  while (left < 0) {
    const widest = out.indexOf(Math.max(...out));
    out[widest]--;
    left++;
  }
  return out;
}

/** A delimiter row for `aligns`, carrying `widths` (dash counts) or, with
 *  none, the plain three dashes a column needs to be one. Keeps the
 *  outer pipes the row had, so a rewrite touches only the dashes. */
export function formatDelimiter(aligns, widths, original = "|") {
  const trimmed = original.trim();
  const lead = trimmed.startsWith("|");
  const trail = trimmed.endsWith("|") && trimmed.length > 1;
  const cells = aligns.map((a, i) => {
    const dashes = "-".repeat(Math.max(1, widths ? widths[i] : 3));
    if (a === "center") return `:${dashes}:`;
    if (a === "right") return `${dashes}:`;
    if (a === "left") return `:${dashes}`;
    return dashes;
  });
  const body = widths ? cells.join("|") : cells.map((c) => ` ${c} `).join("|");
  // A one-column row without outer pipes would have no pipe at all.
  const needsPipe = aligns.length === 1 && !lead && !trail;
  return (lead ? "|" : "") + body + (trail || needsPipe ? "|" : "");
}

/** Offset, within a row's text, of where column `col`'s content starts
 *  (past its pipe and any leading spaces) — where a click on that cell
 *  puts the caret. The row's end when it has fewer cells. */
export function cellOffset(text, col) {
  let i = 0;
  while (i < text.length && text[i] === " ") i++;
  if (text[i] === "|") i++;
  for (let c = 0; c < col; c++) {
    while (i < text.length && !(text[i] === "|" && text[i - 1] !== "\\")) i++;
    if (i >= text.length) return text.trimEnd().length;
    i++;
  }
  while (i < text.length && text[i] === " ") i++;
  return i;
}

// Locate every pipe-table block in the document: a header line containing
// a pipe, immediately followed by a delimiter row, then any run of
// pipe-bearing body lines. Returns spans in document order.
export function findTables(doc) {
  const tables = [];
  let i = 1;
  while (i <= doc.lines) {
    const t = tableAtLine(doc, i);
    if (t) {
      tables.push(t);
      i = doc.lineAt(t.to).number + 1;
      continue;
    }
    i++;
  }
  return tables;
}

/** The table whose header is line `n`, or null. */
export function tableAtLine(doc, n) {
  if (n < 1 || n + 1 > doc.lines) return null;
  const header = doc.line(n);
  if (!hasUnescapedPipe(header.text) || DELIM_RE.test(header.text)) return null;
  const delim = doc.line(n + 1);
  if (!hasUnescapedPipe(delim.text) || !DELIM_RE.test(delim.text)) return null;
  let last = n + 1;
  for (let j = n + 2; j <= doc.lines; j++) {
    const body = doc.line(j);
    if (body.text.trim() === "" || !hasUnescapedPipe(body.text)) break;
    last = j;
  }
  const bodyTexts = [];
  for (let k = n + 2; k <= last; k++) bodyTexts.push(doc.line(k).text);
  return {
    from: header.from,
    to: doc.line(last).to,
    headerText: header.text,
    delimFrom: delim.from,
    delimText: delim.text,
    bodyTexts,
  };
}
