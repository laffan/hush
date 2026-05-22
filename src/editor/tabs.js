/**
 * Shared parser for the Hush "tab marker" syntax used to round-trip
 * Google Docs tabs through markdown.
 *
 *   ---Tab name---
 *
 * Three dashes, the tab name, three more dashes, on its own line. The
 * captured name is trimmed, must be non-empty, and must contain at
 * least one non-dash character so `---` (horizontal rule) and `---%`
 * (end-of-document marker) don't accidentally match.
 *
 * Exports:
 *   - TAB_MARKER_RE          — regex tested per-line (no `g` flag)
 *   - parseTabMarkerLine     — returns the trimmed name, or null
 *   - parseTabs              — splits a markdown doc into ordered tabs
 *
 * `parseTabs` returns the first chunk before any marker as the "root"
 * tab so a doc without any markers still produces one entry. This keeps
 * the push/pull contract simple — there's always at least one tab.
 */

export const TAB_MARKER_RE = /^---([^\n]+?)---\s*$/;

/** Return the trimmed tab name if `line` is a valid tab marker, else null.
 *  Rejects lines whose captured group is empty, whitespace-only, or made
 *  up entirely of dashes (which would let `------` masquerade as a tab). */
export function parseTabMarkerLine(line) {
  if (typeof line !== "string") return null;
  const m = TAB_MARKER_RE.exec(line);
  if (!m) return null;
  const name = m[1].trim();
  if (!name) return null;
  if (/^-+$/.test(name)) return null;
  return name;
}

/**
 * Split a markdown string into an ordered list of tab sections.
 *
 * Returns `[{ title, content, startLine, startOffset }, …]`. The first
 * entry has `title: null` and represents the content before any marker
 * (the document's root tab). Empty bodies are preserved so a marker
 * followed immediately by another marker yields an empty tab in
 * between — that lets push/pull preserve user-created empty tabs.
 *
 * Trailing blank lines inside a section are trimmed; leading blank
 * lines are too. The marker line itself is consumed.
 */
export function parseTabs(md) {
  const text = typeof md === "string" ? md : "";
  const lines = text.split(/\n/);
  const out = [];
  let cursor = { title: null, buf: [], startLine: 0, startOffset: 0 };
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const name = parseTabMarkerLine(line);
    if (name != null) {
      out.push(finalize(cursor));
      offset += line.length + 1;
      cursor = { title: name, buf: [], startLine: i + 1, startOffset: offset };
      continue;
    }
    cursor.buf.push(line);
    offset += line.length + 1;
  }
  out.push(finalize(cursor));
  return out;
}

function finalize(section) {
  // Trim leading + trailing blank lines from the body so each tab reads
  // cleanly. The marker we just consumed sits between sections, so the
  // blank line right after it is purely cosmetic in markdown.
  let { buf } = section;
  while (buf.length && buf[0].trim() === "") buf.shift();
  while (buf.length && buf[buf.length - 1].trim() === "") buf.pop();
  return {
    title: section.title,
    content: buf.join("\n"),
    startLine: section.startLine,
    startOffset: section.startOffset,
  };
}

/** Inverse of `parseTabs`: rebuild a single markdown string from a list
 *  of `{ title, content }` sections. Any section with a non-empty
 *  `title` is preceded by a `---{title}---` marker on its own line —
 *  including the first section. Untitled sections (root content
 *  before any marker) emit only the content. Blank lines separate
 *  marker blocks so the markers read as block-level elements. */
export function joinTabs(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return "";
  const out = [];
  for (const s of sections) {
    const title = (s?.title || "").trim();
    const content = (s?.content || "").replace(/\s+$/, "");
    if (title) {
      if (out.length) out.push("");
      out.push(`---${title}---`);
      if (content) {
        out.push("");
        out.push(content);
      }
    } else if (content) {
      if (out.length) out.push("");
      out.push(content);
    }
  }
  return out.join("\n");
}
