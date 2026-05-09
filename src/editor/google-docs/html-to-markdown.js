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

export function htmlToMarkdown(html) {
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

  const out = renderChildren(root, { listStack: [], inPre: false });
  return out.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
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
      return blockList(node, ctx, tag === "OL");
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
  const inner = renderChildren(node, ctx).trim().replace(/\s*\n\s*/g, " ");
  if (!inner) return "";
  return "\n\n" + "#".repeat(level) + " " + inner + "\n\n";
}

function blockPara(node, ctx) {
  const inner = renderChildren(node, ctx).trim();
  if (!inner) return "\n";
  return "\n\n" + inner + "\n\n";
}

function blockList(node, ctx, ordered) {
  const depth = ctx.listStack.length;
  ctx.listStack.push({ ordered, idx: 1 });
  let out = depth === 0 ? "\n" : "\n";
  for (const child of node.children) {
    if (child.tagName === "LI") out += renderListItem(child, ctx, ordered, depth);
  }
  ctx.listStack.pop();
  return depth === 0 ? out + "\n" : out;
}

function renderListItem(node, ctx, ordered, depth) {
  const indent = "  ".repeat(depth);
  const top = ctx.listStack[ctx.listStack.length - 1];
  const marker = ordered ? `${top.idx++}.` : "-";
  let primary = "";
  let nested = "";
  for (const child of node.childNodes) {
    if (child.nodeType === 1 && (child.tagName === "UL" || child.tagName === "OL")) {
      nested += renderNode(child, ctx);
    } else {
      primary += renderNode(child, ctx);
    }
  }
  primary = primary.replace(/\s*\n\s*/g, " ").replace(/^\s+|\s+$/g, "");
  if (!primary && !nested) return "";
  let line = `${indent}${marker} ${primary}\n`;
  if (nested) line += nested.replace(/^\n+/, "").replace(/\n+$/, "\n");
  return line;
}

function blockQuote(node, ctx) {
  const inner = renderChildren(node, ctx).trim();
  if (!inner) return "";
  const lined = inner.split("\n").map((l) => (l.length ? "> " + l : ">")).join("\n");
  return "\n\n" + lined + "\n\n";
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
    if (!text) return "";
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
