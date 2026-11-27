/**
 * Section links — the links the Project Overview's Doc makes from a
 * piece of its text to a section of the project (one of its documents,
 * or a placeholder for one).
 *
 * They are plain Markdown links in the document's text,
 * `[the words](hush-section://<target>)`, so they travel with it: undo,
 * versions, sync and other windows need nothing of their own. `target`
 * is a document's fileId, or `placeholder/<placeholderId>` for a
 * document not written yet (project-overview/board/board-model.js keeps
 * which document a created placeholder became).
 *
 * On the Overview Doc they are drawn by project-overview/section-links.js
 * — a subtle underline, the syntax kept out of sight — and it claims
 * them with `sectionLinksOwned`, which tells the ordinary link renderer
 * (link-decorator.js) to leave them alone there. Anywhere else they are
 * ordinary rendered links, and ⌘-click opens the Project Overview at the
 * section (project-overview/section-link-open.js).
 *
 * Dependency-free on purpose: the editor's link renderer imports it.
 */
import { Facet } from "@codemirror/state";

export const SECTION_URL_PREFIX = "hush-section://";
const PLACEHOLDER = "placeholder/";

/** `[text](hush-section://target)` — the text without brackets or line
 *  breaks, the target without spaces or parentheses. */
const SECTION_LINK_RE = /(?<!!)\[([^\[\]\n]+)\]\(hush-section:\/\/([^()\s]+)\)/g;

/** True when this editor draws section links itself. */
export const sectionLinksOwned = Facet.define({ combine: (values) => values.some(Boolean) });

export const isSectionUrl = (url) => typeof url === "string" && url.startsWith(SECTION_URL_PREFIX);

/** `{ fileId }` or `{ phId }` for a link's target string. */
export function parseSectionTarget(target) {
  const t = String(target || "");
  if (t.startsWith(PLACEHOLDER)) return { phId: t.slice(PLACEHOLDER.length) };
  return { fileId: t };
}

/** The target string for a document (`{ fileId }`) or a placeholder
 *  (`{ phId }`). */
export function sectionTarget({ fileId, phId }) {
  return phId ? PLACEHOLDER + phId : String(fileId || "");
}

export const sectionUrl = (target) => SECTION_URL_PREFIX + target;

/** Every section link in `text`, in order:
 *  `{ from, to, textFrom, textTo, text, target }` — `from`/`to` the whole
 *  link, `textFrom`/`textTo` the words inside the brackets. */
export function parseSectionLinks(text, offset = 0) {
  const out = [];
  SECTION_LINK_RE.lastIndex = 0;
  for (let m = SECTION_LINK_RE.exec(text); m; m = SECTION_LINK_RE.exec(text)) {
    const from = offset + m.index;
    out.push({
      from,
      to: from + m[0].length,
      textFrom: from + 1,
      textTo: from + 1 + m[1].length,
      text: m[1],
      target: m[2],
    });
  }
  return out;
}
