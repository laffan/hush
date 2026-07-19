/**
 * PDF Shelf — a full-editor-pane gallery of the PDFs in a PDFs folder,
 * opened from the folder row's shelf button. Works for both the desk's
 * PDFs folder and a project's own PDFs folder (aliases); the cards are
 * identical since both resolve through the shared registry.
 *
 * Follows the multi-select view's takeover pattern: a single host
 * mounted into #app, toggled via the `pdf-shelf-active` body class so
 * the editor / notebook / PDF / stack surfaces keep their layout
 * underneath and closing is a class flip, not a remount.
 *
 * Each card shows the PDF's first-page cover (per-device cache — see
 * pdf-covers.js) with title, year and authors underneath; PDFs with
 * bookmarks carry a badge on the thumbnail that opens the bookmark
 * browser. Cards support cmd/ctrl-click (toggle) and shift-click
 * (range) selection — with 2+ selected a "Create Stack from Selected"
 * button joins the header. A sort dropdown orders the grid by title,
 * author, open date, or add date.
 */

import { findNode, findParentOfNode } from "../state/tree-helpers.js";
import { escHtml, showPromptModal } from "../sidebar/files-panel-shared.js";
import { getPdfMeta, isPdfDownloaded, getPdfBookmarks } from "../sync/pdf-sync.js";
import { loadPdfCoverUrl, ensurePdfCover } from "./pdf-covers.js";
import { BOOKMARK_ICON, openBookmarkListPopup } from "./pdf-bookmarks.js";

const PLACEHOLDER_SVG = `<svg viewBox="0 0 16 16" class="pdf-shelf-ph"><rect x="3" y="1" width="10" height="14" rx="1" fill="none"/><line x1="5" y1="8" x2="11" y2="8"/></svg>`;

const SORT_OPTIONS = [
  { key: "added", label: "Sort: Date added" },
  { key: "opened", label: "Sort: Date opened" },
  { key: "title", label: "Sort: Title" },
  { key: "author", label: "Sort: Author" },
];

let _host = null;
let _state = null;
let _containerId = null;
let _renderToken = 0;
let _sortMode = "added";
// Shelf-local selection (fileIds). Deliberately NOT state.selectedDocIds
// — a 2+ entry there summons the multi-select listing view over us.
let _selected = new Set();
let _anchorId = null;
// Display order of the current render, for shift-click ranges.
let _displayIds = [];

export function initPdfShelf(state) {
  if (_host) return;
  _state = state;
  _host = document.createElement("div");
  _host.id = "pdf-shelf-view";
  _host.className = "pdf-shelf-view hidden";
  document.getElementById("app")?.appendChild(_host);

  // Any single-file open path replaces the shelf — same semantics as
  // the multi-select listing (a card click lands here via pdf-open).
  const close = () => closePdfShelf();
  state.on("file-opened", close);
  state.on("notebook-open", close);
  state.on("pdf-open", close);
  state.on("stack-open", close);
  // The multi-select listing owns the takeover when a batch selection
  // starts in the sidebar while the shelf is up.
  state.on("multi-select-changed", () => {
    if ((state.selectedDocIds || []).length >= 2) closePdfShelf();
  });
  // Tree changes while open: container gone → close; otherwise repaint
  // (covers arriving from background downloads ride this too).
  state.on("files-changed", () => {
    if (!_containerId) return;
    if (!findNode(state.fileTree, _containerId)) closePdfShelf();
    else render();
  });
  state.on("pdf-bookmarks-changed", () => { if (_containerId) render(); });
  state.on("pdf-cover-ready", (fileId) => {
    if (!_containerId || !fileId) return;
    const card = _host.querySelector(`.pdf-shelf-card[data-file-id="${CSS.escape(fileId)}"]`);
    if (!card) return;
    loadPdfCoverUrl(fileId).then((url) => { if (url) setCardCover(card, url); });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !_containerId) return;
    e.preventDefault();
    e.stopPropagation();
    // First Esc clears an active card selection; second closes.
    if (_selected.size) { _selected.clear(); _anchorId = null; render(); }
    else closePdfShelf();
  }, true);
}

/** Open the shelf for a PDFs folder node (the desk special or a
 *  project's `pdfFolder`). */
export function openPdfShelf(state, containerId) {
  if (!_host) initPdfShelf(state);
  _state = state;
  if (state.selectedDocIds?.length) state.clearSelectedDocs();
  _containerId = containerId;
  _selected.clear();
  _anchorId = null;
  document.body.classList.add("pdf-shelf-active");
  _host.classList.remove("hidden");
  render();
}

