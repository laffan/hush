/**
 * Pure search + snippet utilities for the Find panel.
 *
 * These functions know nothing about app state or DOM — given a string of
 * content, a query, and the toggle bag, they hand back match offsets and
 * the contextual snippet rendered around each hit (3 words before / 8
 * after). The panel module composes them with the source loaders to
 * build the per-file result sections.
 */

export function buildRegex(query, opts) {
  const { caseSensitive, wholeWord, useRegex } = opts;
  const flags = caseSensitive ? "g" : "gi";
  let pattern;
  if (useRegex) {
    pattern = query;
  } else {
    pattern = escapeRegExp(query);
    if (wholeWord) pattern = `\\b${pattern}\\b`;
  }
  return new RegExp(pattern, flags);
}

/** Run a global match over `content` and return `[{from, to}]`. Bails out
 *  past 50k hits so a runaway regex doesn't lock up the UI thread. */
export function findMatchesIn(content, query, opts) {
  const matches = [];
  if (!content || !query) return matches;
  let re;
  try { re = buildRegex(query, opts); } catch (_) { return matches; }
  let m;
  let guard = 0;
  while ((m = re.exec(content)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    matches.push({ from: m.index, to: m.index + m[0].length });
    if (++guard > 50000) break;
  }
  return matches;
}

/** Build the contextual snippet rendered for a single hit. Trims the
 *  surrounding line to 3 words of leading + 8 words of trailing context,
 *  preserving the whitespace flush against the match so prefix / suffix
 *  don't run into the highlighted text on render. */
export function lineAndSnippet(content, from, to) {
  const lineStart = content.lastIndexOf("\n", from - 1) + 1;
  const lineEnd = content.indexOf("\n", to);
  const endIdx = lineEnd === -1 ? content.length : lineEnd;
  const lineText = content.slice(lineStart, endIdx);
  const matchStartInLine = from - lineStart;
  const matchEndInLine = to - lineStart;

  const beforeRaw = lineText.slice(0, matchStartInLine);
  const matchText = lineText.slice(matchStartInLine, matchEndInLine);
  const afterRaw = lineText.slice(matchEndInLine);

  const trailingWsBefore = beforeRaw.match(/\s*$/)?.[0] ?? "";
  const leadingWsAfter = afterRaw.match(/^\s*/)?.[0] ?? "";

  const { trimmed: prefixBody, truncated: prefixTrimmed } = takeLastWords(beforeRaw.slice(0, beforeRaw.length - trailingWsBefore.length), 3);
  const { trimmed: suffixBody, truncated: suffixTrimmed } = takeFirstWords(afterRaw.slice(leadingWsAfter.length), 8);
  const prefix = prefixBody + trailingWsBefore;
  const suffix = leadingWsAfter + suffixBody;

  let line = 1;
  for (let i = 0; i < lineStart; i++) if (content.charCodeAt(i) === 10) line++;
  return {
    line,
    leading: prefixTrimmed ? "…" : "",
    trailing: suffixTrimmed ? "…" : "",
    prefix, matchText, suffix,
  };
}

/** Keep the trailing `n` whitespace-separated tokens of `s`, preserving
 *  the original whitespace that joins them. */
function takeLastWords(s, n) {
  if (!s) return { trimmed: "", truncated: false };
  const tokens = [];
  const re = /\s*\S+/g;
  let m;
  while ((m = re.exec(s)) !== null) tokens.push(m[0]);
  if (tokens.length <= n) return { trimmed: s, truncated: false };
  const kept = tokens.slice(-n).join("").replace(/^\s+/, "");
  return { trimmed: kept, truncated: true };
}

function takeFirstWords(s, n) {
  if (!s) return { trimmed: "", truncated: false };
  const tokens = [];
  const re = /\S+\s*/g;
  let m;
  while ((m = re.exec(s)) !== null) tokens.push(m[0]);
  if (tokens.length <= n) return { trimmed: s, truncated: false };
  const kept = tokens.slice(0, n).join("").replace(/\s+$/, "");
  return { trimmed: kept, truncated: true };
}

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}
