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
import { enforceFlaggedPdfOrder } from "../state/state-pdf-aliases.js";
import { getCachedAnnotations } from "../zotero-annotations.js";
import { parseAnnotationPosition } from "./pdf-viewer-annotations.js";
import { loadPdfCoverUrl, refreshPdfCoverIfStale } from "./pdf-covers.js";
import { BOOKMARK_ICON, openBookmarkListPopup } from "./pdf-bookmarks.js";

const PLACEHOLDER_SVG = `<svg viewBox="0 0 16 16" class="pdf-shelf-ph"><rect x="3" y="1" width="10" height="14" rx="1" fill="none"/><line x1="5" y1="8" x2="11" y2="8"/></svg>`;
// Same flag glyph the Recent Files rows use.
const FLAG_ICON = `<svg viewBox="0 0 16 16"><path d="M3 13V2.5l5 1.5 5-1.5V11l-5 1.5L3 11z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/></svg>`;

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
// Search query + card data of the last render. The header (including the
// search input) is built once per render() and only the body below it
// re-renders on each keystroke, so the input keeps focus while typing.
let _query = "";
let _lastCards = [];
// fileId → array of { text, comment, pageLabel, jumpPage } annotation
// entries (original case), built lazily from the local Zotero cache the
// first time a search needs it. Original case so match text can be shown
// + highlighted in the search-results view; jumpPage is the 1-based PDF
// page for click-to-navigate.
const _annotIndex = new Map();
const _annotPending = new Set();

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
    // Both the grid card and the search-view result card carry
    // .pdf-shelf-thumb keyed on the fileId, so swap the cover in every
    // instance that's currently mounted.
    _host.querySelectorAll(`.pdf-shelf-card[data-file-id="${CSS.escape(fileId)}"]`).forEach((card) => {
      loadPdfCoverUrl(fileId).then((url) => { if (url) setCardCover(card, url, { replace: true }); });
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !_containerId) return;
    e.preventDefault();
    e.stopPropagation();
    // Esc in the search field clears the query first; then an active
    // card selection; then closes the shelf.
    const searchEl = _host.querySelector(".pdf-shelf-search");
    if (searchEl && document.activeElement === searchEl && _query) {
      _query = "";
      searchEl.value = "";
      renderBody(); // back to the thumbnail grid
      return;
    }
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
  _query = "";
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

/** Sort a card list per the active mode — flagged cards float above the
 *  rest, each group sorted the same way. Titles/authors ascend; dates
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
  return [...arr.filter((c) => c.flagged), ...arr.filter((c) => !c.flagged)];
}

function render() {
  const ctx = shelfContext();
  if (!ctx) { closePdfShelf(); return; }
  const { scopeName, pdfs } = ctx;

  const cards = sortCards(pdfs.map((node) => {
    const meta = getPdfMeta(node.fileId);
    return {
      fileId: node.fileId,
      nodeId: node.id,
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
      flagged: !!(node.flagged || node.pinned),
      zoteroAttKey: node.zoteroAttKey || meta?.zoteroAttKey || "",
    };
  }));
  _lastCards = cards;
  _displayIds = cards.map((c) => c.fileId);
  // Prune selection entries that left the folder since the last paint.
  for (const id of [..._selected]) if (!_displayIds.includes(id)) _selected.delete(id);

  // Header is stable across keystrokes; only the body below it re-renders
  // on search input, so the search field keeps focus while typing.
  _host.innerHTML = `
    <div class="pdf-shelf-inner">
      <header class="pdf-shelf-header">
        <div class="pdf-shelf-title">
          <span class="pdf-shelf-scope">${escHtml(scopeName)}</span>
          <input type="text" class="pdf-shelf-search" placeholder="Search bookmarks &amp; annotations…" value="${escHtml(_query)}" />
        </div>
        <div class="pdf-shelf-actions">
          <span class="pdf-shelf-count"></span>
          <select class="pdf-shelf-sort" title="Sort PDFs">
            ${SORT_OPTIONS.map((o) => `<option value="${o.key}"${o.key === _sortMode ? " selected" : ""}>${o.label}</option>`).join("")}
          </select>
          ${_selected.size >= 2 ? `<button type="button" class="pdf-shelf-btn" data-shelf-stack>Create Stack from Selected</button>` : ""}
          <button type="button" class="pdf-shelf-btn" data-shelf-close>Close</button>
        </div>
      </header>
      <div class="pdf-shelf-body"></div>
    </div>
  `;

  _host.querySelector("[data-shelf-close]")?.addEventListener("click", () => closePdfShelf());
  _host.querySelector("[data-shelf-stack]")?.addEventListener("click", () => createStackFromSelected(cards));
  const sortSel = _host.querySelector(".pdf-shelf-sort");
  sortSel?.addEventListener("change", () => { _sortMode = sortSel.value; render(); });

  // Search re-renders just the body (grid ⇄ results), so the input keeps
  // focus while typing. Annotation text indexes lazily on first use.
  const searchEl = _host.querySelector(".pdf-shelf-search");
  let searchTimer = null;
  searchEl?.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      _query = searchEl.value.trim().toLowerCase();
      if (_query) ensureAnnotIndex(_lastCards);
      renderBody();
    }, 150);
  });

  renderBody();
}

/** Render the body under the header — the thumbnail grid when the search
 *  field is empty, or a match-list results view while a query is active.
 *  Called on every keystroke; the header (and its input) stays put. */
function renderBody() {
  const body = _host.querySelector(".pdf-shelf-body");
  if (!body) return;
  const token = ++_renderToken;
  const cards = _lastCards;

  if (_query) renderSearchResults(body, cards);
  else renderGrid(body, cards);

  updateCount(cards);
  hydrateCovers(token);
}

function updateCount(cards) {
  const count = _host.querySelector(".pdf-shelf-count");
  if (!count) return;
  if (_query) {
    const n = cards.filter((c) => cardSearchHits(c, _query).match).length;
    count.textContent = `${n} of ${cards.length} PDF${cards.length === 1 ? "" : "s"}`;
  } else {
    count.textContent = `${cards.length} PDF${cards.length === 1 ? "" : "s"}`;
  }
}

/** The default thumbnail grid. */
function renderGrid(body, cards) {
  body.className = "pdf-shelf-body";
  body.innerHTML = cards.length
    ? `<div class="pdf-shelf-grid">${cards.map((c) => cardHtml(c)).join("")}</div>`
    : `<div class="pdf-shelf-empty">No PDFs here yet.</div>`;

  body.querySelectorAll(".pdf-shelf-card").forEach((card) => {
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
    const flagBtn = card.querySelector(".pdf-shelf-flag-btn");
    if (flagBtn) {
      flagBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFlag(flagBtn.dataset.nodeId);
      });
    }
  });
}

