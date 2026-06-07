/**
 * Markdown → HTML for the "Copy as Google Doc" command. Produces a small,
 * paste-friendly HTML subset — Google Docs interprets these tags faithfully:
 *
 *   <h1>–<h6>  <p>  <ul>/<ol>  <li>  <strong>  <em>  <s>  <mark>
 *   <a href>   <blockquote>   <code>/<pre>   <hr>   <br>
 *
 * Hush-specific syntax is normalised on the way out:
 *   - %%comments%% (single- and multi-line) are stripped.
 *   - ==highlight== becomes <mark style="background-color:#fff475">.
 *   - ![image]() and [^footnote] pass through as plain text for now —
 *     Phase 2 territory.
 *
 * Only the markdown subset Hush actually emits is supported. This is not
 * a general-purpose markdown engine; it's a one-way exporter.
 */

import { stripCommentSyntax } from "../comment-syntax.js";

// Google Docs imports CSS margins faithfully, so a small space-after on
// each block reproduces Hush's blank-line-between-paragraphs rhythm.
// `margin:0` (the previous value) collapsed paragraphs flush against one
// another on push — the user saw no spacing between paragraphs.
const BLOCK_SPACE = "10pt";
// One Google Docs indent level ≈ 36pt (0.5in). Google Docs has no native
// "Block quote" format, so a once-indented paragraph *is* Hush's `> `
// block quote on the Google side (and the pull path reads it back the
// same way — see `html-to-markdown.js` / `docs-walker.js`).
const QUOTE_INDENT = "36pt";

