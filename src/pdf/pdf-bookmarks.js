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
 *    viewer toolbar and the shelf's thumbnail badge
 *  - `hush-pdf://<fileId>/<bookmarkId>` links: building them for the
 *    cmd-drag-into-doc/notebook gesture, and resolving them back into
 *    "open that PDF at that bookmark" on click.
 */

import {
  getPdfBookmarks, addPdfBookmark, updatePdfBookmark, removePdfBookmark,
} from "../sync/pdf-sync.js";
import { POPOUT_ICON } from "./pdf-viewer-icons.js";

export const BOOKMARK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h12V21l-6-4.4L6 21z"/></svg>`;
const EDIT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4.5-1L20 7.5 16.5 4 5 15.5z"/></svg>`;

// Mirrors the sidebar ROW_COLORS swatches so the palette reads familiar.
export const BOOKMARK_COLORS = [
  "#ef5350", "#ff9800", "#ffeb3b", "#4caf50",
  "#00bcd4", "#42a5f5", "#ab47bc", "#ec407a",
];

let _state = null;

// Live page / fold bookmark buttons across every mounted viewer — kept
// painted (persistent + colored on bookmarked pages) as the registry
// changes. One listener + isConnected pruning keeps it leak-free
// through viewer reloads and suspend/resume cycles.
const _pageButtons = new Set();
// Clip-bookmark overlays, same lifecycle as the page buttons above.
const _clipLayers = new Set();
// The open list popup, so registry changes rebuild it in place (a
// bookmark added from a pane appears in an already-open menu).
let _openList = null;

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
  if (_openList && _openList.fileId === fileId) _openList.rebuild();
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

// ===== Floating popup plumbing (one open at a time) =====

let _popupEl = null;
let _popupCleanup = null;

export function closeBookmarkPopup() {
  if (_popupCleanup) { _popupCleanup(); _popupCleanup = null; }
  if (_popupEl) { _popupEl.remove(); _popupEl = null; }
  _openList = null;
}

function mountPopup(el, anchor) {
  closeBookmarkPopup();
  _popupEl = el;
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  let left = Math.min(r.left, window.innerWidth - w - 8);
  if (left < 8) left = 8;
  el.style.top = `${top}px`;
  el.style.left = `${left}px`;

  const onDown = (e) => { if (_popupEl && !_popupEl.contains(e.target)) closeBookmarkPopup(); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeBookmarkPopup(); }
  };
  // Defer one frame so the opening click doesn't instantly close it.
  // `pointerdown`, not `mousedown`: iOS delivers the synthetic
  // `mousedown` hundreds of ms after `touchend`, well past that frame,
  // so a touch-opened popup would dismiss itself on the very tap that
  // opened it (README-TECHNICAL, Platform gotchas).
  requestAnimationFrame(() => {
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  });
  _popupCleanup = () => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  };
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
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
  const el = document.createElement("div");
  el.className = "pdf-bm-popover";
  let color = bookmark?.color || BOOKMARK_COLORS[0];
  const title = isEdit
    ? (isClip ? "Edit clip" : "Edit bookmark")
    : (isClip ? `Clip on page ${page}` : `Bookmark page ${page}`);
  el.innerHTML = `
    <div class="pdf-bm-popover-title">${title}</div>
    <input type="text" class="pdf-bm-name" placeholder="Bookmark name" value="${escHtml(bookmark?.name || "")}" />
    <div class="pdf-bm-colors">
      ${BOOKMARK_COLORS.map((c) => `<button type="button" class="pdf-bm-swatch${c === color ? " active" : ""}" data-color="${c}" style="--bm-color:${c}"></button>`).join("")}
    </div>
    <div class="pdf-bm-actions">
      ${isEdit ? `<button type="button" class="pdf-bm-btn pdf-bm-delete">Delete</button>` : ""}
      <span class="pdf-bm-actions-spacer"></span>
      <button type="button" class="pdf-bm-btn pdf-bm-cancel">Cancel</button>
      <button type="button" class="pdf-bm-btn pdf-bm-save">${isEdit ? "Save" : (isClip ? "Add clip" : "Add bookmark")}</button>
    </div>
  `;
  mountPopup(el, anchor);

  const nameInput = el.querySelector(".pdf-bm-name");
  el.querySelectorAll(".pdf-bm-swatch").forEach((sw) => {
    sw.addEventListener("click", () => {
      color = sw.dataset.color;
      el.querySelectorAll(".pdf-bm-swatch").forEach((s) => s.classList.toggle("active", s === sw));
    });
  });

  const save = async () => {
    const name = nameInput.value;
    closeBookmarkPopup();
    if (isEdit) await updatePdfBookmark(fileId, bookmark.id, { name, color });
    else await addPdfBookmark(fileId, { name, color, page, x: point?.x, y: point?.y });
    onDone?.();
  };
  el.querySelector(".pdf-bm-save").addEventListener("click", save);
  el.querySelector(".pdf-bm-cancel").addEventListener("click", () => closeBookmarkPopup());
  el.querySelector(".pdf-bm-delete")?.addEventListener("click", async () => {
    closeBookmarkPopup();
    await removePdfBookmark(fileId, bookmark.id);
    onDone?.();
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
  });
  nameInput.focus();
  nameInput.select();
}