/** Search-results view: one row per matching PDF — the shelf card
 *  (thumbnail + metadata) on the left, the list of matches inside that
 *  PDF (bookmark names + annotation text, term highlighted) on the
 *  right. Clicking a bookmark match jumps the PDF to that page; any
 *  other click opens the PDF. */
function renderSearchResults(body, cards) {
  body.className = "pdf-shelf-body pdf-shelf-search-mode";
  const matched = cards
    .map((c) => ({ card: c, matches: collectMatches(c, _query) }))
    .filter((r) => r.matches.length > 0);

  if (!matched.length) {
    body.innerHTML = `<div class="pdf-shelf-empty">No matches for “${escHtml(_query)}”.</div>`;
    return;
  }

  body.innerHTML = `<div class="pdf-shelf-results">${matched.map(({ card: c, matches }) => `
    <div class="pdf-shelf-result">
      <div class="pdf-shelf-card pdf-shelf-result-card${c.pending ? " pdf-shelf-pending" : ""}${c.flagged ? " pdf-shelf-flagged" : ""}" data-file-id="${escHtml(c.fileId)}">
        <div class="pdf-shelf-thumb">${PLACEHOLDER_SVG}</div>
        <div class="pdf-shelf-card-title">${highlightHtml(c.title, _query)}</div>
        ${[c.year, c.authors].filter(Boolean).length ? `<div class="pdf-shelf-card-sub">${highlightHtml([c.year, c.authors].filter(Boolean).join(" — "), _query)}</div>` : ""}
      </div>
      <div class="pdf-shelf-result-matches">
        ${matches.map((m) => `
          <div class="pdf-shelf-match-row" data-page="${m.jumpPage || 0}" data-bm-id="${escHtml(m.bmId || "")}">
            <span class="pdf-shelf-match-kind">${escHtml(m.kindLabel)}</span>
            <span class="pdf-shelf-match-text">${highlightHtml(m.text, _query)}</span>
            ${m.pageLabel ? `<span class="pdf-shelf-match-page">p. ${escHtml(String(m.pageLabel))}</span>` : ""}
          </div>
        `).join("")}
      </div>
    </div>
  `).join("")}</div>`;

  body.querySelectorAll(".pdf-shelf-result").forEach((result) => {
    const fid = result.querySelector(".pdf-shelf-card")?.dataset.fileId;
    if (!fid) return;
    const open = () => { if (isPdfDownloaded(fid)) _state.openPdf(fid); };
    result.querySelector(".pdf-shelf-result-card")?.addEventListener("click", open);
    result.querySelectorAll(".pdf-shelf-match-row").forEach((row) => {
      row.addEventListener("click", async () => {
        const bmId = row.dataset.bmId;
        const page = parseInt(row.dataset.page, 10) || 0;
        if (bmId) {
          const { openPdfAtBookmark } = await import("./pdf-bookmarks.js");
          openPdfAtBookmark(fid, bmId, page);
        } else if (page && isPdfDownloaded(fid)) {
          const { requestPdfJump } = await import("./pdf-bridge.js");
          requestPdfJump(fid, page);
          _state.openPdf(fid);
        } else {
          open();
        }
      });
    });
  });
}

