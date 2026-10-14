/**
 * Custom icons — the tiny-icons set (src/assets/tiny-icons/) a desk,
 * folder or project can wear in place of its stock glyph.
 *
 * The set is read at build time. Each file's root `<svg>` is dropped and
 * only its geometry kept, so every caller draws the icon inside an
 * `<svg>` of its own: the class it is given decides size and stroke
 * width in CSS (a 15 px row icon at 1 px, the desk switcher's 30 px
 * corner glyph at 2 px), and colour is always `currentColor`.
 *
 * An icon is stored by name (its file name without `.svg`). A name the
 * set no longer has — an icon removed or renamed upstream — renders as
 * nothing here, and callers fall back to the node's default glyph.
 */

import { ICON_KEYWORDS } from "./custom-icon-keywords.js";

const files = import.meta.glob("../assets/tiny-icons/*.svg", { query: "?raw", import: "default", eager: true });

/** name → inner SVG markup (the paths, circles and ellipses). */
const GEOMETRY = new Map();
for (const [path, raw] of Object.entries(files)) {
  const name = path.split("/").pop().replace(/\.svg$/, "");
  const inner = String(raw).match(/<svg[^>]*>([\s\S]*?)<\/svg>/)?.[1]?.trim();
  if (inner) GEOMETRY.set(name, inner);
}

/** Every icon name, alphabetical — the picker's order. */
export const CUSTOM_ICON_NAMES = [...GEOMETRY.keys()].sort();

/** Is `name` an icon the set (still) has? */
export function isCustomIcon(name) {
  return typeof name === "string" && GEOMETRY.has(name);
}

/** How well one query word fits an icon, lower is better: its name
 *  starts with the word (0) or contains it (1); one of its search words
 *  is the word (2), starts with it (3), or — for words of four letters
 *  or more, since a short one turns up inside everything ("pen" in
 *  "open") — contains it (4). -1 is no match. */
function wordScore(name, word) {
  const label = name.replace(/-/g, " ");
  if (label.startsWith(word) || label.includes(" " + word)) return 0;
  if (label.includes(word)) return 1;
  const keys = ICON_KEYWORDS[name] || [];
  if (keys.includes(word)) return 2;
  if (keys.some((k) => k.startsWith(word) || k.includes(" " + word))) return 3;
  if (word.length >= 4 && keys.some((k) => k.includes(word))) return 4;
  return -1;
}

/** The icons matching `query`, best first. Every word of the query has
 *  to land on the icon's name or one of its search words
 *  (custom-icon-keywords.js), so "pen" finds the feather and "sea boat"
 *  the anchor; an icon whose name fits ranks above one that only fits by
 *  association. An empty query is the whole set, alphabetical. */
export function searchCustomIcons(query) {
  const words = String(query || "").toLowerCase().replace(/-/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return CUSTOM_ICON_NAMES.slice();
  const scored = [];
  for (const name of CUSTOM_ICON_NAMES) {
    let total = 0;
    for (const w of words) {
      const s = wordScore(name, w);
      if (s < 0) { total = -1; break; }
      total += s;
    }
    if (total >= 0) scored.push([total, name]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])).map(([, name]) => name);
}

/** "soda-can" → "Soda can", for tooltips and the picker's labels. */
export function customIconLabel(name) {
  const s = String(name || "").replace(/-/g, " ");
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

/** The icon as an `<svg>` string with `className` on it, or "" for a
 *  name the set doesn't have. Stroke attributes ride the element so the
 *  icon draws correctly anywhere; CSS on `className` overrides them. */
export function customIconSvg(name, className = "") {
  const inner = GEOMETRY.get(name);
  if (!inner) return "";
  const cls = `custom-icon${className ? ` ${className}` : ""}`;
  return `<svg viewBox="0 0 15 15" class="${cls}" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

/** The custom icon a desk wears, by name, or null. Desks keep it in
 *  their portable meta (`desksMeta[deskId].icon`, mirrored into the
 *  desk's `.hushdesk`), beside the style and Ratchet choices. */
export function deskIconName(state, deskId) {
  const name = state?.settings?.desksMeta?.[deskId]?.icon;
  return isCustomIcon(name) ? name : null;
}

/** Does a desk with a custom icon also show its name beside it in the
 *  desk switcher? Off by default — the icon stands in for the name — and
 *  turned on per desk by the palette's "View Desk Name"
 *  (`desksMeta[deskId].showName`, portable like the icon). */
export function deskShowsName(state, deskId) {
  return !!state?.settings?.desksMeta?.[deskId]?.showName;
}
