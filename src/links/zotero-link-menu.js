/**
 * Zotero link menu — the tooltip menu behind Cmd+click on a
 * `[Title](zotero://…)` link in a doc or notebook text shape.
 *
 * Now that PDFs open inside Hush, a Zotero deep link has two sensible
 * destinations, so the click no longer jumps straight to the Zotero
 * app. Instead a small menu opens at the click point:
 *
 *   - "Open in Zotero"  — the old behaviour (OS opener).
 *   - "Open in Hush"    — when the link's item resolves to a PDF that's
 *     already in the desk's collection (the PDF registry), opens it in
 *     the main viewer, honouring the link's `?page=` anchor.
 *   - "Download to Hush" — when the reference has a PDF attachment that
 *     isn't in Hush yet: registers a placeholder, downloads in the
 *     background (same pipeline as Zotero: Save PDF), and opens the
 *     PDF the moment the binary lands.
 *
 * Notebook text shapes route here through `window.__hushOpenZoteroLink`
 * (registered by initZoteroLinkMenu) so the canvas module stays free of
 * app imports — the same pattern as wikilinks and PDF bookmarks.
 */

import { findNode, findNodeByFileId, nearestAncestorProjectId } from "../state/tree-helpers.js";
import { addPdfAliasToProject } from "../state/state-pdf-aliases.js";

const OPEN_ICON = `<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5H2v7.5h7.5V7"/><path d="M7 1.5h3.5V5"/><path d="M10.5 1.5 5.5 6.5"/></svg>`;

let _state = null;
let _menuEl = null;
let _menuCleanup = null;

/** Whether a cached Zotero attachment looks like a PDF. Prefers the
 *  fetch-time `isPdf` flag but falls back to content type / filename /
 *  title so existing caches (built before PDF detection was broadened)
 *  still surface "Download to Hush" without a re-fetch — "Full Text PDF"
 *  and `*.pdf` titles being the common shapes. */
function attachmentIsPdf(a) {
  if (!a) return false;
  if (a.isPdf) return true;
  if ((a.contentType || "").toLowerCase().includes("pdf")) return true;
  const name = `${a.filename || ""} ${a.title || ""}`.toLowerCase();
  return /\.pdf(\b|$)/.test(name) || /\bpdf\b/.test(name);
}

/** The project (id) that owns the doc / notebook the link was clicked in,
 *  or null when it's a standalone file. A project open in the editor is
 *  the direct context; otherwise walk up from the active doc / notebook
 *  to its nearest ancestor project. */
function projectContextId() {
  if (!_state) return null;
  if (_state.currentProjectId) return _state.currentProjectId;
  const fileId = _state.currentNotebookFileId || _state.currentFileId;
  if (!fileId) return null;
  const node = findNodeByFileId(_state.fileTree, fileId);
  return node ? nearestAncestorProjectId(_state.fileTree, node.id) : null;
}

/** Alias a just-downloaded desk PDF into `projectId`'s PDFs folder, so a
 *  PDF pulled in from a link inside a project lands in that project too
 *  (deduped by fileId; a no-op when it's already there). */
async function aliasPdfIntoProject(fileId, projectId) {
  if (!fileId || !projectId || !_state) return;
  const project = findNode(_state.fileTree, projectId);
  const pdfNode = findNodeByFileId(_state.fileTree, fileId);
  if (!project || !pdfNode) return;
  if (addPdfAliasToProject(project, pdfNode)) await _state.saveFileTree();
}

export function isZoteroLinkUrl(url) {
  return typeof url === "string" && url.startsWith("zotero://");
}

/** Parse a Zotero deep link into its item key + optional page anchor.
 *  Handles the two shapes Hush inserts: `zotero://select/library/items/KEY`
 *  and `zotero://open-pdf/library/items/KEY?page=N`. */
export function parseZoteroUrl(url) {
  const m = /^zotero:\/\/(open-pdf|select)\/library\/items\/([A-Za-z0-9]+)(?:\?page=(\d+))?/.exec(
    (url || "").trim(),
  );
  if (!m) return null;
  return { kind: m[1], key: m[2], page: m[3] ? parseInt(m[3], 10) : 0 };
}

export function initZoteroLinkMenu(state) {
  _state = state;
  window.__hushOpenZoteroLink = (url, anchor) => { openZoteroLinkMenu(url, anchor); };
}

// ── Popup plumbing ──────────────────────────────────────────────────

export function closeZoteroLinkMenu() {
  if (_menuCleanup) { _menuCleanup(); _menuCleanup = null; }
  if (_menuEl) { _menuEl.remove(); _menuEl = null; }
}