/** Flag/unflag within this shelf's folder — the flag lives on the tree
 *  node (desk node or project alias), so flags are per-context and the
 *  PDF also rises to the top of its PDFs folder in the sidebar (plus
 *  the sidebar's Flagged section, like any other flagged file). */
function toggleFlag(nodeId) {
  const node = nodeId ? findNode(_state.fileTree, nodeId) : null;
  if (!node) return;
  node.flagged = !(node.flagged || node.pinned);
  delete node.pinned; // legacy marker from the feature's first vocabulary
  enforceFlaggedPdfOrder(_state.fileTree);
  _state.saveFileTree(); // emits files-changed → shelf re-renders
}

/** Build the lazy annotation index for cards that have a Zotero
 *  attachment — local cache only, never the network. Stores original
 *  case (so match text can be shown + highlighted) and re-renders the
 *  results view when new text lands (if a query is still active). */
function ensureAnnotIndex(cards) {
  for (const c of cards) {
    if (!c.zoteroAttKey || _annotIndex.has(c.fileId) || _annotPending.has(c.fileId)) continue;
    _annotPending.add(c.fileId);
    getCachedAnnotations(c.zoteroAttKey).then((annots) => {
      _annotIndex.set(c.fileId, annots.map((a) => {
        // pageIndex (0-based, from the position payload) is the reliable
        // PDF page to jump to; pageLabel is the printed label to show.
        const pos = parseAnnotationPosition(a);
        const idx = pos && typeof pos.pageIndex === "number" ? pos.pageIndex : -1;
        return {
          text: a.text || "",
          comment: a.comment || "",
          pageLabel: a.pageLabel || "",
          jumpPage: idx >= 0 ? idx + 1 : 0,
        };
      }));
    }).catch(() => {
      _annotIndex.set(c.fileId, []);
    }).finally(() => {
      _annotPending.delete(c.fileId);
      if (_query && _containerId) renderBody();
    });
  }
}

/** Does this card match the query at all (title/author/year, a bookmark
 *  name, or annotation text/comment)? */
function cardSearchHits(c, q) {
  return { match: collectMatches(c, q).length > 0 };
}

/** Every match inside a PDF for the query, in display order: title /
 *  author / year, then bookmark names (page-linked), then annotation
 *  text + comments. Each entry carries a `kindLabel`, the source `text`
 *  (original case, for term highlighting), an optional `pageLabel` to
 *  show, and — where the match is navigable — a `jumpPage` / `bmId`. */
function collectMatches(c, q) {
  const out = [];
  const hit = (s) => s && s.toLowerCase().includes(q);

  if (hit(c.title)) out.push({ kindLabel: "Title", text: c.title });
  if (hit(c.authors)) out.push({ kindLabel: "Author", text: c.authors });
  if (hit(String(c.year))) out.push({ kindLabel: "Year", text: String(c.year) });

  for (const bm of getPdfBookmarks(c.fileId)) {
    if (hit(bm.name)) {
      out.push({ kindLabel: "Bookmark", text: bm.name, pageLabel: bm.page, jumpPage: bm.page, bmId: bm.id });
    }
  }

  for (const a of _annotIndex.get(c.fileId) || []) {
    const pageLabel = a.pageLabel || (a.jumpPage ? String(a.jumpPage) : "");
    if (hit(a.text)) out.push({ kindLabel: "Highlight", text: a.text, pageLabel, jumpPage: a.jumpPage });
    if (hit(a.comment)) out.push({ kindLabel: "Note", text: a.comment, pageLabel, jumpPage: a.jumpPage });
  }
  return out;
}

