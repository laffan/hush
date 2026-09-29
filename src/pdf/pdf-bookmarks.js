/**
 * PDF bookmarks — named, colored deep links into a PDF.
 *
 * Data lives on the PDF registry entry (`sync/pdf-sync.js`), keyed by
 * fileId, so the desk PDF and its project aliases share one bookmark
 * set. This module owns every bookmark surface:
 *
 *  - the per-page hover button (upper-right; the Zotero pop-out's
 *    bottom-right twin — both wired here via attachPageHoverButtons)
 *  - clip bookmarks: double-click anywhere on a page to bookmark that
 *    *point*, drawn as a dot with a dashed line running out to a clip
 *    tab on the page's left edge
 *  - the fold-mode button beside each fold's expand toggle
 *  - the create / edit popover (name + color)
 *  - the bookmark list popup (view / edit / delete rows) used by the
 *    viewer toolbar and the shelf's thumbnail badge; from the toolbar
 *    it ends in Add Bookmark, which arms the stamp — the next click on
 *    a page of this PDF drops a clip there
 *
 * The popups themselves, the palette and the stamp are the shared
 * bookmark UI (`ui/bookmark-ui.js`) that notebooks use too.
 *  - `hush-pdf://<fileId>/<bookmarkId>` links: building them for the
 *    cmd-drag-into-doc/notebook gesture, and resolving them back into
 *    "open that PDF at that bookmark" on click.
 */

import {
  getPdfBookmarks, addPdfBookmark, updatePdfBookmark, removePdfBookmark,
} from "../sync/pdf-sync.js";
import { POPOUT_ICON } from "./pdf-viewer-icons.js";
import {
  BOOKMARK_ICON, BOOKMARK_COLORS, escHtml, pointAnchor, closeBookmarkPopup,
  openBookmarkEditor as openSharedEditor, openBookmarkListPopup as openSharedList,
  refreshBookmarkList, startBookmarkStamp, bookmarkStampKey, endBookmarkStamp,
} from "../ui/bookmark-ui.js";

export { BOOKMARK_ICON, BOOKMARK_COLORS, closeBookmarkPopup };

let _state = null;

// Live page / fold bookmark buttons across every mounted viewer — kept
// painted (persistent + colored on bookmarked pages) as the registry
// changes. One listener + isConnected pruning keeps it leak-free
// through viewer reloads and suspend/resume cycles.
const _pageButtons = new Set();
// Clip-bookmark overlays, same lifecycle as the page buttons above.
const _clipLayers = new Set();

/** A bookmark that points at a spot on the page rather than the page as
 *  a whole. `x` / `y` are fractions of the page box (0–1, y down), so
 *  they survive zoom and re-render untouched. */
export function isClipBookmark(bm) {
  return Number.isFinite(bm?.x) && Number.isFinite(bm?.y);
}

function paintPageBookmarkButton(entry) {
  const marks = getPdfBookmarks(entry.fileId).filter((b) => b.page === entry.page);
  const has = marks.length > 0;
  entry.btn.classList.toggle("has-bookmark", has);
  if (has) entry.btn.style.setProperty("--bm-color", marks[0].color || "#ef5350");
  else entry.btn.style.removeProperty("--bm-color");
}

function registerPageButton(btn, fileId, page) {
  const entry = { btn, fileId, page };
  _pageButtons.add(entry);
  paintPageBookmarkButton(entry);
}

function onBookmarksChanged(fileId) {
  for (const entry of [..._pageButtons]) {
    if (!entry.btn.isConnected) { _pageButtons.delete(entry); continue; }
    if (entry.fileId === fileId) paintPageBookmarkButton(entry);
  }
  for (const entry of [..._clipLayers]) {
    if (!entry.layer.isConnected) { _clipLayers.delete(entry); continue; }
    if (entry.fileId === fileId) paintClipLayer(entry);
  }
  // An open list rebuilds in place — a bookmark added from a pane
  // appears in an already-open menu.
  refreshBookmarkList(stampKey(fileId));
}

