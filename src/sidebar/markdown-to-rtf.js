/**
 * Markdown → RTF for the doc export modal's "RTF" format. Produces a
 * compact, word-processor-friendly RTF 1.x document covering the
 * markdown subset Hush actually emits: headings, paragraphs, block
 * quotes, ordered / unordered lists, fenced code, horizontal rules, and
 * inline **bold** / *italic* / `code` / links / images.
 *
 * Like `editor/google-docs/markdown-to-html.js`, this is a one-way
 * exporter, not a general markdown engine — anything outside that subset
 * degrades to its visible text. Hush-specific syntax is normalised on the
 * way out: `%%comments%%` are dropped and `==highlight==` collapses to
 * plain text (RTF has no portable highlight that every reader honours).
 *
 * Citation processing (the `[@key]` markup) happens upstream in
 * `export-citations.js` before the markdown reaches this converter.
 */

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const LIST_RE = /^(\s*)(?:([-*+])|(\d+)\.)\s+(.*)$/;
const HR_RE = /^\s*(?:---|\*\*\*|___)\s*$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const FENCE_RE = /^\s*```(\w*)\s*$/;
const TAB_RE = /^---([^\n]+?)---$/;

// Heading font sizes in RTF half-points (\fsN). Body is 24 (12pt).
const HEADING_FS = [36, 32, 28, 26, 24, 24];
const BODY_FS = 24;

export function markdownToRtf(md) {
  if (typeof md !== "string" || !md) return wrapDoc("");
  // Drop comments outright; collapse highlights to their inner text.
  const stripped = md
    .replace(/%%[\s\S]*?%%/g, "")
    .replace(/==([^=]+)==/g, "$1");
  const lines = stripped.split(/\r?\n/);

  const parts = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block — emit verbatim in the monospace font.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // closing fence
      const body = buf.map((l) => esc(l)).join("\\line ");
      parts.push(`\\pard\\li360\\sa180\\f1 ${body}\\f0\\par`);
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    // A horizontal rule (`---`, `***`, `___`) renders as a bottom
    // border; a `---name---` tab marker renders as a centred bold label.
    // HR is checked first since a bare `---` never carries a tab name.
    if (HR_RE.test(line)) {
      parts.push(`\\pard\\brdrb\\brdrs\\brdrw10\\brsp20\\sa180 \\par`);
      i++;
      continue;
    }
    const tab = TAB_RE.exec(line.trim());
    if (tab) {
      const label = tab[1].split(/\s*\/\s*/).filter(Boolean).join(" / ");
      parts.push(`\\pard\\qc\\sa180\\b ${inline(label)}\\b0\\par`);
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      const fs = HEADING_FS[level - 1] || BODY_FS;
      parts.push(`\\pard\\sa180\\b\\fs${fs} ${inline(heading[2])}\\b0\\fs${BODY_FS}\\par`);
      i++;
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote && /^\s*>/.test(line)) {
      const buf = [quote[1]];
      i++;
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      parts.push(`\\pard\\li720\\sa180\\i ${inline(buf.join(" "))}\\i0\\par`);
      continue;
    }

    const list = LIST_RE.exec(line);
    if (list) {
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m) break;
        const ordered = m[3] != null;
        const marker = ordered ? `${m[3]}.` : "\\bullet";
        parts.push(`\\pard\\li360\\fi-180\\sa60 ${marker}\\tab ${inline(m[4])}\\par`);
        i++;
      }
      continue;
    }

    // Plain paragraph: gather consecutive non-blank, non-structural lines.
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !HEADING_RE.test(lines[i]) &&
      !LIST_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !FENCE_RE.test(lines[i]) &&
      !HR_RE.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    parts.push(`\\pard\\sa180 ${inline(buf.join(" "))}\\par`);
  }

  return wrapDoc(parts.join("\n"));
}

function wrapDoc(body) {
  return (
    "{\\rtf1\\ansi\\ansicpg1252\\deff0\n" +
    "{\\fonttbl{\\f0\\froman Georgia;}{\\f1\\fmodern Consolas;}}\n" +
    `\\fs${BODY_FS}\n` +
    body +
    "\n}"
  );
}

/**
 * Inline markdown → RTF. Resolves links / images to their visible text,
 * then scans for **bold**, *italic*, and `code` runs. `_italic_` is
 * pre-normalised to `*italic*` only at word boundaries so snake_case
 * identifiers in prose aren't accidentally italicised.
 */
function inline(text) {
  let t = text;
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => alt); // image → alt
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, (_, label) => label); // link → label
  t = t.replace(/(^|[\s(])_(\S(?:[^_]*\S)?)_(?=[\s).,;:!?]|$)/g, "$1*$2*");

  const chars = Array.from(t);
  let out = "";
  let bold = false;
  let italic = false;
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === "*" && chars[i + 1] === "*") {
      bold = !bold;
      out += bold ? "\\b " : "\\b0 ";
      i += 2;
      continue;
    }
    if (c === "*") {
      italic = !italic;
      out += italic ? "\\i " : "\\i0 ";
      i += 1;
      continue;
    }
    if (c === "`") {
      i += 1;
      let code = "";
      while (i < chars.length && chars[i] !== "`") {
        code += chars[i];
        i += 1;
      }
      if (i < chars.length) i += 1; // closing backtick
      out += `\\f1 ${esc(code)}\\f0 `;
      continue;
    }
    out += esc(c);
    i += 1;
  }
  if (bold) out += "\\b0 ";
  if (italic) out += "\\i0 ";
  return out;
}

/** RTF-escape a string: backslash / braces, plus non-ASCII as `\uN?`
 *  (signed 16-bit, surrogate-paired for astral code points). */
function esc(s) {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === "{") out += "\\{";
    else if (ch === "}") out += "\\}";
    else if (code < 128) out += ch;
    else if (code <= 0xffff) out += `\\u${signed16(code)}?`;
    else {
      const v = code - 0x10000;
      const hi = 0xd800 + (v >> 10);
      const lo = 0xdc00 + (v & 0x3ff);
      out += `\\u${signed16(hi)}?\\u${signed16(lo)}?`;
    }
  }
  return out;
}

function signed16(u) {
  return u >= 0x8000 ? u - 0x10000 : u;
}
