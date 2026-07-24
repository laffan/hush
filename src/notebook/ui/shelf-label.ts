/**
 * Shelf-panel label + search helpers — pure functions extracted from
 * shelf-panel.ts (700-line cap): row-label building, inline markdown
 * (`==highlight==` / `**bold**`) rendering with search-match tinting,
 * flag-colour extraction, content-match scanning, snippet rendering,
 * and the Desktop deep-search hook.
 */

/** Build a shelf-row label from a text shape's contents. Only the first
 *  line is shown (rows are single-line). Leading markdown markers — `#`
 *  for headings, `>` for blockquotes — are stripped; the row's styling
 *  signals them instead. Inline `==highlight==` markers are preserved
 *  in the label so the renderer can paint them. */
export function buildLabel(text: string, max: number): { label: string; heading: boolean; blockquote: boolean } {
  let firstLine = text.split("\n", 1)[0].trimStart();
  let blockquote = false;
  const bqMatch = firstLine.match(/^>+\s?(.*)$/);
  if (bqMatch) { blockquote = true; firstLine = bqMatch[1]; }
  const m = firstLine.match(/^#{1,6}\s+(.*)$/);
  const stripped = m ? m[1] : firstLine;
  const truncated = stripped.length > max ? stripped.substring(0, max) + "..." : stripped;
  return { label: truncated, heading: !!m, blockquote };
}

/** Default highlight tint — matches the markdown editor's `==…==`
 *  background so Docs and Notebook shelf rows read the same. */
const DEFAULT_HIGHLIGHT_BG = "rgba(255, 208, 0, 0.3)";
/** Same flag detector as `markdown.ts` — kept duplicated locally so the
 *  shelf can resolve a flag's colour without re-running the canvas
 *  parser. */
const SHELF_FLAG_RE = /^([A-Za-z][A-Za-z0-9_-]{0,24})(?::[\s\S]*)?$/;

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (h.length !== 6) return DEFAULT_HIGHLIGHT_BG;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function getHushFlagColors(): Record<string, string> {
  const appState = (window as unknown as {
    __hushState__?: { settings?: { flagColors?: Record<string, string> } };
  }).__hushState__;
  return appState?.settings?.flagColors || {};
}

/** Deep search text for a Desktop file thumbnail — doc body, notebook
 *  text, PDF metadata + annotations. Provided by desktop-view.js while
 *  a Desktop is mounted; empty everywhere else. */
export function getDesktopSearchText(key: string | undefined): string {
  if (!key) return "";
  const provider = (window as unknown as {
    __hushDesktopSearchText?: (key: string) => string;
  }).__hushDesktopSearchText;
  try { return provider ? provider(key) || "" : ""; } catch { return ""; }
}

/** Desktop-pinned sticky notes for the open Desktop, or []. The shelf is
 *  a Desktop's right sidebar, so pinned stickies list there alongside the
 *  file thumbnails (sticky-notes.js publishes the hook). */
export function getDesktopStickies(): { id: string; text: string }[] {
  const provider = (window as unknown as {
    __hushDesktopStickies?: () => { id: string; text: string }[];
  }).__hushDesktopStickies;
  try { return provider ? provider() || [] : []; } catch { return []; }
}

/** Raise + centre a desktop-pinned sticky (shelf row click). */
export function revealDesktopSticky(id: string): void {
  const fn = (window as unknown as {
    __hushRevealDesktopSticky?: (id: string) => void;
  }).__hushRevealDesktopSticky;
  try { fn?.(id); } catch { /* the sticky went away — nothing to reveal */ }
}

/** Return every unique flag hex colour found in a label. */
export function allFlagHexes(label: string, flagColors: Record<string, string>): string[] {
  const re = /==([^=]+?)==/g;
  const seen = new Set<string>();
  const result: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(label)) !== null) {
    const flag = m[1].match(SHELF_FLAG_RE);
    if (flag) {
      const c = flagColors[flag[1].toUpperCase()];
      if (c && !seen.has(c)) { seen.add(c); result.push(c); }
    }
  }
  return result;
}

/** Walk `text` and append a search-highlighted text fragment to `parent`.
 *  Matches of `query` (case-insensitive) are painted with the shared
 *  highlight tint so the user can see what their search is hitting in
 *  the shelf row while typing. */
export function appendWithSearchHighlight(parent: Node, text: string, query: string, hlBg: string): void {
  if (!query) { parent.appendChild(document.createTextNode(text)); return; }
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      parent.appendChild(document.createTextNode(text.slice(i)));
      return;
    }
    if (idx > i) parent.appendChild(document.createTextNode(text.slice(i, idx)));
    const hi = document.createElement("span");
    hi.style.background = hlBg;
    hi.style.borderRadius = "2px";
    hi.textContent = text.slice(idx, idx + q.length);
    parent.appendChild(hi);
    i = idx + q.length;
  }
}