// ===== Bookmark list popup (view / edit / delete / drag-out) =====

/**
 * @param {object} opts
 * @param {Element} opts.anchor
 * @param {string}  opts.fileId
 * @param {(bm: object) => void} [opts.onPick]  Row click. Defaults to
 *        opening the PDF at the bookmark in the main viewer.
 * @param {Function} [opts.onChanged]  Fires after any edit / delete.
 */
export function openBookmarkListPopup({ anchor, fileId, onPick, onChanged }) {
  const el = document.createElement("div");
  el.className = "pdf-bm-popup";
  const pick = onPick || ((bm) => openPdfAtBookmark(fileId, bm.id));

  const rebuild = () => {
    const bookmarks = getPdfBookmarks(fileId);
    if (!bookmarks.length) {
      el.innerHTML = `<div class="pdf-bm-empty">No bookmarks yet.</div>`;
      return;
    }
    el.innerHTML = bookmarks.map((bm) => `
      <div class="pdf-bm-row" data-bm-id="${escHtml(bm.id)}">
        <span class="pdf-bm-dot${isClipBookmark(bm) ? " is-clip" : ""}" style="--bm-color:${escHtml(bm.color)}"></span>
        <span class="pdf-bm-row-name">${escHtml(bm.name)}</span>
        <span class="pdf-bm-row-page">p. ${bm.page}</span>
        <button type="button" class="pdf-bm-row-btn pdf-bm-row-edit" title="Edit bookmark">${EDIT_ICON}</button>
        <button type="button" class="pdf-bm-row-btn pdf-bm-row-delete" title="Delete bookmark">×</button>
      </div>
    `).join("");

    el.querySelectorAll(".pdf-bm-row").forEach((row) => {
      const bm = bookmarks.find((b) => b.id === row.dataset.bmId);
      if (!bm) return;
      row.addEventListener("click", (e) => {
        if (e.target.closest(".pdf-bm-row-btn")) return;
        closeBookmarkPopup();
        pick(bm);
      });
      // Cmd-drag a row out as a markdown deep link — drops into any doc
      // editor or notebook canvas via the shared text-drag pipeline.
      row.addEventListener("pointerdown", async (e) => {
        const { isCmdHeld } = await import("../cmd-button.js");
        if (!(e.metaKey || e.ctrlKey || isCmdHeld())) return;
        e.preventDefault();
        e.stopPropagation();
        const { startTextDrag } = await import("../pane/text-drag.js");
        closeBookmarkPopup();
        startTextDrag({ text: bookmarkMarkdownLink(fileId, bm), initialEvent: e });
      });
      row.querySelector(".pdf-bm-row-edit").addEventListener("click", (e) => {
        e.stopPropagation();
        const anchorRect = row.getBoundingClientRect();
        const fakeAnchor = { getBoundingClientRect: () => anchorRect };
        openBookmarkEditor({
          anchor: fakeAnchor, fileId, bookmark: bm,
          onDone: () => {
            onChanged?.();
            openBookmarkListPopup({ anchor, fileId, onPick, onChanged });
          },
        });
      });
      row.querySelector(".pdf-bm-row-delete").addEventListener("click", async (e) => {
        e.stopPropagation();
        await removePdfBookmark(fileId, bm.id);
        onChanged?.();
        rebuild();
        if (!getPdfBookmarks(fileId).length) closeBookmarkPopup();
      });
    });
  };

  rebuild();
  mountPopup(el, anchor);
  // Registry changes rebuild the open popup in place — e.g. a bookmark
  // added from a page button in a pane while this menu is up.
  _openList = { fileId, rebuild };
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

/** A zero-size anchor at a screen point, for popups that open at the
 *  pointer rather than off an element. */
function pointAnchor(x, y) {
  return {
    getBoundingClientRect: () => ({
      left: x, right: x, top: y, bottom: y, width: 0, height: 0, x, y,
    }),
  };
}

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
      anchor: btn, fileId,
      onPick: (bm) => goToPage(bm.page),
    });
  });
  return btn;
}