/** `anchor` is either `{ x, y }` viewport coords (raw-text clicks) or
 *  an element / rect-carrying object (rendered link widgets). */
function anchorRect(anchor) {
  if (!anchor) return { left: 20, top: 20, bottom: 20 };
  if (typeof anchor.getBoundingClientRect === "function") {
    const r = anchor.getBoundingClientRect();
    return { left: r.left, top: r.top, bottom: r.bottom };
  }
  if (typeof anchor.x === "number") {
    return { left: anchor.x, top: anchor.y, bottom: anchor.y + 4 };
  }
  return { left: anchor.left || 20, top: anchor.top || 20, bottom: anchor.bottom || 24 };
}

function mountMenu(el, anchor) {
  closeZoteroLinkMenu();
  _menuEl = el;
  document.body.appendChild(el);
  positionMenu(el, anchor);

  // Dismiss on `pointerdown`, not `mousedown`. The menu is opened
  // mid-gesture — from a link tap's `mousedown` (docs) or `pointerdown`
  // (notebook canvas) — and on iPad the *same tap's* synthetic
  // `mousedown` is delivered after `touchend`, well past the frame that
  // arms this listener, so a `mousedown` dismiss fires on the opening
  // tap and closes the menu instantly (works on Mac, where the synthetic
  // mousedown fires synchronously before the rAF). `pointerdown` is the
  // gesture's very first event and isn't delayed/synthesized on touch,
  // so the opening tap's pointerdown has already fired before the rAF
  // arms this — only a *subsequent* tap dismisses.
  const onDown = (e) => { if (_menuEl && !_menuEl.contains(e.target)) closeZoteroLinkMenu(); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeZoteroLinkMenu(); }
  };
  requestAnimationFrame(() => {
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  });
  _menuCleanup = () => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  };
}

function positionMenu(el, anchor) {
  const r = anchorRect(anchor);
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  let left = Math.min(r.left, window.innerWidth - w - 8);
  if (left < 8) left = 8;
  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
}

// ── Actions ─────────────────────────────────────────────────────────

async function openInZotero(url) {
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.openUrl(url);
  } catch {
    window.open(url, "_blank");
  }
}

/** Open a Hush PDF at an optional page — mirrors openPdfAtBookmark:
 *  in-place jump when the PDF is already the main surface, otherwise
 *  the jump registers with the bridge and runs inside the mount. */
async function openPdfInHush(fileId, page) {
  if (!_state) return;
  const { getPdfInstance, requestPdfJump } = await import("../pdf/pdf-bridge.js");
  if (_state.currentPdfFileId === fileId && getPdfInstance()) {
    if (page > 0) getPdfInstance().goToPage(page);
    return;
  }
  if (page > 0) requestPdfJump(fileId, page);
  await _state.openPdf(fileId);
}

/** Look up the Hush PDF registry entry for a Zotero item/attachment key
 *  (either side of the link may have been inserted). */
function findRegistryEntry(registry, key, ref) {
  for (const [fileId, meta] of Object.entries(registry)) {
    if (meta.zoteroAttKey === key || meta.zoteroItemKey === key) return { fileId, meta };
    if (ref && meta.zoteroItemKey && meta.zoteroItemKey === ref.key) return { fileId, meta };
  }
  return null;
}

function sanitizeFilename(s) {
  return (s || "PDF")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60) || "PDF";
}

// ── Menu ────────────────────────────────────────────────────────────

function makeRow(label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "zotero-link-menu-row";
  btn.innerHTML = `<span class="zotero-link-menu-label"></span>`;
  btn.querySelector(".zotero-link-menu-label").textContent = label;
  if (onClick) btn.addEventListener("click", onClick);
  else btn.disabled = true;
  return btn;
}

function makeSpinner() {
  const s = document.createElement("span");
  s.className = "citation-card-spinner";
  return s;
}

/**
 * Open the tooltip menu for a `zotero://` link. Always offers "Open in
 * Zotero"; the Hush row fills in asynchronously once the link resolves
 * against the PDF registry / reference cache.
 */
