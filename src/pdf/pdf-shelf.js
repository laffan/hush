/**
 * PDF Shelf — a full-editor-pane gallery of the PDFs in a PDFs folder,
 * opened from the folder's row menu ("View Shelf"). Works for both the
 * desk's PDFs folder and a project's own PDFs folder (aliases); the
 * cards are identical since both resolve through the shared registry.
 *
 * Follows the multi-select view's takeover pattern: a single host
 * mounted into #app, toggled via the `pdf-shelf-active` body class so
 * the editor / notebook / PDF / stack surfaces keep their layout
 * underneath and closing is a class flip, not a remount.
 *
 * Each card shows the PDF's first-page cover (per-device cache — see
 * pdf-covers.js) with title, year and authors underneath. PDFs saved
 * before covers shipped are backfilled lazily while the shelf is open.
 */

import { findNode, findParentOfNode } from "../state/tree-helpers.js";
import { escHtml } from "../sidebar/files-panel-shared.js";
import { getPdfMeta, isPdfDownloaded } from "../sync/pdf-sync.js";
import { loadPdfCoverUrl, ensurePdfCover } from "./pdf-covers.js";

const PLACEHOLDER_SVG = `<svg viewBox="0 0 16 16" class="pdf-shelf-ph"><rect x="3" y="1" width="10" height="14" rx="1" fill="none"/><line x1="5" y1="8" x2="11" y2="8"/></svg>`;

let _host = null;
let _state = null;
let _containerId = null;
let _renderToken = 0;

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
  // starts while the shelf is up.
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
    closePdfShelf();
  }, true);
}

/** Open the shelf for a PDFs folder node (the desk special or a
 *  project's `pdfFolder`). */
export function openPdfShelf(state, containerId) {
  if (!_host) initPdfShelf(state);
  _state = state;
  if (state.selectedDocIds?.length) state.clearSelectedDocs();
  _containerId = containerId;
  document.body.classList.add("pdf-shelf-active");
  _host.classList.remove("hidden");
  render();
}

export function closePdfShelf() {
  if (!_containerId) return;
  _containerId = null;
  _renderToken++;
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

function render() {
  const ctx = shelfContext();
  if (!ctx) { closePdfShelf(); return; }
  const token = ++_renderToken;
  const { scopeName, pdfs } = ctx;

  _host.innerHTML = `
    <div class="pdf-shelf-inner">
      <header class="pdf-shelf-header">
        <div class="pdf-shelf-title">PDF Shelf<span class="pdf-shelf-scope">${escHtml(scopeName)}</span></div>
        <div class="pdf-shelf-actions">
          <span class="pdf-shelf-count">${pdfs.length} PDF${pdfs.length === 1 ? "" : "s"}</span>
          <button type="button" class="pdf-shelf-btn" data-shelf-close>Close</button>
        </div>
      </header>
      ${pdfs.length ? `<div class="pdf-shelf-grid">
        ${pdfs.map((p) => cardHtml(p)).join("")}
      </div>` : `<div class="pdf-shelf-empty">No PDFs here yet.</div>`}
    </div>
  `;

  _host.querySelector("[data-shelf-close]")?.addEventListener("click", () => closePdfShelf());
  _host.querySelectorAll(".pdf-shelf-card").forEach((card) => {
    card.addEventListener("click", () => {
      const fid = card.dataset.fileId;
      // Pending downloads stay a no-op, matching the sidebar rows.
      if (fid && isPdfDownloaded(fid)) _state.openPdf(fid);
    });
  });

  hydrateCovers(token);
}

function cardHtml(node) {
  const meta = getPdfMeta(node.fileId);
  const title = meta?.title || node.name || "Untitled";
  const sub = [meta?.year, meta?.authors].filter(Boolean).join(" — ");
  const pending = !isPdfDownloaded(node.fileId);
  return `
    <div class="pdf-shelf-card${pending ? " pdf-shelf-pending" : ""}" data-file-id="${escHtml(node.fileId)}">
      <div class="pdf-shelf-thumb">${PLACEHOLDER_SVG}</div>
      <div class="pdf-shelf-card-title">${escHtml(title)}</div>
      ${sub ? `<div class="pdf-shelf-card-sub">${escHtml(sub)}</div>` : ""}
      ${pending ? `<div class="pdf-shelf-card-sub pdf-shelf-dl">Downloading…</div>` : ""}
    </div>
  `;
}

function setCardCover(card, url) {
  const thumb = card.querySelector(".pdf-shelf-thumb");
  if (!thumb || thumb.querySelector("img")) return;
  const img = document.createElement("img");
  img.alt = "";
  img.src = url;
  thumb.replaceChildren(img);
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
