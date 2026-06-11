/**
 * HTML → Markdown converter, tuned for Google Docs paste.
 *
 * Google Docs's clipboard HTML uses inline-styled <span>s for bold
 * (`font-weight:700`) and italic (`font-style:italic`) instead of <b>/<i>,
 * wraps everything in a `<b id="docs-internal-guid-...">` envelope, and
 * emits highlights as `<span style="background-color:#...">`. We special-
 * case those alongside the standard tags so a paste from Word, browsers,
 * Notion, etc. also produces sensible markdown.
 *
 * Returns null when the input doesn't look like rich content — the paste
 * handler falls through to CodeMirror's default plain-text path in that
 * case so we don't double-handle a regular plain paste.
 */

const RICH_TAG_RE = /<(h[1-6]|ul|ol|li|b|strong|i|em|u|s|strike|mark|blockquote|a|hr|p|pre|code)\b/i;
const STYLE_BOLD_RE = /font-weight\s*:\s*(?:bold|[6-9]\d{2})/i;
const STYLE_ITALIC_RE = /font-style\s*:\s*italic/i;
const STYLE_STRIKE_RE = /text-decoration[^;]*line-through/i;
const STYLE_BG_RE = /background(?:-color)?\s*:\s*([^;]+)/i;

const HEADER_LEVELS = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };

export function htmlToMarkdown(html, opts = {}) {
  if (typeof html !== "string" || !html.trim()) return null;
  if (!RICH_TAG_RE.test(html)) return null;
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return null;
  }
  const root = doc?.body;
  if (!root) return null;
  root.querySelectorAll("style, script, meta").forEach((n) => n.remove());

  // Google Docs wraps the whole payload in `<b id="docs-internal-guid-...">`.
  // That outer <b> would otherwise make every block bold; unwrap it.
  const gdocs = root.querySelector('b[id^="docs-internal-guid-"]');
  if (gdocs) {
    while (gdocs.firstChild) gdocs.parentNode.insertBefore(gdocs.firstChild, gdocs);
    gdocs.remove();
  }

  stripGoogleCommentArtifacts(root, !!opts.commentMarkers, opts.collect);

  const out = renderChildren(root, { inPre: false });
  // Trailing spaces first, then collapse — the other order leaves
  // `\n\n \n\n` runs (inter-paragraph whitespace text nodes) as four
  // newlines, which read as phantom blank lines in the pulled markdown.
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Position sentinel left in place of an inline comment marker when the
// caller asks to keep marker positions (pull path). Private-use char so it
// can't collide with document text; the pull flow extracts and removes it
// (see `comments-sync.js#extractCommentMarkers`) to recover the exact
// offset each Google comment was anchored to. The marker's reference
// number (`#cmnt7` \u2192 `7`) rides between a sentinel pair \u2014
// `\uF8FF7\uF8FF` \u2014 so a marker can be paired with the exact comment
// thread it belongs to via the export's footer (see `opts.collect`).
export const COMMENT_MARKER_SENTINEL = "\uF8FF";