/** Touch-mode ⌘ (`cmd-button.js`), resolved once at boot. The clip drag
 *  has to decide whether the modifier is down *synchronously* inside
 *  pointerdown — an awaited import there lands after the gesture has
 *  already been claimed by the page. */
let _isCmdHeld = () => false;

export function initPdfBookmarks(state) {
  _state = state;
  import("../cmd-button.js")
    .then((m) => { if (typeof m.isCmdHeld === "function") _isCmdHeld = m.isCmdHeld; })
    .catch(() => { /* touch-mode pills unavailable — the real key still works */ });
  // Notebook text shapes route url-link clicks through a window hook
  // (the canvas module deliberately doesn't import app modules — same
  // pattern as __hushOpenWikilink).
  window.__hushOpenPdfBookmark = (url) => { openPdfBookmarkUrl(url); };
  state.on("pdf-bookmarks-changed", onBookmarksChanged);
}

// ===== hush-pdf:// links =====

/** Links carry the page as a `?p=` fallback so they still land right
 *  even if the bookmark is later deleted (or the registry isn't loaded
 *  when the click fires). A live bookmark's current page wins. */
export function bookmarkUrl(fileId, bm) {
  return `hush-pdf://${fileId}/${bm.id}?p=${bm.page}`;
}

export function parseBookmarkUrl(url) {
  const m = /^hush-pdf:\/\/([^/]+)\/([^/?#\s]+?)(?:\?p=(\d+))?$/.exec((url || "").trim());
  return m ? { fileId: m[1], bookmarkId: m[2], page: m[3] ? parseInt(m[3], 10) : 0 } : null;
}

export function bookmarkMarkdownLink(fileId, bm) {
  const name = (bm.name || `Page ${bm.page}`).replace(/[[\]]/g, "");
  return `[${name}](${bookmarkUrl(fileId, bm)})`;
}

export function openPdfBookmarkUrl(url) {
  const parsed = parseBookmarkUrl(url);
  if (parsed) openPdfAtBookmark(parsed.fileId, parsed.bookmarkId, parsed.page);
}

/** Open the PDF in the main viewer and land on the bookmark's page.
 *  Already-open PDFs jump in place (smooth); otherwise the jump is
 *  registered with the bridge (`requestPdfJump`) and performed inside
 *  the mount itself, replacing the saved-scroll restore — no event /
 *  timing race. */
export async function openPdfAtBookmark(fileId, bookmarkId, fallbackPage = 0) {
  const state = _state;
  if (!state || !fileId) return;
  const bm = getPdfBookmarks(fileId).find((b) => b.id === bookmarkId) || null;
  const page = bm?.page || fallbackPage || 1;
  const { getPdfInstance, requestPdfJump } = await import("./pdf-bridge.js");
  if (state.currentPdfFileId === fileId && getPdfInstance()) {
    getPdfInstance().goToPage(page);
    return;
  }
  requestPdfJump(fileId, page);
  await state.openPdf(fileId);
}

// ===== Create / edit popover =====

/**
 * @param {object} opts
 * @param {Element} opts.anchor
 * @param {string}  opts.fileId
 * @param {number}  [opts.page]      Required when creating.
 * @param {object}  [opts.bookmark]  Existing bookmark → edit mode.
 * @param {{x: number, y: number}} [opts.point]  Creating a clip
 *        bookmark: page-relative fractions of the double-clicked spot.
 * @param {Function} [opts.onDone]   Called after save / delete.
 */
export function openBookmarkEditor({ anchor, fileId, page, bookmark, point, onDone }) {
  const isEdit = !!bookmark;
  const isClip = isEdit ? isClipBookmark(bookmark) : !!point;
  openSharedEditor({
    anchor,
    title: isEdit
      ? (isClip ? "Edit clip" : "Edit bookmark")
      : (isClip ? `Clip on page ${page}` : `Bookmark page ${page}`),
    name: bookmark?.name || "",
    color: bookmark?.color,
    saveLabel: isEdit ? "Save" : (isClip ? "Add clip" : "Add bookmark"),
    onSave: async (name, color) => {
      if (isEdit) await updatePdfBookmark(fileId, bookmark.id, { name, color });
      else await addPdfBookmark(fileId, { name, color, page, x: point?.x, y: point?.y });
      onDone?.();
    },
    onDelete: isEdit ? async () => {
      await removePdfBookmark(fileId, bookmark.id);
      onDone?.();
    } : undefined,
  });
}

// ===== Bookmark list popup (view / edit / delete / drag-out) =====

/** The list's / stamp's key for a PDF's bookmark set. */
function stampKey(fileId) { return `pdf:${fileId}`; }

/**
 * @param {object} opts
 * @param {Element} opts.anchor
 * @param {string}  opts.fileId
 * @param {(bm: object) => void} [opts.onPick]  Row click. Defaults to
 *        opening the PDF at the bookmark in the main viewer.
 * @param {Function} [opts.onChanged]  Fires after any edit / delete.
 * @param {boolean} [opts.canAdd]  End the list in Add Bookmark (a viewer
 *        showing this PDF is there to take the stamp).
 */
export function openBookmarkListPopup({ anchor, fileId, onPick, onChanged, canAdd }) {
  const reopen = () => openBookmarkListPopup({ anchor, fileId, onPick, onChanged, canAdd });
  openSharedList({
    anchor,
    key: stampKey(fileId),
    getItems: () => getPdfBookmarks(fileId),
    meta: (bm) => `p. ${bm.page}`,
    onPick: onPick || ((bm) => openPdfAtBookmark(fileId, bm.id)),
    onEdit: (bm, rect) => {
      openBookmarkEditor({
        anchor: { getBoundingClientRect: () => rect }, fileId, bookmark: bm,
        onDone: () => { onChanged?.(); reopen(); },
      });
    },
    onDelete: async (bm) => {
      await removePdfBookmark(fileId, bm.id);
      onChanged?.();
      if (!getPdfBookmarks(fileId).length && !canAdd) closeBookmarkPopup();
    },
    linkText: (bm) => bookmarkMarkdownLink(fileId, bm),
    onAdd: canAdd ? () => startBookmarkStamp(stampKey(fileId)) : undefined,
  });
}

// ===== Page-hover buttons (viewer pages) =====

/**
 * Wire the per-page hover buttons onto a page wrapper: the bookmark
 * button (upper-right) and — when the PDF came from Zotero — the
 * page pop-out (bottom-right, moved here from pdf-viewer.js). One
 * mousemove handler drives both corner zones.
 */
export function attachPageHoverButtons(wrapper, pageNum, { zoteroAttKey, fileId }) {
  let zBtn = null;
  let bmBtn = null;

  if (zoteroAttKey) {
    zBtn = document.createElement("button");
    zBtn.className = "pdf-page-zotero-btn";
    zBtn.title = `Open page ${pageNum} in Zotero`;
    zBtn.innerHTML = POPOUT_ICON;
    zBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const url = `zotero://open-pdf/library/items/${zoteroAttKey}?page=${pageNum}`;
      import("@tauri-apps/plugin-opener").then(o => o.openUrl(url)).catch(() => window.open(url, "_blank"));
    });
    wrapper.appendChild(zBtn);
  }

  if (fileId) {
    bmBtn = document.createElement("button");
    bmBtn.className = "pdf-page-bookmark-btn";
    bmBtn.title = `Bookmark page ${pageNum}`;
    bmBtn.innerHTML = BOOKMARK_ICON;
    bmBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openBookmarkEditor({ anchor: bmBtn, fileId, page: pageNum });
    });
    wrapper.appendChild(bmBtn);
    // Pages that carry bookmarks keep the icon visible (filled with the
    // bookmark's color) without hover — and stay live as bookmarks change.
    registerPageButton(bmBtn, fileId, pageNum);
  }

  if (!zBtn && !bmBtn) return;
  wrapper.addEventListener("mousemove", (e) => {
    const r = wrapper.getBoundingClientRect();
    const nearRight = (r.right - e.clientX) < 100;
    if (zBtn) zBtn.classList.toggle("visible", nearRight && (r.bottom - e.clientY) < 100);
    if (bmBtn) bmBtn.classList.toggle("visible", nearRight && (e.clientY - r.top) < 100);
  });
  wrapper.addEventListener("mouseleave", () => {
    zBtn?.classList.remove("visible");
    bmBtn?.classList.remove("visible");
  });
}

