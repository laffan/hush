/**
 * Walks Google Docs API `documentTab` structures into markdown.
 *
 * Drive's `files.export` doesn't filter by tab — `tabIds` only works
 * on `files.get`, not export — so a multi-tab pull has to extract
 * each tab's content from the Docs API's structured response itself.
 * This module is the converter.
 *
 * Coverage is intentionally narrow but covers the common cases:
 *   - Headings (H1–H6, plus TITLE → H1, SUBTITLE → H2)
 *   - Paragraphs with bold / italic / strikethrough / link runs
 *   - Bulleted and numbered lists, nested via `bullet.nestingLevel`
 *   - Tables, flattened with ` | ` separators
 *
 * Inline objects (images, equations, drawings) are dropped — they'd
 * need binary upload to round-trip and aren't a tabs-feature concern.
 */

const HEADING_PREFIX = {
  TITLE: "#",
  SUBTITLE: "##",
  HEADING_1: "#",
  HEADING_2: "##",
  HEADING_3: "###",
  HEADING_4: "####",
  HEADING_5: "#####",
  HEADING_6: "######",
};

export function documentTabToMarkdown(documentTab) {
  if (!documentTab?.body?.content) return "";
  const lists = documentTab.lists || {};
  const blocks = [];
  for (const elem of documentTab.body.content) {
    if (elem.paragraph) {
      const md = renderParagraph(elem.paragraph, lists);
      if (md != null && md !== "") blocks.push(md);
    } else if (elem.table) {
      const md = renderTable(elem.table, lists);
      if (md) blocks.push(md);
    }
    // sectionBreak, tableOfContents, etc. are skipped.
  }
  return blocks.join("\n\n").trim();
}

function renderParagraph(paragraph, lists) {
  const styleType = paragraph.paragraphStyle?.namedStyleType || "NORMAL_TEXT";
  let text = "";
  for (const e of paragraph.elements || []) {
    if (e.textRun) text += renderTextRun(e.textRun);
    // inlineObjectElement, pageBreak, footnoteReference: dropped.
  }
  text = text.replace(/\n+$/, "").trimEnd();
  if (paragraph.bullet) {
    const nesting = paragraph.bullet.nestingLevel || 0;
    const indent = "  ".repeat(nesting);
    const ordered = isOrderedList(lists, paragraph.bullet.listId, nesting);
    const marker = ordered ? "1." : "-";
    return text ? `${indent}${marker} ${text}` : "";
  }
  const headingPrefix = HEADING_PREFIX[styleType];
  if (headingPrefix && text) return `${headingPrefix} ${text}`;
  // Google Docs has no block-quote style — it shows one as an indented
  // paragraph. A non-heading, non-list paragraph indented once (≈ 36pt)
  // reads back as Hush's `> ` block quote. Mirror of the push side, which
  // emits block quotes as `margin-left:36pt` paragraphs.
  const indentPt = paragraph.paragraphStyle?.indentStart?.magnitude || 0;
  if (indentPt >= QUOTE_INDENT_THRESHOLD_PT && text) {
    return text.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
  }
  return text;
}

// Half a Google indent level (one level ≈ 36pt) — tolerates rounding in
// the API's point values while ignoring small hanging indents.
const QUOTE_INDENT_THRESHOLD_PT = 18;

function isOrderedList(lists, listId, nesting) {
  if (!listId) return false;
  const list = lists[listId];
  const level = list?.listProperties?.nestingLevels?.[nesting];
  const glyph = (level?.glyphType || level?.glyphSymbol || "") + "";
  return /DECIMAL|ALPHA|ROMAN/i.test(glyph);
}

function renderTextRun(textRun) {
  let text = textRun.content || "";
  if (!text) {
    const s = textRun.textStyle || {};
    if (s.link?.url) return `[${s.link.url}](${s.link.url})`;
    return "";
  }
  // Trailing newlines belong to paragraph structure, not the run.
  const trailingNewlines = /\n+$/.test(text);
  text = text.replace(/\n+$/, "");
  if (!text) return trailingNewlines ? "" : "";
  const s = textRun.textStyle || {};
  let out = text;
  if (s.link?.url) out = `[${out}](${s.link.url})`;
  if (s.bold) out = `**${out}**`;
  if (s.italic) out = `*${out}*`;
  if (s.strikethrough) out = `~~${out}~~`;
  return out;
}

function renderTable(table, lists) {
  const rows = [];
  for (const row of table.tableRows || []) {
    const cells = [];
    for (const cell of row.tableCells || []) {
      const inner = [];
      for (const e of cell.content || []) {
        if (e.paragraph) {
          const t = renderParagraph(e.paragraph, lists);
          if (t) inner.push(t);
        }
      }
      cells.push(inner.join(" ").replace(/\s+/g, " "));
    }
    rows.push(cells.join(" | "));
  }
  return rows.join("\n");
}
