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

const LIST_RE = /^(\s*)(?:[-*+]|(\d+)\.)\s+(.*)$/;
const HR_RE = /^\s*(?:---|\*\*\*|___)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const FENCE_RE = /^\s*```(\w*)\s*$/;

export function markdownToHtml(md) {
  if (typeof md !== "string" || !md) return "";
  const stripped = md.replace(/%%[\s\S]*?%%/g, "");
  const lines = stripped.split(/\r?\n/);
  const blocks = parseBlocks(lines);
  return blocks.map(renderBlock).join("\n");
}

function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
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
      return `<h${block.level}>${renderInline(block.text)}</h${block.level}>`;
    case "paragraph":
      return `<p>${renderInline(block.text.replace(/\s*\n\s*/g, " "))}</p>`;
    case "blockquote":
      return `<blockquote><p>${renderInline(block.text.replace(/\s*\n\s*/g, " "))}</p></blockquote>`;
    case "code":
      return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
    case "list":
      return renderList(block.list);
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