// ===== Clip bookmarks (a point on a page) =====

/**
 * Double-click anywhere on a page to bookmark that point, and draw the
 * clips already on it.
 *
 * The overlay is positioned in page fractions rather than pixels, so
 * zooming, re-rendering, or resizing the pane moves the marks with the
 * page for free — the wrapper is the page box at every zoom level, and
 * percentages ride it.
 */
export function attachPageClipBookmarks(wrapper, pageNum, { fileId }) {
  if (!fileId) return;
  const layer = document.createElement("div");
  layer.className = "pdf-clip-layer";
  wrapper.appendChild(layer);
  const entry = { layer, fileId, page: pageNum };
  _clipLayers.add(entry);
  paintClipLayer(entry);

  /** Open the create popover for a double-click/tap at a screen point. */
  const clipAt = (clientX, clientY, target) => {
    // Anything with its own double-click meaning keeps it: the page's
    // own link annotations, the hover buttons, and the clip marks
    // (which open their own editor on a single click).
    if (target?.closest?.(".pdf-clip-mark, .pdf-page-bookmark-btn, .pdf-page-zotero-btn, .pdf-link-layer")) return false;
    const r = wrapper.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    openBookmarkEditor({
      anchor: pointAnchor(clientX, clientY),
      fileId,
      page: pageNum,
      point: {
        x: clamp01((clientX - r.left) / r.width),
        y: clamp01((clientY - r.top) / r.height),
      },
    });
    return true;
  };

  // An armed stamp (Add Bookmark in the list) takes the next click on
  // any page of this PDF, in whichever viewer shows it.
  wrapper.addEventListener("click", (e) => {
    if (bookmarkStampKey() !== stampKey(fileId)) return;
    if (!clipAt(e.clientX, e.clientY, e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    endBookmarkStamp();
  }, true);

  let lastTouchClip = 0;
  wrapper.addEventListener("dblclick", (e) => {
    // iOS synthesises a click pair after a double tap the detector
    // below has already acted on — don't open the popover twice.
    if (Date.now() - lastTouchClip < 700) return;
    if (clipAt(e.clientX, e.clientY, e.target)) e.preventDefault();
  });

  // Touch double-tap. iPadOS doesn't reliably deliver `dblclick` for a
  // two-finger-free double tap inside the webview, and this is the
  // platform the gesture is for. Concurrent contacts poison the
  // gesture: a pinch ends as two `pointerup`s milliseconds apart, which
  // otherwise reads as a double tap (see README-TECHNICAL, Platform
  // gotchas). `pointercancel` feeds the same bookkeeping so the active
  // set can't leak and wedge the detector.
  const active = new Set();
  let poisoned = false;
  let lastTap = null;
  wrapper.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    active.add(e.pointerId);
    if (active.size > 1) { poisoned = true; lastTap = null; }
  });
  const endTouch = (e, cancelled) => {
    if (e.pointerType !== "touch") return;
    active.delete(e.pointerId);
    if (active.size === 0 && poisoned) { poisoned = false; return; }
    if (cancelled || poisoned) return;
    const now = Date.now();
    const near = lastTap
      && now - lastTap.t < 400
      && Math.abs(e.clientX - lastTap.x) < 30
      && Math.abs(e.clientY - lastTap.y) < 30;
    if (near) {
      lastTap = null;
      if (clipAt(e.clientX, e.clientY, e.target)) lastTouchClip = now;
      return;
    }
    lastTap = { t: now, x: e.clientX, y: e.clientY };
  };
  wrapper.addEventListener("pointerup", (e) => endTouch(e, false));
  wrapper.addEventListener("pointercancel", (e) => endTouch(e, true));
}

