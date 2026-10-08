/**
 * Table cell rendering — the inline markdown a rendered table's cells
 * show. Cells carry the formatting the extended-syntax guide allows in
 * tables (`code`, links, emphasis) plus Hush's ~~strike~~ and
 * ==highlight==, and every kind of link the editor knows:
 * `[text](url)`, `<url>`, a bare `https://…` / `www.…` (GFM's autolink
 * extension) and `[[wikilinks]]`. `&#124;` shows a literal pipe.
 *
 * A bare URL (or an `<url>`) is drawn as a short label — host and path, no scheme, no
 * query — on one line, cut with an ellipsis when it is still long, the
 * full address in its tooltip. Left to wrap, a long URL is one
 * unbreakable word as far as the table's layout is concerned, and it
 * made its column as wide as itself; with a capped label the column is
 * only as wide as the label, and the prose columns get the room.
 */

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Placeholders stand in for finished HTML while later passes run over
// the text around it, so a URL's underscores can't italicise and a code
// span's asterisks can't embolden.
const MARK = "\u0000";
const TOKEN_RE = /\u0000(\d+)\u0000/g;

/** `https://www.doi.org/10.1/x/?q=1#f` → `doi.org/10.1/x`. */
export function shortUrl(url) {
  let s = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "");
  s = s.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return s || url;
}

function linkHtml(url, labelHtml, { bare = false } = {}) {
  const cls = "cm-md-table-link" + (bare ? " cm-md-table-url" : "");
  return `<span class="${cls}" data-link-url="${escHtml(url)}" title="${escHtml(url)}">${labelHtml}</span>`;
}

// Emphasis, strike and highlight over already-escaped text.
function emphasis(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__([^_]+)__(?=[^\w]|$)/g, "$1<strong>$2</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(/==([^=]+)==/g, "<mark>$1</mark>");
}

/** End of a link destination that starts at `i` (just past its `(`):
 *  the matching `)`, parentheses inside it balanced — a Wikipedia URL
 *  is full of them. -1 when there is none. */
function destinationEnd(s, i) {
  let depth = 0;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** `<url> "title"` → `url`. */
function cleanDestination(raw) {
  let d = raw.trim();
  if (d.startsWith("<")) {
    const close = d.indexOf(">");
    return close > 0 ? d.slice(1, close) : d.slice(1);
  }
  return d.replace(/\s+("[^"]*"|'[^']*'|\([^)]*\))$/, "").trim();
}

/** Replace every `[label](dest)` and `![alt](src)` with a placeholder. */
function stashLinks(s, put) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf("[", i);
    if (open < 0) break;
    const close = s.indexOf("]", open + 1);
    if (close < 0 || s[close + 1] !== "(") {
      out += s.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    const end = destinationEnd(s, close + 2);
    if (end < 0) {
      out += s.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    const image = open > 0 && s[open - 1] === "!";
    const label = s.slice(open + 1, close);
    const url = cleanDestination(s.slice(close + 2, end));
    out += s.slice(i, image ? open - 1 : open);
    // An image in a cell shows its alt text; a citation (`[@key](…)`) its
    // key, as the citation pill's text would.
    out += image
      ? put(`<span class="cm-md-table-image">${escHtml(label)}</span>`)
      : put(linkHtml(url, emphasis(escHtml(label))));
    i = end + 1;
  }
  return out + s.slice(i);
}

// GFM autolink extension: the run of non-space characters after the
// scheme, less trailing punctuation and any `)` it doesn't open.
const BARE_URL_RE = /(^|[\s(*_~])((?:https?:\/\/|www\.)[^\s<]+)/gi;

function trimAutolink(url) {
  let u = url.replace(/[?!.,:;*_~'"]+$/, "");
  while (u.endsWith(")")) {
    const opens = (u.match(/\(/g) || []).length;
    const closes = (u.match(/\)/g) || []).length;
    if (closes <= opens) break;
    u = u.slice(0, -1);
  }
  return u;
}

function stashBareUrls(s, put) {
  return s.replace(BARE_URL_RE, (_, lead, raw) => {
    const url = trimAutolink(raw);
    const href = /^www\./i.test(url) ? `https://${url}` : url;
    return lead + put(linkHtml(href, escHtml(shortUrl(url)), { bare: true })) + raw.slice(url.length);
  });
}

/** One cell's markdown → HTML. */
export function inlineCellHtml(raw) {
  const stash = [];
  const put = (html) => { stash.push(html); return `${MARK}${stash.length - 1}${MARK}`; };
  let s = raw.replace(/&#124;/g, "|").replace(/\u0000/g, "");
  s = s.replace(/`([^`]+)`/g, (_, c) => put(`<code>${escHtml(c)}</code>`));
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~=<>])/g, (_, c) => put(escHtml(c)));
  s = s.replace(/\[\[([^[\]\n]+?)\]\]/g, (_, title) => {
    const t = title.trim();
    const shown = t.includes("|") ? t.slice(t.indexOf("|") + 1).trim() : t;
    const target = t.includes("|") ? t.slice(0, t.indexOf("|")).trim() : t;
    return put(`<span class="cm-md-table-link cm-md-table-wikilink" data-wikilink="${escHtml(target)}" title="${escHtml(target)}">${escHtml(shown)}</span>`);
  });
  s = stashLinks(s, put);
  s = s.replace(/<((?:https?|mailto|zotero|hush-[a-z]+):[^\s<>]+)>/gi, (_, url) =>
    put(linkHtml(url, escHtml(url.startsWith("mailto:") ? url.slice(7) : shortUrl(url)), { bare: true })));
  s = stashBareUrls(s, put);
  s = emphasis(escHtml(s));
  // Placeholders can nest (a link label holding code), so unstash until
  // none are left.
  for (let n = 0; n < 4 && s.includes(MARK); n++) {
    s = s.replace(TOKEN_RE, (_, i) => stash[+i]);
  }
  return s;
}
