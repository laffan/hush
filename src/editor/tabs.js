/**
 * Shared parser for the Hush "tab marker" syntax used to round-trip
 * Google Docs tabs through markdown.
 *
 *   ---Tab name---                        — top-level tab
 *   ---Parent---/---Child---              — nested tab (child of Parent)
 *   ---A---/---B---/---C---               — arbitrary nesting depth
 *
 * Each segment is `---name---`; segments are joined with `/` (any
 * surrounding whitespace is allowed). The captured name is trimmed,
 * must be non-empty, and must contain at least one non-dash character
 * so `---` (horizontal rule) and `---%` (end-of-document marker)
 * don't accidentally match.
 *
 * Exports:
 *   - TAB_SEGMENT_RE        — regex matching one `---name---` segment
 *   - parseTabMarkerPath    — returns the full path (array), or null
 *   - parseTabMarkerLine    — returns just the leaf name (string), or null
 *   - parseTabs             — splits markdown into ordered sections
 *   - joinTabs              — inverse of parseTabs
 *   - pathToMarker          — `["A", "B"]` -> `"---A---/---B---"`
 *   - pathToLabel           — `["A", "B"]` -> `"A / B"` (display form)
 */

export const TAB_SEGMENT_RE = /^---([^\n]+?)---$/;

/** Return the full path for a marker line — an array of one or more
 *  names — or null when the line isn't a valid tab marker. Single-
 *  segment markers return a one-element array; nested markers (joined
 *  by `/`) return the parent chain followed by the leaf. */
export function parseTabMarkerPath(line) {
  if (typeof line !== "string") return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  // Split on `/` with optional surrounding whitespace; each piece must
  // be a valid `---name---` segment.
  const segments = trimmed.split(/\s*\/\s*/);
  if (segments.length === 0) return null;
  const path = [];
  for (const seg of segments) {
    const m = TAB_SEGMENT_RE.exec(seg);
    if (!m) return null;
    const name = m[1].trim();
    if (!name) return null;
    if (/^-+$/.test(name)) return null;
    path.push(name);
  }
  return path;
}

/** Backward-compat helper for call sites that only need to know whether
 *  a line is a tab marker (and want the leaf name) — filename
 *  derivation, outline paragraph filter, etc. Returns the LAST segment's
 *  name, or null if not a marker. */
export function parseTabMarkerLine(line) {
  const path = parseTabMarkerPath(line);
  return path ? path[path.length - 1] : null;
}

/**
 * Split a markdown string into an ordered list of tab sections.
 *
 * Each section: `{ path, content, startLine, startOffset }`. The first
 * entry has `path: []` when the doc starts with non-marker content
 * (the implicit root). For nested markers the section's `path` carries
 * the full chain — top-level tabs have length-1 paths, children
 * length-2, etc.
 */
export function parseTabs(md) {
  const text = typeof md === "string" ? md : "";
  const lines = text.split(/\n/);
  const out = [];
  let cursor = { path: [], buf: [], startLine: 0, startOffset: 0 };
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const path = parseTabMarkerPath(line);
    if (path != null) {
      out.push(finalize(cursor));
      offset += line.length + 1;
      cursor = { path, buf: [], startLine: i + 1, startOffset: offset };
      continue;
    }
    cursor.buf.push(line);
    offset += line.length + 1;
  }
  out.push(finalize(cursor));
  return out;
}

function finalize(section) {
  let { buf } = section;
  while (buf.length && buf[0].trim() === "") buf.shift();
  while (buf.length && buf[buf.length - 1].trim() === "") buf.pop();
  return {
    path: section.path,
    content: buf.join("\n"),
    startLine: section.startLine,
    startOffset: section.startOffset,
  };
}

/** Inverse of `parseTabs`: rebuild a single markdown string from a list
 *  of `{ path, content }` sections. A section with a non-empty `path`
 *  is preceded by its marker on its own line (segments joined with
 *  `/`); root sections (empty `path`) emit only their content. */
export function joinTabs(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return "";
  const out = [];
  for (const s of sections) {
    const path = Array.isArray(s?.path) ? s.path.filter(Boolean) : [];
    const content = (s?.content || "").replace(/\s+$/, "");
    if (path.length) {
      if (out.length) out.push("");
      out.push(pathToMarker(path));
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

/** Render a path array (`["Parent", "Child"]`) as the canonical
 *  marker form (`---Parent---/---Child---`). */
export function pathToMarker(path) {
  return path.map((p) => `---${p}---`).join("/");
}

/** Render a path array as a human-readable label for the editor pill
 *  and sidebar/outline displays (`Parent / Child`). */
export function pathToLabel(path) {
  return Array.isArray(path) ? path.join(" / ") : "";
}