function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }

function paintClipLayer(entry) {
  const clips = getPdfBookmarks(entry.fileId)
    .filter((b) => b.page === entry.page && isClipBookmark(b));
  entry.layer.innerHTML = clips.map((bm) => `
    <div class="pdf-clip-mark" data-bm-id="${escHtml(bm.id)}"
         style="--bm-color:${escHtml(bm.color || "#ef5350")};
                --clip-x:${(bm.x * 100).toFixed(3)}%;
                --clip-y:${(bm.y * 100).toFixed(3)}%">
      <span class="pdf-clip-tab" title="${escHtml(bm.name || "Clip")}"></span>
      <span class="pdf-clip-line"></span>
      <span class="pdf-clip-dot" title="${escHtml(bm.name || "Clip")}"></span>
    </div>
  `).join("");

  entry.layer.querySelectorAll(".pdf-clip-mark").forEach((markEl) => {
    const bm = clips.find((b) => b.id === markEl.dataset.bmId);
    if (!bm) return;
    // Set by a drag so the release doesn't also open the editor.
    let dragged = false;
    markEl.addEventListener("click", (e) => {
      e.stopPropagation();
      if (dragged) { dragged = false; return; }
      openBookmarkEditor({
        anchor: pointAnchor(e.clientX, e.clientY),
        fileId: entry.fileId,
        page: entry.page,
        bookmark: bm,
      });
    });

    // ⌘-drag the dot to move the clip. The tab and the dashed line are
    // drawn from the same two custom properties, so writing them is the
    // whole animation — no per-frame layout of three elements.
    const dot = markEl.querySelector(".pdf-clip-dot");
    dot?.addEventListener("pointerdown", (e) => {
      if (!(e.metaKey || e.ctrlKey || _isCmdHeld())) return;
      e.preventDefault();
      e.stopPropagation();
      const page = entry.layer.getBoundingClientRect();
      if (!page.width || !page.height) return;
      dot.setPointerCapture(e.pointerId);
      let at = null;
      const onMove = (me) => {
        at = {
          x: clamp01((me.clientX - page.left) / page.width),
          y: clamp01((me.clientY - page.top) / page.height),
        };
        markEl.style.setProperty("--clip-x", `${(at.x * 100).toFixed(3)}%`);
        markEl.style.setProperty("--clip-y", `${(at.y * 100).toFixed(3)}%`);
      };
      const onUp = () => {
        dot.removeEventListener("pointermove", onMove);
        dot.removeEventListener("pointerup", onUp);
        dot.removeEventListener("pointercancel", onUp);
        if (!at) return;
        dragged = true;
        // The registry write repaints this layer, which rebuilds the
        // mark at the position we've been previewing.
        updatePdfBookmark(entry.fileId, bm.id, at);
      };
      dot.addEventListener("pointermove", onMove);
      dot.addEventListener("pointerup", onUp);
      // iOS ends a claimed touch with `pointercancel`; committing there
      // keeps a drag the system interrupted rather than dropping it.
      dot.addEventListener("pointercancel", onUp);
    });
  });
}