export async function openZoteroLinkMenu(url, anchor) {
  const parsed = parseZoteroUrl(url);
  const el = document.createElement("div");
  el.className = "zotero-link-menu";

  const zRow = makeRow("Open in Zotero", () => {
    closeZoteroLinkMenu();
    void openInZotero(url);
  });
  zRow.appendChild(document.createRange().createContextualFragment(OPEN_ICON));
  el.appendChild(zRow);

  mountMenu(el, anchor);
  try { (await import("../debug/link-debug.js")).dumpMenu("menu MOUNTED", el); } catch {} // TEMP
  if (!parsed || !_state) return;

  // ── Hush row (async resolve) ──────────────────────────────────────
  let pdfSync = null;
  let ref = null;
  try {
    pdfSync = await import("../sync/pdf-sync.js");
    const { loadReferences } = await import("../zotero.js");
    const refs = (await loadReferences()) || [];
    ref = refs.find(
      (r) => r.key === parsed.key || (r.attachments || []).some((a) => a.key === parsed.key),
    ) || null;
  } catch { /* Zotero not configured — the menu stays Zotero-only */ }
  if (_menuEl !== el || !pdfSync) return;

  const pdfAtt = ref?.attachments?.find(attachmentIsPdf) || null;
  // Capture the project context now, at open time — the download may
  // outlive the click, and the active file could change before it lands.
  const projectId = projectContextId();

  const slot = document.createElement("div");
  el.appendChild(slot);
  positionMenu(el, anchor);

  function renderHushRow() {
    slot.innerHTML = "";
    const entry = findRegistryEntry(pdfSync.getPdfRegistry(), parsed.key, ref);

    if (entry && pdfSync.isPdfDownloaded(entry.fileId)) {
      slot.appendChild(makeRow("Open in Hush", () => {
        closeZoteroLinkMenu();
        void openPdfInHush(entry.fileId, parsed.page);
      }));
      return;
    }

    if (entry) {
      // Placeholder registered — a download is (or was) in flight.
      const inFlight = pdfSync.getPdfDownloadProgress(entry.fileId) !== null;
      if (!inFlight) {
        slot.appendChild(makeRow("Download failed — retry", () => {
          pdfSync.triggerBackgroundDownload(entry.fileId, _state);
          watchDownload(pdfSync, entry.fileId, parsed.page, el, renderHushRow, projectId);
          renderHushRow();
        }));
        return;
      }
      const row = makeRow("Downloading…", null);
      row.prepend(makeSpinner());
      slot.appendChild(row);
      watchDownload(pdfSync, entry.fileId, parsed.page, el, renderHushRow, projectId);
      return;
    }

    if (ref && pdfAtt && _state.registerPdfPlaceholder) {
      slot.appendChild(makeRow("Download to Hush", async () => {
        try {
          const baseName = sanitizeFilename(ref.shortTitle || ref.title || "PDF");
          const result = await _state.registerPdfPlaceholder(baseName, {
            zoteroAttKey: pdfAtt.key,
            zoteroItemKey: ref.key,
            zoteroTitle: ref.title || "Untitled",
            zoteroAuthors: ref.authors || "",
            zoteroFirstAuthor: ref.firstAuthor || "",
            zoteroYear: ref.year || "",
            zoteroCitekey: ref.citekey || "",
          });
          if (result) {
            pdfSync.startBatchDownload([result.fileId], _state);
            // Alias into the project right away (shows pending there,
            // mirroring the desk entry) so it survives a superseded watch
            // or an app quit mid-download; watchDownload re-aliases on
            // completion (dedup-safe) for the already-in-flight paths.
            void aliasPdfIntoProject(result.fileId, projectId);
            watchDownload(pdfSync, result.fileId, parsed.page, el, renderHushRow, projectId);
          }
        } catch (err) {
          console.error("Download to Hush failed:", err);
        }
        renderHushRow();
      }));
    }
  }

  renderHushRow();
  positionMenu(el, anchor);
}

// One download watch at a time — a second watched link supersedes the
// first (its download keeps running; only the auto-open is dropped).
let _watchUnsub = null;

/** Watch a background download kicked off (or observed) from the menu.
 *  When the binary lands the PDF opens at the link's page — that's the
 *  second half of "Download to Hush" — whether or not the menu is
 *  still showing. When the link lived inside a project, the PDF is also
 *  aliased into that project on completion. A failed download stops the
 *  watch (the open menu repaints to the retry row). */
function watchDownload(pdfSync, fileId, page, menuEl, repaint, projectId) {
  if (!_state?.on) return;
  _watchUnsub?.();
  const handler = () => {
    if (pdfSync.isPdfDownloaded(fileId)) {
      _watchUnsub?.();
      void aliasPdfIntoProject(fileId, projectId);
      if (_menuEl === menuEl) closeZoteroLinkMenu();
      void openPdfInHush(fileId, page);
      return;
    }
    const failed = pdfSync.getPdfDownloadProgress(fileId) === null;
    if (failed) _watchUnsub?.();
    if (_menuEl === menuEl) repaint();
  };
  _state.on("files-changed", handler);
  _watchUnsub = () => { _state.off?.("files-changed", handler); _watchUnsub = null; };
}