/** Render a shelf-row label, painting `==highlight==` runs with the
 *  user's flag colour when the inner text matches a known flag (or the
 *  shared default highlight tint otherwise), `**bold**` runs in 600,
 *  and — when a `searchQuery` is supplied — wrapping every match of that
 *  query in a subtle tint so the user can see what their search is
 *  hitting while typing. Returns a span ready to drop into a row; falls
 *  back to a plain text node when there are no markers and no query. */
export function renderLabelInline(
  label: string,
  flagColors: Record<string, string>,
  searchQuery: string = "",
  searchHlBg: string = "",
): HTMLElement | Text {
  const hasMarkers = label.includes("==") || label.includes("**");
  if (!hasMarkers && !searchQuery) return document.createTextNode(label);
  const wrap = document.createElement("span");
  // Matches `==highlight==` OR `**bold**` — first capture group catches
  // the highlight body, second the bold body. Lazy bodies so adjacent
  // runs don't fuse.
  const re = /==([^=]+?)==|\*\*([^*]+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(label)) !== null) {
    if (m.index > last) appendWithSearchHighlight(wrap, label.slice(last, m.index), searchQuery, searchHlBg);
    if (m[1] !== undefined) {
      // ==highlight==
      const hi = document.createElement("span");
      const flag = m[1].match(SHELF_FLAG_RE);
      let bg = DEFAULT_HIGHLIGHT_BG;
      if (flag) {
        const c = flagColors[flag[1].toUpperCase()];
        if (c) bg = hexToRgba(c, 0.3);
      }
      Object.assign(hi.style, {
        background: bg, padding: "0 2px", borderRadius: "2px",
      } as Partial<CSSStyleDeclaration>);
      appendWithSearchHighlight(hi, m[1], searchQuery, searchHlBg);
      wrap.appendChild(hi);
    } else if (m[2] !== undefined) {
      // **bold**
      const bold = document.createElement("span");
      bold.style.fontWeight = "600";
      appendWithSearchHighlight(bold, m[2], searchQuery, searchHlBg);
      wrap.appendChild(bold);
    }
    last = m.index + m[0].length;
  }
  if (last < label.length) appendWithSearchHighlight(wrap, label.slice(last), searchQuery, searchHlBg);
  return wrap;
}

/** Find every occurrence of `q` (case-insensitive) inside `content` and
 *  return their character offsets. Capped so a long doc with the user's
 *  query everywhere doesn't flood the shelf. */
export function findContentMatches(content: string, q: string, max: number): Array<{ start: number }> {
  if (!q) return [];
  const lower = content.toLowerCase();
  const ql = q.toLowerCase();
  const out: Array<{ start: number }> = [];
  let from = 0;
  while (out.length < max) {
    const i = lower.indexOf(ql, from);
    if (i === -1) break;
    out.push({ start: i });
    from = i + ql.length;
  }
  return out;
}

/** Render a single search-result snippet: ~20 chars before the match,
 *  the match itself highlighted, and ~30 chars after. Whitespace is
 *  collapsed so the snippet stays on one line, and clipped sides get
 *  ellipses. Returns a span ready to drop into a row. */
export function buildSnippet(
  content: string,
  start: number,
  qLen: number,
  mutedColor: string,
  highlightBg: string,
): HTMLElement {
  const ctxBefore = 20;
  const ctxAfter = 30;
  const cStart = Math.max(0, start - ctxBefore);
  const cEnd = Math.min(content.length, start + qLen + ctxAfter);
  const beforeText = content.slice(cStart, start).replace(/\s+/g, " ");
  const matchText = content.slice(start, start + qLen);
  const afterText = content.slice(start + qLen, cEnd).replace(/\s+/g, " ");

  const wrap = document.createElement("span");
  Object.assign(wrap.style, {
    flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  } as Partial<CSSStyleDeclaration>);
  if (cStart > 0) {
    const lead = document.createElement("span");
    lead.style.color = mutedColor;
    lead.textContent = "…";
    wrap.appendChild(lead);
  }
  wrap.appendChild(document.createTextNode(beforeText));
  const hit = document.createElement("span");
  Object.assign(hit.style, {
    background: highlightBg, padding: "0 1px", borderRadius: "2px", fontWeight: "600",
  } as Partial<CSSStyleDeclaration>);
  hit.textContent = matchText;
  wrap.appendChild(hit);
  wrap.appendChild(document.createTextNode(afterText));
  if (cEnd < content.length) {
    const tail = document.createElement("span");
    tail.style.color = mutedColor;
    tail.textContent = "…";
    wrap.appendChild(tail);
  }
  return wrap;
}
