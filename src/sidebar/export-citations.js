/**
 * Shared Zotero citation processing for the text-shaped doc exports
 * (Markdown, RTF, Google Doc). The PDF path has its own Typst-side
 * citation machinery (`typst_export/markdown.rs` + `bibliography.rs`);
 * this module is the JS mirror of that logic for the formats that don't
 * route through Typst.
 *
 * Two independent knobs, matching the modal toggles:
 *
 *   - renderCitations    Replace every inline `[@key]` (and the
 *                        `[@key](zotero://…)` linked form) with a
 *                        formatted author-date label `(Surname Year)`.
 *                        Off leaves the raw citekey markup untouched.
 *   - includeBibliography Append a `## References` section listing every
 *                        *cited* reference, sorted by author surname.
 *
 * The author-date / surname rules deliberately mirror
 * `bibliography::inline_citation` on the Rust side so a doc reads the
 * same whether it's exported to PDF or to one of the text formats.
 */

// Same shape as the PDF path's CITE_RE, but global + capturing the
// optional `(…)` link target so the linked `[@key](zotero://…)` form is
// consumed whole rather than leaving a dangling `(zotero://…)` behind.
const CITE_RE = /\[@([A-Za-z0-9_:.+-]+)\](?:\([^)\n]*\))?/g;

/**
 * Process citation markup in `content` according to `opts`. Returns the
 * rewritten markdown string. `references` is the loaded Zotero library
 * (the array `loadReferences()` resolves to); when empty, nothing is
 * rewritten and no bibliography is appended.
 */
export function applyCitations(content, references, opts = {}) {
  const { renderCitations = false, includeBibliography = false } = opts;
  if (!content || (!renderCitations && !includeBibliography)) return content;

  const byKey = new Map();
  for (const ref of references || []) {
    if (ref && ref.citekey) byKey.set(ref.citekey, ref);
  }
  if (byKey.size === 0) return content;

  // Track which references are actually cited (in first-seen order) so
  // the bibliography only lists what the prose references.
  const cited = new Map();

  let out = content.replace(CITE_RE, (match, key) => {
    const ref = byKey.get(key);
    if (ref && !cited.has(key)) cited.set(key, ref);
    if (!renderCitations) return match; // leave the raw markup in place
    return ref ? inlineCitation(ref) : match;
  });

  if (includeBibliography && cited.size > 0) {
    const refs = [...cited.values()].sort((a, b) =>
      surname(firstAuthorSeg(a.authors)).localeCompare(surname(firstAuthorSeg(b.authors)))
    );
    const entries = refs.map((r) => fullReference(r)).join("\n\n");
    out = `${out.replace(/\s+$/, "")}\n\n## References\n\n${entries}\n`;
  }

  return out;
}

/** Author-date inline label, e.g. `(Halbwachs 1992)`. Mirrors the Rust
 *  `bibliography::inline_citation`. */
export function inlineCitation(ref) {
  const surnames = splitAuthors(ref.authors).map(surname).filter(Boolean);
  let author = "";
  if (surnames.length === 1) author = surnames[0];
  else if (surnames.length === 2) author = `${surnames[0]} and ${surnames[1]}`;
  else if (surnames.length >= 3) author = `${surnames[0]} et al.`;
  const year = (ref.year || "").trim();
  if (author && year) return `(${author} ${year})`;
  if (author) return `(${author})`;
  if (year) return `(${year})`;
  const label = (ref.title || ref.citekey || "").trim();
  return `(${label})`;
}

/** One bibliography entry as markdown: `Authors (Year). *Title*.` Title
 *  is italicised so it carries through RTF / Google Doc conversion. */
function fullReference(ref) {
  const authors = splitAuthors(ref.authors).join("; ");
  const year = (ref.year || "").trim();
  const title = (ref.title || "").trim();
  const head = authors || surname(firstAuthorSeg(ref.authors)) || "";
  const yearPart = year ? ` (${year})` : "";
  const titlePart = title ? ` *${title}*.` : "";
  const lead = head ? `${head}${yearPart}.` : `${yearPart.replace(/^ /, "")}`.trim();
  return `${lead}${titlePart}`.trim() || `*${ref.citekey}*`;
}

/** Zotero stores authors as a `;`-joined list of `Last, First` (or bare
 *  `Full Name`) segments. */
function splitAuthors(s) {
  return (s || "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
}

function firstAuthorSeg(s) {
  return splitAuthors(s)[0] || "";
}

/** Surname from a single author segment: the part before the comma when
 *  present, else the last whitespace-delimited token. */
function surname(seg) {
  if (!seg) return "";
  const comma = seg.indexOf(",");
  if (comma !== -1) return seg.slice(0, comma).trim();
  const parts = seg.trim().split(/\s+/);
  return parts[parts.length - 1] || "";
}