const LIST_RE = /^(\s*)(?:[-*+]|(\d+)\.)\s+(.*)$/;
const HR_RE = /^\s*(?:---|\*\*\*|___)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const FENCE_RE = /^\s*```(\w*)\s*$/;
// Tab marker — single `---name---` or nested `---a---/---b---` form.
// Local copy of the parser so this converter has no cross-module
// dependency on the editor tree (the converter is reused by the
// clipboard copy commands, which intentionally avoid editor imports).
const TAB_SEGMENT_RE = /^---([^\n]+?)---$/;

export function markdownToHtml(md) {
  if (typeof md !== "string" || !md) return "";
  // Drop Google-comment scaffolding (anchors + `[>id]:` notes) but keep
  // the commented prose — comment sync is pull-only, so the document body
  // we push back stays clean and Google's own comment anchors are left
  // untouched.
  const noComments = stripCommentSyntax(md);
  const stripped = noComments.replace(/%%[\s\S]*?%%/g, "");
  const lines = stripped.split(/\r?\n/);
  const blocks = parseBlocks(lines);
  return blocks.map(renderBlock).join("");
}

function parseTabMarker(line) {
  if (typeof line !== "string") return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  const segments = trimmed.split(/\s*\/\s*/);
  const names = [];
  for (const seg of segments) {
    const m = TAB_SEGMENT_RE.exec(seg);
    if (!m) return null;
    const name = m[1].trim();
    if (!name || /^-+$/.test(name)) return null;
    names.push(name);
  }
  // Display label for the fallback "Copy as Google Doc" rendering —
  // structured push goes through the Docs API in tabs-sync.js, this
  // is only for the clipboard / one-shot HTML path.
  return names.join(" / ");
}

function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    const tabName = parseTabMarker(line);
    if (tabName) {
      blocks.push({ type: "tab", name: tabName });
      i++;
      continue;
    }
    if (HR_RE.test(line)) { blocks.push({ type: "hr" }); i++; continue; }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push({ type: "code", text: buf.join("\n") });
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i++; continue;
    }
    if (QUOTE_RE.test(line)) {
      const buf = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        buf.push(QUOTE_RE.exec(lines[i])[1]);
        i++;
      }
      blocks.push({ type: "blockquote", text: buf.join("\n") });
      continue;
    }
    if (LIST_RE.test(line)) {
      const { list, consumed } = parseList(lines, i);
      blocks.push({ type: "list", list });
      i += consumed;
      continue;
    }
    // Paragraph — accumulate until blank line or block boundary.
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !isBlockBoundary(lines[i])) {
      buf.push(lines[i]); i++;
    }
    blocks.push({ type: "paragraph", text: buf.join("\n") });
  }
  return blocks;
}

function isBlockBoundary(line) {
  return LIST_RE.test(line) || QUOTE_RE.test(line) || HEADING_RE.test(line)
    || FENCE_RE.test(line) || HR_RE.test(line);
}

function parseList(lines, start) {
  const flat = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]);
    if (m) {
      flat.push({ indent: m[1].length, ordered: !!m[2], text: m[3] });
      i++;
    } else if (lines[i].trim() === "") {
      // A single blank line continues the list if a list line follows.
      if (i + 1 < lines.length && LIST_RE.test(lines[i + 1])) { i++; }
      else break;
    } else if (flat.length && /^\s+\S/.test(lines[i])) {
      // Wrapped continuation of the previous item.
      flat[flat.length - 1].text += " " + lines[i].trim();
      i++;
    } else break;
  }
  return { list: nestList(flat), consumed: i - start };
}

// Build a tree of { ordered, items: [{ text, children: [list, ...] }] }.
function nestList(flat) {
  if (!flat.length) return { ordered: false, items: [] };
  const root = { ordered: flat[0].ordered, items: [] };
  const stack = [{ list: root, indent: flat[0].indent }];
  for (const entry of flat) {
    while (stack.length > 1 && entry.indent < stack[stack.length - 1].indent) stack.pop();
    let top = stack[stack.length - 1];
    if (entry.indent > top.indent) {
      const lastItem = top.list.items[top.list.items.length - 1];
      if (lastItem) {
        const sub = { ordered: entry.ordered, items: [] };
        lastItem.children.push(sub);
        stack.push({ list: sub, indent: entry.indent });
        top = stack[stack.length - 1];
      }
    }
    top.list.items.push({ text: entry.text, children: [] });
  }
  return root;
}

function renderBlock(block) {
  switch (block.type) {
    case "hr": return "<hr>";
    case "heading":
      // A bottom margin separates the heading from the following block;
      // top margin stays 0 so Drive's user-agent <h*> margin doesn't
      // stack on top of the previous block's space-after.
      return `<h${block.level} style="margin:0 0 ${BLOCK_SPACE} 0">${renderInline(block.text)}</h${block.level}>`;
    case "paragraph":
      // A space-after on every paragraph reproduces the blank line Hush
      // shows between paragraphs. `margin:0` (the old value) collapsed
      // them flush together on push.
      return `<p style="margin:0 0 ${BLOCK_SPACE} 0">${renderInline(block.text.replace(/\s*\n\s*/g, " "))}</p>`;
    case "blockquote":
      // Google Docs has no block-quote style, so emit a once-indented
      // paragraph. `margin:0 0 X 0` then `margin-left` — the later
      // longhand wins for the left edge, the shorthand sets the rest.
      return `<p style="margin:0 0 ${BLOCK_SPACE} 0;margin-left:${QUOTE_INDENT}">${renderInline(block.text.replace(/\s*\n\s*/g, " "))}</p>`;
    case "code":
      return `<pre style="margin:0"><code>${escapeHtml(block.text)}</code></pre>`;
    case "list":
      return renderList(block.list);
    case "tab":
      // The Google-Docs push pipeline handles real tab splitting via the
      // Docs API. The HTML body Drive uploads goes into the root tab, so
      // any leftover marker we render here is just a fallback marker for
      // copies that bypass the tab pipeline (e.g. "Copy as Google Doc").
      // Render as a clearly-labelled paragraph so the user can spot and
      // delete it manually if needed.
      return `<p style="margin:0" data-hush-tab-marker="${escapeAttr(block.name)}"><strong>—— ${escapeHtml(block.name)} ——</strong></p>`;
  }
  return "";
}

function renderList(list) {
  const tag = list.ordered ? "ol" : "ul";
  const items = list.items.map((item) => {
    let html = `<li>${renderInline(item.text)}`;
    for (const child of item.children) html += renderList(child);
    return html + "</li>";
  }).join("");
  return `<${tag}>${items}</${tag}>`;
}

function renderInline(text) {
  let s = escapeHtml(text);
  // Code spans first so emphasis runs don't reach inside them.
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // Image refs: keep as plain markdown for now (Phase 2 rebinds these).
  // Links: skip image refs by anchoring on a non-`!` lookbehind.
  s = s.replace(/(^|[^!])\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_, lead, t, u) => `${lead}<a href="${escapeAttr(stripQuotes(u))}">${t}</a>`);
  // Highlights → <mark>.
  s = s.replace(/==([^=\n][^=\n]*?)==/g,
    (_, t) => `<mark style="background-color:#fff475">${t}</mark>`);
  // Strikethrough.
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  // Bold (greedy-but-non-overlapping).
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_\n]+?)__/g, "<strong>$1</strong>");
  // Italic — anchor on a non-`*` / non-`_` boundary so the bold pass doesn't
  // get partially eaten when emphasis nests.
  s = s.replace(/(^|[^*])\*([^*\n][^*\n]*?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_\n][^_\n]*?)_(?!_)/g, "$1<em>$2</em>");
  return s;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s) {
  return s.replace(/"/g, "&quot;");
}

function stripQuotes(u) {
  const t = u.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}