/** Fold-mode variant: a bookmark button that sits beside the fold's
 *  expand toggle (both revealed by the fold wrapper's hover CSS). */
export function attachFoldBookmarkButton(wrapper, pageNum, getFileId) {
  const fileId = typeof getFileId === "function" ? getFileId() : getFileId;
  if (!fileId) return;
  const btn = document.createElement("button");
  btn.className = "pdf-fold-bm-btn";
  btn.title = `Bookmark page ${pageNum}`;
  btn.innerHTML = BOOKMARK_ICON;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    openBookmarkEditor({ anchor: btn, fileId, page: pageNum });
  });
  wrapper.appendChild(btn);
  registerPageButton(btn, fileId, pageNum);
}

/** The viewer toolbar's Bookmarks button — first control in the bar. */
export function createToolbarBookmarkButton({ getFileId, goToPage }) {
  const btn = document.createElement("button");
  btn.className = "pdf-zoom-btn pdf-bookmark-btn";
  btn.title = "Bookmarks";
  btn.innerHTML = BOOKMARK_ICON;
  btn.addEventListener("click", () => {
    const fileId = typeof getFileId === "function" ? getFileId() : getFileId;
    if (!fileId) return;
    openBookmarkListPopup({
      anchor: btn, fileId, canAdd: true,
      onPick: (bm) => goToPage(bm.page),
    });
  });
  return btn;
}