export function closePdfShelf() {
  if (!_containerId) return;
  _containerId = null;
  _renderToken++;
  _selected.clear();
  _anchorId = null;
  document.body.classList.remove("pdf-shelf-active");
  if (_host) {
    _host.classList.add("hidden");
    _host.innerHTML = "";
  }
}

/** Resolve the folder node + a human scope label ("desk name" or the
 *  owning project's name). */
function shelfContext() {
  const node = findNode(_state.fileTree, _containerId);
  if (!node) return null;
  let scopeName;
  if (node.pdfFolder) {
    scopeName = findParentOfNode(_state.fileTree, node.id)?.name || "Project";
  } else {
    const deskId = String(node.id).includes(":") ? String(node.id).split(":")[1] : null;
    const desk = deskId ? _state.fileTree.find((n) => n.type === "desk" && n.id === deskId) : null;
    scopeName = desk?.name || "Desk";
  }
  const pdfs = (node.children || []).filter((c) => c.type === "pdf" && c.fileId);
  return { node, scopeName, pdfs };
}

/** Sort a card list per the active mode. Titles/authors ascend; dates
 *  descend (newest first); missing values sink to the bottom. */
function sortCards(cards) {
  const cmpStr = (a, b, key) => {
    const av = (a[key] || "").toLowerCase();
    const bv = (b[key] || "").toLowerCase();
    if (!av && !bv) return 0;
    if (!av) return 1;
    if (!bv) return -1;
    return av.localeCompare(bv);
  };
  const cmpDateDesc = (a, b, key) => (b[key] || 0) - (a[key] || 0);
  const arr = [...cards];
  if (_sortMode === "title") arr.sort((a, b) => cmpStr(a, b, "title"));
  else if (_sortMode === "author") arr.sort((a, b) => cmpStr(a, b, "author") || cmpStr(a, b, "title"));
  else if (_sortMode === "opened") arr.sort((a, b) => cmpDateDesc(a, b, "openedAt"));
  else arr.sort((a, b) => cmpDateDesc(a, b, "addedAt"));
  return arr;
}

function render() {
  const ctx = shelfContext();
  if (!ctx) { closePdfShelf(); return; }
  const token = ++_renderToken;
  const { scopeName, pdfs } = ctx;

  const cards = sortCards(pdfs.map((node) => {
    const meta = getPdfMeta(node.fileId);
    return {
      fileId: node.fileId,
      title: meta?.title || node.name || "Untitled",
      author: meta?.firstAuthor || meta?.authors || "",
      authors: meta?.authors || "",
      year: meta?.year || "",
      // Project aliases carry their own added-to-project stamp; the
      // desk shelf falls back to the registry's added-to-Hush time.
      addedAt: node.addedAt || meta?.addedAt || 0,
      openedAt: meta?.openedAt || 0,
      pending: !isPdfDownloaded(node.fileId),
      bookmarks: getPdfBookmarks(node.fileId).length,
    };
  }));
  _displayIds = cards.map((c) => c.fileId);
  // Prune selection entries that left the folder since the last paint.
  for (const id of [..._selected]) if (!_displayIds.includes(id)) _selected.delete(id);

  _host.innerHTML = `
    <div class="pdf-shelf-inner">
      <header class="pdf-shelf-header">
        <div class="pdf-shelf-title">PDF Shelf<span class="pdf-shelf-scope">${escHtml(scopeName)}</span></div>
        <div class="pdf-shelf-actions">
          <span class="pdf-shelf-count">${cards.length} PDF${cards.length === 1 ? "" : "s"}</span>
          <select class="pdf-shelf-sort" title="Sort PDFs">
            ${SORT_OPTIONS.map((o) => `<option value="${o.key}"${o.key === _sortMode ? " selected" : ""}>${o.label}</option>`).join("")}
          </select>
          ${_selected.size >= 2 ? `<button type="button" class="pdf-shelf-btn" data-shelf-stack>Create Stack from Selected</button>` : ""}
          <button type="button" class="pdf-shelf-btn" data-shelf-close>Close</button>
        </div>
      </header>
      ${cards.length ? `<div class="pdf-shelf-grid">
        ${cards.map((c) => cardHtml(c)).join("")}
      </div>` : `<div class="pdf-shelf-empty">No PDFs here yet.</div>`}
    </div>
  `;

  _host.querySelector("[data-shelf-close]")?.addEventListener("click", () => closePdfShelf());
  _host.querySelector("[data-shelf-stack]")?.addEventListener("click", () => createStackFromSelected(cards));
  const sortSel = _host.querySelector(".pdf-shelf-sort");
  sortSel?.addEventListener("change", () => { _sortMode = sortSel.value; render(); });

  _host.querySelectorAll(".pdf-shelf-card").forEach((card) => {
    card.addEventListener("click", (e) => onCardClick(card, e));
    const badge = card.querySelector(".pdf-shelf-bm-badge");
    if (badge) {
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        openBookmarkListPopup({
          anchor: badge,
          fileId: card.dataset.fileId,
          onChanged: () => { if (_containerId) render(); },
        });
      });
    }
  });

  hydrateCovers(token);
}