/** Escape `text` and wrap each case-insensitive occurrence of `q` in a
 *  `<mark>`. Returns an HTML string. */
function highlightHtml(text, q) {
  if (!q) return escHtml(text);
  const lower = (text || "").toLowerCase();
  let out = "";
  let last = 0;
  let idx = lower.indexOf(q);
  while (idx !== -1) {
    out += escHtml(text.slice(last, idx));
    out += `<mark class="pdf-shelf-hl">${escHtml(text.slice(idx, idx + q.length))}</mark>`;
    last = idx + q.length;
    idx = lower.indexOf(q, last);
  }
  out += escHtml(text.slice(last));
  return out;
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
  // A project shelf files its stack inside the owning project; the desk
  // shelf keeps the default (the desk's Inbox).
  const ctx = shelfContext();
  const parentId = ctx?.node?.pdfFolder
    ? findParentOfNode(_state.fileTree, ctx.node.id)?.id || null
    : null;
  showPromptModal({
    title: "New stack",
    label: "Name",
    placeholder: "New Stack",
    initialValue: "New Stack",
    confirmLabel: "Create",
    onConfirm: async (name) => {
      closePdfShelf();
      const result = await _state.createStack(name, parentId, { openImmediately: true });
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
    c.flagged ? "pdf-shelf-flagged" : "",
  ].filter(Boolean).join(" ");
  return `
    <div class="${cls}" data-file-id="${escHtml(c.fileId)}">
      <div class="pdf-shelf-thumb">
        ${PLACEHOLDER_SVG}
        <button type="button" class="pdf-shelf-flag-btn" data-node-id="${escHtml(c.nodeId)}" title="${c.flagged ? "Unflag" : "Flag"}">${FLAG_ICON}</button>
        ${c.bookmarks ? `<button type="button" class="pdf-shelf-bm-badge" title="Bookmarks (${c.bookmarks})">${BOOKMARK_ICON}</button>` : ""}
      </div>
      <div class="pdf-shelf-card-title">${escHtml(c.title)}</div>
      ${sub ? `<div class="pdf-shelf-card-sub">${escHtml(sub)}</div>` : ""}
      ${c.pending ? `<div class="pdf-shelf-card-sub pdf-shelf-dl">Downloading…</div>` : ""}
    </div>
  `;
}

function setCardCover(card, url, opts = {}) {
  const thumb = card.querySelector(".pdf-shelf-thumb");
  if (!thumb) return;
  const existing = thumb.querySelector("img");
  if (existing) {
    if (opts.replace && existing.src !== url) existing.src = url;
    return;
  }
  const img = document.createElement("img");
  img.alt = "";
  img.src = url;
  thumb.insertBefore(img, thumb.firstChild);
  thumb.querySelector(".pdf-shelf-ph")?.remove();
}

// fileIds whose cover has been checked against the cached annotations
// this session — the staleness probe reads the annotation cache from
// disk, so it runs once per PDF, not on every shelf repaint.
const _coverChecked = new Set();

/** Fill in covers one card at a time — cached covers land instantly,
 *  missing ones are rendered from the local binary (backfill for PDFs
 *  saved before covers shipped), and covers whose baked-in annotation
 *  marks fell behind the cache are re-rendered. Bails when a newer
 *  render supersedes this pass. */
async function hydrateCovers(token) {
  const cards = Array.from(_host.querySelectorAll(".pdf-shelf-card"));
  for (const card of cards) {
    if (token !== _renderToken) return;
    const fid = card.dataset.fileId;
    if (!fid) continue;
    let url = await loadPdfCoverUrl(fid);
    const replace = !_coverChecked.has(fid) && isPdfDownloaded(fid);
    if (replace) {
      _coverChecked.add(fid);
      url = (await refreshPdfCoverIfStale(fid)).url || url;
    }
    if (token !== _renderToken) return;
    if (url) setCardCover(card, url, { replace });
  }
}
