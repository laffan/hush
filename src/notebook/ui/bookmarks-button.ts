/**
 * The toolbar's bookmark button: the shared bookmark list (the one the
 * PDF viewer's toolbar opens — `ui/bookmark-ui.js`) over this canvas's
 * bookmarks, ending in Add Bookmark, which arms the stamp. See
 * bookmarks.ts.
 */

import type { DrawingState } from "../state";
import { h } from "./dom-helpers";
import {
  BOOKMARK_ICON, bookmarkStampKey, endBookmarkStamp, openBookmarkEditor, openBookmarkListPopup,
  refreshBookmarkList,
} from "../../ui/bookmark-ui.js";
import {
  armBookmarkStamp, bookmarkLinkText, bookmarkStampKeyFor, deleteBookmark, focusBookmark, updateBookmark,
} from "../bookmarks";

/** The list's key: one per canvas, so an open list rebuilds only for
 *  the canvas it belongs to. */
const keys = new WeakMap<DrawingState, string>();
let nextKey = 1;
export function bookmarkListKey(state: DrawingState): string {
  let k = keys.get(state);
  if (!k) { k = `nb-list:${nextKey++}`; keys.set(state, k); }
  return k;
}

export function openNotebookBookmarkList(state: DrawingState, anchor: Element): void {
  openBookmarkListPopup({
    anchor,
    key: bookmarkListKey(state),
    getItems: () => state.bookmarks,
    onPick: (bm) => focusBookmark(state, bm.id),
    onEdit: (bm, rect) => openBookmarkEditor({
      anchor: { getBoundingClientRect: () => rect },
      title: "Edit bookmark",
      name: bm.name,
      color: bm.color,
      saveLabel: "Save",
      onSave: (name, color) => updateBookmark(state, bm.id, { name: name.trim() || bm.name, color }),
      onDelete: () => deleteBookmark(state, bm.id),
    }),
    onDelete: (bm) => deleteBookmark(state, bm.id),
    linkText: (bm) => bookmarkLinkText(state, bm),
    onAdd: () => armBookmarkStamp(state),
  });
}

export function createBookmarksButton(state: DrawingState): HTMLElement {
  const btn = h("button", {
    title: "Bookmarks",
    style: {
      width: "36px", height: "36px", border: "none", borderRadius: "8px", background: "transparent",
      cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", position: "relative",
    },
    onClick: () => openNotebookBookmarkList(state, btn),
  });
  btn.classList.add("bookmarks-panel-trigger");
  const glyph = h("span", { style: { display: "inline-flex", width: "18px", height: "18px" } });
  glyph.innerHTML = BOOKMARK_ICON;
  btn.appendChild(glyph);
  const badge = h("span", {
    style: {
      position: "absolute", top: "2px", right: "2px", fontSize: "9px", color: "#fff",
      borderRadius: "8px", padding: "0px 4px", fontWeight: "600", lineHeight: "14px", display: "none",
    },
  });
  btn.appendChild(badge);

  let lastList: unknown = null;
  const update = () => {
    const t = state.theme;
    btn.style.color = t.foreground;
    btn.style.opacity = state.tool === "bookmark" ? "1" : "0.6";
    // Another tool picked while the stamp was armed disarms it.
    if (state.tool !== "bookmark" && bookmarkStampKey() === bookmarkStampKeyFor(state)) endBookmarkStamp();
    // A Desktop has no file for a bookmark to live in or link to.
    btn.style.display = state.desktopMode ? "none" : "flex";
    badge.style.background = t.accent;
    // Every bookmark edit replaces the array, so identity is the diff.
    if (state.bookmarks !== lastList) {
      lastList = state.bookmarks;
      const n = state.bookmarks.length;
      badge.textContent = String(n);
      badge.style.display = n ? "block" : "none";
      refreshBookmarkList(bookmarkListKey(state));
    }
  };
  state.addEventListener("change", update);
  update();
  return btn;
}