// Google Docs's HTML export renders comments as `<sup><a href="#cmntN">
// [a]</a></sup>` markers in the body, plus — at the very foot of the
// document — a back-linked list of the comment threads (`<a
// href="#cmnt_refN">`) including reply text and reaction lines ("Alex
// reacted with ⭐ …"). Hush imports comments through the Drive Comments
// API instead (see `google-docs/comments-sync.js`), which is cleaner and
// carries the anchored range, so we drop all of it here — otherwise the
// pulled markdown carries `[[a]](#cmntN)` junk inline and a wall of
// comment/reaction text in the footer (which then gets pushed back into
// the Google Doc as literal body paragraphs).
function stripGoogleCommentArtifacts(root, keepMarkers, collect) {
  // 1. In-body reference markers (`#cmntN`, but not the foot back-refs).
  //    On the pull path (`keepMarkers`) we replace each with a position
  //    sentinel carrying the marker's reference number instead of
  //    deleting it, so the comment weaver can anchor each comment to the
  //    exact instance Google marked — otherwise a comment on a word that
  //    recurs earlier lands on the wrong one.
  for (const a of root.querySelectorAll('a[href^="#cmnt"]')) {
    const href = a.getAttribute("href") || "";
    if (href.startsWith("#cmnt_ref")) continue;
    const node = a.closest("sup") || a;
    if (keepMarkers) {
      const ref = (href.match(/^#cmnt([\w.-]+)$/) || [])[1] || "";
      node.replaceWith(root.ownerDocument.createTextNode(
        COMMENT_MARKER_SENTINEL + ref + COMMENT_MARKER_SENTINEL
      ));
    } else {
      node.remove();
    }
  }
  // 1b. Harvest the footer's thread texts before removing it: each foot
  //     block's back-ref (`#cmnt_refN`) pairs reference number N with
  //     the thread's full text, which lets the comment weaver match a
  //     Drive API comment to the exact in-body marker it belongs to.
  if (collect) {
    collect.commentFooter = collect.commentFooter || {};
    for (const a of root.querySelectorAll('a[href^="#cmnt_ref"]')) {
      const ref = ((a.getAttribute("href") || "").match(/^#cmnt_ref([\w.-]+)$/) || [])[1];
      if (!ref) continue;
      // The back-ref's own paragraph holds the thread's opening comment
      // (replies are sibling paragraphs) — enough text to pair against
      // the API comment's `content`.
      const block = a.closest("p") || a.parentElement || a;
      const label = a.textContent || "";
      const text = (block.textContent || "").replace(label, " ").replace(/\s+/g, " ").trim();
      if (text) collect.commentFooter[ref] = text;
    }
  }
  // 2. The whole foot section. Google always places the comment thread
  //    list last, so from the first back-reference onward (plus any
  //    immediately-preceding separator rule) everything is comment
  //    scaffolding — comment text, replies, and reaction lines alike.
  const backRef = root.querySelector('a[href^="#cmnt_ref"]');
  if (backRef) {
    // Climb to the direct child of the body that contains the back-ref.
    let node = backRef;
    while (node.parentNode && node.parentNode !== root) node = node.parentNode;
    // Eat a preceding <hr>/empty separator.
    let prev = node.previousElementSibling;
    while (prev && (prev.tagName === "HR" || !prev.textContent.trim())) {
      const p = prev.previousElementSibling;
      prev.remove();
      prev = p;
    }
    // Remove this node and every following sibling.
    while (node) {
      const next = node.nextSibling;
      node.remove();
      node = next;
    }
  }
  // 3. Tidy now-empty <sup> wrappers left by step 1.
  root.querySelectorAll("sup").forEach((s) => { if (!s.textContent.trim()) s.remove(); });
}

function renderChildren(node, ctx) {
  let out = "";
  for (const child of node.childNodes) out += renderNode(child, ctx);
  return out;
}

function renderNode(node, ctx) {
  if (node.nodeType === 3) {
    const t = node.nodeValue || "";
    if (ctx.inPre) return t;
    // Google Docs preserves inter-element whitespace as text nodes; collapse
    // runs of whitespace + non-breaking spaces to a single space so the
    // output reads cleanly. Markdown is whitespace-tolerant anyway.
    return t.replace(/ /g, " ").replace(/\s+/g, " ");
  }
  if (node.nodeType !== 1) return "";
  const tag = node.tagName;
  switch (tag) {
    case "BR": return ctx.inPre ? "\n" : "  \n";
    case "HR": return "\n\n---\n\n";
    case "H1": case "H2": case "H3":
    case "H4": case "H5": case "H6":
      return blockHeader(node, HEADER_LEVELS[tag], ctx);
    case "P": case "DIV":
      return blockPara(node, ctx);
    case "UL": case "OL":
      return blockListGroup(node, ctx);
    case "LI":
      // Bare <li> outside a list — render as a plain bullet.
      return "- " + renderChildren(node, ctx).trim() + "\n";
    case "BLOCKQUOTE":
      return blockQuote(node, ctx);
    case "PRE":
      return blockPre(node);
    case "TABLE": case "THEAD": case "TBODY":
    case "TR": case "TD": case "TH":
      // Tables aren't a Phase 1 goal; flatten cell text with separators.
      return renderChildren(node, ctx) + (tag === "TR" ? "\n" : tag === "TD" || tag === "TH" ? " | " : "");
    default:
      return renderInline(node, ctx);
  }
}

function blockHeader(node, level, ctx) {
  // Suppress bold inside headings: Google's export styles heading runs
  // with `font-weight:700`, which would otherwise wrap every pulled
  // heading in redundant `**` (a `#` heading is already bold).
  const inner = renderChildren(node, { ...ctx, inHeading: true }).trim().replace(/\s*\n\s*/g, " ");
  if (!inner) return "";
  return "\n\n" + "#".repeat(level) + " " + inner + "\n\n";
}

function blockPara(node, ctx) {
  // Fallback tab marker emitted by `markdownToHtml` when the caller
  // bypasses the Docs API tab split (e.g. "Copy as Google Doc"). The
  // round-trip restores the canonical `---Name---` form.
  const tabName = node.getAttribute?.("data-hush-tab-marker");
  if (tabName) return `\n\n---${tabName}---\n\n`;
  const inner = renderChildren(node, ctx);
  // Drive's HTML export carries cosmetic empty paragraphs between blocks
  // — `<p></p>`, `<p>&nbsp;</p>`, `<p><span></span></p>`. Treat anything
  // that boils down to whitespace (including non-breaking spaces) as a
  // no-op so the pulled markdown doesn't accumulate blank lines.
  const collapsed = inner.replace(/[\s ]+/g, "");
  if (!collapsed) return "";
  const body = inner.trim();
  // Google Docs represents a block quote as an indented paragraph
  // (Drive's HTML export emits `margin-left:36pt`). Read a once-indented
  // paragraph back as Hush's `> ` block quote, shedding the quote
  // *style*'s own emphasis on the way.
  if (paragraphIndentPt(node) >= QUOTE_INDENT_THRESHOLD_PT) {
    return "\n\n" + quoteLines(body) + "\n\n";
  }
  return "\n\n" + body + "\n\n";
}

// Half a Google indent level (one level ≈ 36pt). Using half as the
// threshold tolerates rounding in Drive's exported point values while
// still ignoring the small hanging indents Google sometimes emits.
const QUOTE_INDENT_THRESHOLD_PT = 18;

// Left indent of a paragraph in points, read from its inline style.
// Google's HTML export indents block quotes with `margin-left`; some
// pastes use `padding-left`. Either signals an indented paragraph.
function paragraphIndentPt(node) {
  const style = (node.getAttribute && node.getAttribute("style")) || "";
  const m = /margin-left\s*:\s*([\d.]+)pt/i.exec(style)
    || /padding-left\s*:\s*([\d.]+)pt/i.exec(style);
  return m ? parseFloat(m[1]) : 0;
}

// Block-level entry point for a <ul>/<ol>. Coalesces consecutive sibling
// list elements into one logical list group — Google Docs emits each list
// item as its own <ul>/<ol> with `aria-level` on the <li> indicating
// visual depth, so without this every item would render at the top level.
// Standard nested-<ul>-inside-<li> markup also passes through here; depths
// fall back to ancestor-list count when `aria-level` isn't present.
function blockListGroup(firstList, ctx) {
  if (firstList.getAttribute("data-hush-consumed") === "true") return "";
  const groupRoots = [firstList];
  let next = nextSiblingElement(firstList);
  while (next && (next.tagName === "UL" || next.tagName === "OL")) {
    groupRoots.push(next);
    next.setAttribute("data-hush-consumed", "true");
    next = nextSiblingElement(next);
  }
  const items = [];
  for (const root of groupRoots) collectListItems(root, items, 0, ctx);
  if (!items.length) return "";
  // Renormalise depth values to a contiguous 0..N range so visually-
  // jumped levels (e.g. aria-level=1 → aria-level=3) collapse cleanly.
  const sorted = [...new Set(items.map((it) => it.depth))].sort((a, b) => a - b);
  const depthMap = new Map(sorted.map((d, i) => [d, i]));
  for (const it of items) it.depth = depthMap.get(it.depth);
  // Per-depth ordered counters; popping deeper counters when depth
  // decreases so a later sibling group restarts numbering.
  const counters = [];
  let out = "\n\n";
  for (const it of items) {
    while (counters.length <= it.depth) counters.push(1);
    while (counters.length > it.depth + 1) counters.pop();
    const indent = "  ".repeat(it.depth);
    const marker = it.ordered ? `${counters[it.depth]++}.` : "-";
    const content = it.content.replace(/\s*\n\s*/g, " ").replace(/^\s+|\s+$/g, "");
    if (!content) continue;
    out += `${indent}${marker} ${content}\n`;
  }
  return out + "\n";
}

function nextSiblingElement(el) {
  let n = el.nextSibling;
  while (n && n.nodeType === 3 && /^\s*$/.test(n.nodeValue || "")) n = n.nextSibling;
  return (n && n.nodeType === 1) ? n : null;
}

function collectListItems(listNode, items, fallbackDepth, ctx) {
  const ordered = listNode.tagName === "OL";
  for (const child of listNode.children) {
    if (child.tagName === "LI") {
      const aria = parseInt(child.getAttribute("aria-level") || "", 10);
      const depth = (!Number.isNaN(aria) && aria > 0) ? aria - 1 : fallbackDepth;
      let content = "";
      const nested = [];
      for (const sub of child.childNodes) {
        if (sub.nodeType === 1 && (sub.tagName === "UL" || sub.tagName === "OL")) {
          nested.push(sub);
        } else {
          content += renderNode(sub, ctx);
        }
      }
      items.push({ depth, ordered, content });
      for (const sub of nested) collectListItems(sub, items, depth + 1, ctx);
    } else if (child.tagName === "UL" || child.tagName === "OL") {
      // Invalid-HTML pattern Google Docs emits on copy: a <ul>/<ol> as a
      // direct child of another <ul>/<ol>, without an intervening <li>.
      // The HTML5 parser preserves it verbatim, so we recurse explicitly
      // and treat the inner list as one level deeper than this one. The
      // <li>'s own aria-level (read above) still wins when present.
      collectListItems(child, items, fallbackDepth + 1, ctx);
    }
  }
}

function blockQuote(node, ctx) {
  const inner = renderChildren(node, ctx).trim();
  if (!inner) return "";
  const lined = quoteLines(inner);
  return "\n\n" + lined + "\n\n";
}

// Prefix each line with `> `, shedding style-level emphasis first.
function quoteLines(body) {
  return body.split("\n").map((l) => {
    const t = stripFullLineEmphasis(l);
    return t.length ? "> " + t : ">";
  }).join("\n");
}

/**
 * Google Docs's block-quote paragraph style carries its own font styling
 * — the export marks the whole quote bold and/or italic, often split
 * across several runs with punctuation between them (`*"**text**"*
 * *(citation)*`), which is the *style*, not author emphasis. If every
 * word character on the line sits inside an emphasis run, drop all the
 * emphasis; a line with plain words outside the runs keeps its (explicit)
 * emphasis untouched. Shared with the Docs-API walker.
 */
export function stripFullLineEmphasis(line) {
  const s = String(line).trim();
  if (!s.includes("*")) return s;
  const outside = s
    .replace(/\*\*[^*]+\*\*/g, "")
    .replace(/\*[^*\s][^*]*\*/g, "");
  if (/[A-Za-z0-9]/.test(outside)) return s;
  return s.replace(/\*+/g, "");
}

function blockPre(node) {
  const text = node.textContent || "";
  return "\n\n```\n" + text.replace(/\n+$/, "") + "\n```\n\n";
}

// Inline rendering: applies markdown emphasis based on the element itself
// plus any inline `style=""` attribute, then recurses into children.
function renderInline(node, ctx) {
  const tag = node.tagName;
  if (tag === "A" && node.hasAttribute("href")) {
    const href = collapseGdocsRedirect(node.getAttribute("href") || "");
    const text = renderChildren(node, ctx).replace(/\s*\n\s*/g, " ").trim();
    if (!text) return href ? `[${href}](${href})` : "";
    if (!href || href === text) return text;
    return `[${text}](${href})`;
  }
  if (tag === "CODE" && node.parentElement?.tagName !== "PRE") {
    const t = (node.textContent || "").replace(/`/g, "");
    return t ? "`" + t + "`" : "";
  }
  let bold = false, italic = false, strike = false, hi = null;
  if (tag === "B" || tag === "STRONG") bold = true;
  if (tag === "I" || tag === "EM") italic = true;
  if (tag === "S" || tag === "STRIKE" || tag === "DEL") strike = true;
  if (tag === "MARK") hi = true;
  const style = (node.getAttribute && node.getAttribute("style")) || "";
  if (style) {
    if (STYLE_BOLD_RE.test(style)) bold = true;
    if (STYLE_ITALIC_RE.test(style)) italic = true;
    if (STYLE_STRIKE_RE.test(style)) strike = true;
    const m = STYLE_BG_RE.exec(style);
    if (m && !isPlainBackground(m[1])) hi = true;
  }
  if (ctx.inHeading) bold = false; // headings are bold by definition
  let inner = renderChildren(node, ctx);
  if (!inner) return "";
  // Wrap, but only the trimmed run — leading/trailing whitespace stays
  // outside the markers so `**foo** bar` doesn't become `** foo ** bar`.
  return wrapInline(inner, { bold, italic, strike, hi });
}

function wrapInline(text, { bold, italic, strike, hi }) {
  if (!bold && !italic && !strike && !hi) return text;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const lead = m[1], core = m[2], trail = m[3];
  if (!core) return text;
  let inner = core;
  if (hi) inner = `==${inner}==`;
  if (strike) inner = `~~${inner}~~`;
  if (bold) inner = `**${inner}**`;
  if (italic) inner = `*${inner}*`;
  return lead + inner + trail;
}

function isPlainBackground(c) {
  const x = c.toLowerCase().trim().replace(/!important\s*$/, "").trim();
  if (!x || x === "transparent" || x === "none" || x === "inherit") return true;
  if (x === "#fff" || x === "#ffffff" || x === "white") return true;
  if (/^rgba?\(\s*255\s*,\s*255\s*,\s*255/.test(x)) return true;
  // rgba with zero alpha
  if (/^rgba\([^)]*,\s*0\s*\)\s*$/.test(x)) return true;
  return false;
}

// Google Docs rewrites every link through https://www.google.com/url?q=...
// — peel the redirect off so the user sees the real destination.
function collapseGdocsRedirect(href) {
  try {
    const u = new URL(href);
    if (u.hostname === "www.google.com" && u.pathname === "/url") {
      const real = u.searchParams.get("q");
      if (real) return real;
    }
  } catch { /* not a parseable URL — pass through */ }
  return href;
}
