/**
 * PDF bookmarks — named, colored deep links into a PDF.
 *
 * Data lives on the PDF registry entry (`sync/pdf-sync.js`), keyed by
 * fileId, so the desk PDF and its project aliases share one bookmark
 * set. This module owns every bookmark surface:
 *
 *  - the per-page hover button (upper-right; the Zotero pop-out's
 *    bottom-right twin — both wired here via attachPageHoverButtons)
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

export function initPdfBookmarks(state) {
  _state = state;
  // Notebook text shapes route url-link clicks through a window hook
  // (the canvas module deliberately doesn't import app modules — same
  // pattern as __hushOpenWikilink).
  window.__hushOpenPdfBookmark = (url) => { openPdfBookmarkUrl(url); };
}

// ===== hush-pdf:// links =====

export function bookmarkUrl(fileId, bookmarkId) {
  return `hush-pdf://${fileId}/${bookmarkId}`;
}

export function parseBookmarkUrl(url) {
  const m = /^hush-pdf:\/\/([^/]+)\/([^/?#\s]+)/.exec(url || "");
  return m ? { fileId: m[1], bookmarkId: m[2] } : null;
}

export function bookmarkMarkdownLink(fileId, bm) {
  const name = (bm.name || `Page ${bm.page}`).replace(/[[\]]/g, "");
  return `[${name}](${bookmarkUrl(fileId, bm.id)})`;
}

export function openPdfBookmarkUrl(url) {
  const parsed = parseBookmarkUrl(url);
  if (parsed) openPdfAtBookmark(parsed.fileId, parsed.bookmarkId);
}

/** Open the PDF in the main viewer and land on the bookmark's page.
 *  Already-open PDFs just jump; otherwise we open and wait for the
 *  bridge's `pdf-mounted` before jumping (with a settle delay so the
 *  mount's own saved-scroll restore can't clobber the jump). */
export async function openPdfAtBookmark(fileId, bookmarkId) {
  const state = _state;
  if (!state || !fileId) return;
  const bm = getPdfBookmarks(fileId).find((b) => b.id === bookmarkId) || null;
  const page = bm?.page || 1;
  const { getPdfInstance } = await import("./pdf-bridge.js");
  if (state.currentPdfFileId === fileId && getPdfInstance()) {
    getPdfInstance().goToPage(page);
    return;
  }
  const onMounted = (fid) => {
    if (fid !== fileId) return;
    state.off("pdf-mounted", onMounted);
    clearTimeout(giveUp);
    setTimeout(async () => {
      const { getPdfInstance: get } = await import("./pdf-bridge.js");
      get()?.goToPage(page);
    }, 90);
  };
  state.on("pdf-mounted", onMounted);
  const giveUp = setTimeout(() => state.off("pdf-mounted", onMounted), 15000);
  await state.openPdf(fileId);
}

// ===== Floating popup plumbing (one open at a time) =====

let _popupEl = null;
let _popupCleanup = null;

export function closeBookmarkPopup() {
  if (_popupCleanup) { _popupCleanup(); _popupCleanup = null; }
  if (_popupEl) { _popupEl.remove(); _popupEl = null; }
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
  requestAnimationFrame(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  });
  _popupCleanup = () => {
    document.removeEventListener("mousedown", onDown, true);
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
 * @param {Function} [opts.onDone]   Called after save / delete.
 */
export function openBookmarkEditor({ anchor, fileId, page, bookmark, onDone }) {
  const isEdit = !!bookmark;
  const el = document.createElement("div");
  el.className = "pdf-bm-popover";
  let color = bookmark?.color || BOOKMARK_COLORS[0];
  el.innerHTML = `
    <div class="pdf-bm-popover-title">${isEdit ? "Edit bookmark" : `Bookmark page ${page}`}</div>
    <input type="text" class="pdf-bm-name" placeholder="Bookmark name" value="${escHtml(bookmark?.name || "")}" />
    <div class="pdf-bm-colors">
      ${BOOKMARK_COLORS.map((c) => `<button type="button" class="pdf-bm-swatch${c === color ? " active" : ""}" data-color="${c}" style="--bm-color:${c}"></button>`).join("")}
    </div>
    <div class="pdf-bm-actions">
      ${isEdit ? `<button type="button" class="pdf-bm-btn pdf-bm-delete">Delete</button>` : ""}
      <span class="pdf-bm-actions-spacer"></span>
      <button type="button" class="pdf-bm-btn pdf-bm-cancel">Cancel</button>
      <button type="button" class="pdf-bm-btn pdf-bm-save">${isEdit ? "Save" : "Add bookmark"}</button>
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
    else await addPdfBookmark(fileId, { name, color, page });
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
        <span class="pdf-bm-dot" style="--bm-color:${escHtml(bm.color)}"></span>
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