function onCardClick(card, e) {
  const fid = card.dataset.fileId;
  if (!fid) return;
  if (e.metaKey || e.ctrlKey) {
    if (_selected.has(fid)) _selected.delete(fid);
    else _selected.add(fid);
    _anchorId = fid;
    render();
    return;
  }
  if (e.shiftKey && _anchorId && _displayIds.includes(_anchorId)) {
    const a = _displayIds.indexOf(_anchorId);
    const b = _displayIds.indexOf(fid);
    if (b >= 0) {
      _selected = new Set(_displayIds.slice(Math.min(a, b), Math.max(a, b) + 1));
      render();
      return;
    }
  }
  // Plain click: an active selection is cleared first; with nothing
  // selected it opens the PDF (pending downloads stay a no-op).
  if (_selected.size) {
    _selected.clear();
    _anchorId = null;
    render();
    return;
  }
  _anchorId = fid;
  if (isPdfDownloaded(fid)) _state.openPdf(fid);
}

function createStackFromSelected(cards) {
  const items = cards.filter((c) => _selected.has(c.fileId));
  if (items.length < 2) return;
  showPromptModal({
    title: "New stack",
    label: "Name",
    placeholder: "New Stack",
    initialValue: "New Stack",
    confirmLabel: "Create",
    onConfirm: async (name) => {
      closePdfShelf();
      const result = await _state.createStack(name, null, { openImmediately: true });
      if (!result) return;
      await new Promise((r) => setTimeout(r, 100));
      const { getStackInstance } = await import("../stack/stack-bridge.js");
      const inst = getStackInstance();
      if (!inst) return;
      for (const it of items) inst.addItem(it.fileId, "pdf", it.title);
    },
  });
}

function cardHtml(c) {
  const sub = [c.year, c.authors].filter(Boolean).join(" — ");
  const cls = [
    "pdf-shelf-card",
    c.pending ? "pdf-shelf-pending" : "",
    _selected.has(c.fileId) ? "selected" : "",
  ].filter(Boolean).join(" ");
  return `
    <div class="${cls}" data-file-id="${escHtml(c.fileId)}">
      <div class="pdf-shelf-thumb">
        ${PLACEHOLDER_SVG}
        ${c.bookmarks ? `<button type="button" class="pdf-shelf-bm-badge" title="Bookmarks (${c.bookmarks})">${BOOKMARK_ICON}</button>` : ""}
      </div>
      <div class="pdf-shelf-card-title">${escHtml(c.title)}</div>
      ${sub ? `<div class="pdf-shelf-card-sub">${escHtml(sub)}</div>` : ""}
      ${c.pending ? `<div class="pdf-shelf-card-sub pdf-shelf-dl">Downloading…</div>` : ""}
    </div>
  `;
}

function setCardCover(card, url) {
  const thumb = card.querySelector(".pdf-shelf-thumb");
  if (!thumb || thumb.querySelector("img")) return;
  const img = document.createElement("img");
  img.alt = "";
  img.src = url;
  thumb.insertBefore(img, thumb.firstChild);
  thumb.querySelector(".pdf-shelf-ph")?.remove();
}

/** Fill in covers one card at a time — cached covers land instantly,
 *  missing ones are rendered from the local binary (backfill for PDFs
 *  saved before covers shipped). Bails when a newer render supersedes
 *  this pass. */
async function hydrateCovers(token) {
  const cards = Array.from(_host.querySelectorAll(".pdf-shelf-card"));
  for (const card of cards) {
    if (token !== _renderToken) return;
    const fid = card.dataset.fileId;
    if (!fid) continue;
    let url = await loadPdfCoverUrl(fid);
    if (!url && isPdfDownloaded(fid)) url = await ensurePdfCover(fid);
    if (token !== _renderToken) return;
    if (url) setCardCover(card, url);
  }
}
