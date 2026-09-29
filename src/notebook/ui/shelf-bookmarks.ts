/**
 * The shelf's Bookmarks section: one row per bookmark, its ribbon in the
 * bookmark's colour and its name — click to bring it to the middle of
 * the view. Filtered by the shelf's search like every other row.
 */

import type { DrawingState } from "../state";
import { h } from "./dom-helpers";
import { bookmarkGlyph } from "../../ui/bookmark-ui.js";
import { focusBookmark } from "../bookmarks";

export function makeShelfBookmarksSection(state: DrawingState, query: string): HTMLElement | null {
  const q = query.trim().toLowerCase();
  const items = state.bookmarks.filter((b) => !q || (b.name || "").toLowerCase().includes(q));
  if (!items.length) return null;
  const theme = state.theme;
  const fg = theme.foreground;
  const muted = theme.variant === "dark" ? "rgba(255,255,255,0.4)" : "#888";
  const subtleBorder = theme.variant === "dark" ? "rgba(255,255,255,0.04)" : "#f8f9fa";
  const section = h("div", { style: { padding: "4px 0", borderBottom: `1px solid ${theme.uiBorder}` } });
  section.appendChild(h("div", {
    text: "Bookmarks",
    style: { fontSize: "11px", fontWeight: "600", color: muted, textTransform: "uppercase", letterSpacing: "0.5px", padding: "4px 0" },
  }));
  for (const bm of items) {
    const row = h("div", {
      style: {
        display: "flex", alignItems: "center", gap: "6px", padding: "4px 0", cursor: "pointer",
        fontSize: "13px", borderBottom: `1px solid ${subtleBorder}`, color: fg,
      },
      onClick: () => focusBookmark(state, bm.id),
    });
    const glyph = h("span", { style: { display: "inline-flex", width: "14px", height: "14px", flex: "0 0 auto" } });
    glyph.innerHTML = bookmarkGlyph(bm.color, 14);
    row.appendChild(glyph);
    row.appendChild(h("span", {
      text: bm.name || "Bookmark",
      style: { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    }));
    section.appendChild(row);
  }
  return section;
}
