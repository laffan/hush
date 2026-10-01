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
 *   - "Import PDF" — while the PDF isn't in Hush yet, a label over three
 *     icons, the three ways it can arrive:
 *       · download — when the reference has a PDF attachment: registers
 *         a placeholder, downloads in the background (same pipeline as
 *         Zotero: Save PDF), and opens the PDF the moment the binary
 *         lands; a spinner while it runs, a retry once it has failed;
 *       · clipboard / file — the offline ways in (pdf/pdf-manual-import
 *         .js): the PDF on the clipboard or one picked from disk, linked
 *         to the reference from the library cache on this device, or put
 *         behind a placeholder whose download is pending or failed.
 *         Offered beside every download state, since a download that
 *         can't reach Zotero only says so once it has failed.
 *
 * Notebook text shapes route here through `window.__hushOpenZoteroLink`
 * (registered by initZoteroLinkMenu) so the canvas module stays free of
 * app imports — the same pattern as wikilinks and PDF bookmarks.
 */

import { findNode, findNodeByFileId, nearestAncestorProjectId } from "../state/tree-helpers.js";
import { addPdfAliasToProject } from "../state/state-pdf-aliases.js";
// Static, not lazy: the file picker has to open inside the click that
// asked for it, and an `await import()` in between can outlast WebKit's
// user activation.
import { importFileIntoPdf, importPdfFileForReference, referencePdfMeta } from "../pdf/pdf-manual-import.js";

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

// Import strip glyphs — download (Zotero), clipboard, file on disk.
const IMPORT_ICONS = {
  download: `<svg viewBox="0 0 16 16"><path d="M8 2v8"/><path d="M4.5 6.5 8 10l3.5-3.5"/><path d="M2.5 11v2.5h11V11"/></svg>`,
  clipboard: `<svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="11.5" rx="1.5"/><path d="M6 3V2h4v1"/><path d="M5.5 7h5M5.5 9.5h5M5.5 12h3"/></svg>`,
  file: `<svg viewBox="0 0 16 16"><path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z"/><path d="M9.5 1.5V5H13"/><path d="M8 7v5"/><path d="M6 10l2 2 2-2"/></svg>`,
};

/** One button of the import strip. `spec` is `{ title, run?, busy? }`:
 *  no `run` leaves it disabled (the title says why), `busy` swaps the
 *  glyph for a spinner. */
function makeImportIcon(kind, spec) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `zotero-link-menu-icon zotero-link-menu-icon-${kind}`;
  btn.title = spec.title;
  btn.setAttribute("aria-label", spec.title);
  if (spec.busy) btn.appendChild(makeSpinner());
  else btn.innerHTML = IMPORT_ICONS[kind];
  if (spec.run) btn.addEventListener("click", spec.run);
  else btn.disabled = true;
  return btn;
}

/** "Import PDF" and, under it, the three ways a PDF can arrive: from
 *  Zotero, off the clipboard, from a file on disk. */
function makeImportBlock({ download, clipboard, file }) {
  const block = document.createElement("div");
  block.className = "zotero-link-menu-import";
  const label = document.createElement("div");
  label.className = "zotero-link-menu-import-label";
  label.textContent = "Import PDF";
  block.appendChild(label);
  const strip = document.createElement("div");
  strip.className = "zotero-link-menu-import-icons";
  strip.appendChild(makeImportIcon("download", download));
  strip.appendChild(makeImportIcon("clipboard", clipboard));
  strip.appendChild(makeImportIcon("file", file));
  block.appendChild(strip);
  return block;
}

/** A clipboard / file import action. `run(source)` resolves to the
 *  fileId the PDF went behind, or null (cancelled, or it failed and said
 *  so); it must reach the picker without awaiting anything first. */
function importAction(page, projectId, source, run) {
  return async () => {
    closeZoteroLinkMenu();
    const fileId = await run(source);
    if (!fileId) return;
    await aliasPdfIntoProject(fileId, projectId);
    void openPdfInHush(fileId, page);
  };
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
      // Placeholder registered — a download is (or was) in flight. Either
      // way the file can come from the clipboard or disk instead.
      const fill = (source) => importAction(parsed.page, projectId, source, async (src) =>
        ((await importFileIntoPdf(_state, entry.fileId, { source: src })) ? entry.fileId : null));
      const inFlight = pdfSync.getPdfDownloadProgress(entry.fileId) !== null;
      if (inFlight) watchDownload(pdfSync, entry.fileId, parsed.page, el, renderHushRow, projectId);
      slot.appendChild(makeImportBlock({
        download: inFlight
          ? { title: "Downloading\u2026", busy: true }
          : { title: "Download failed \u2014 retry", run: () => {
              pdfSync.triggerBackgroundDownload(entry.fileId, _state);
              watchDownload(pdfSync, entry.fileId, parsed.page, el, renderHushRow, projectId);
              renderHushRow();
            } },
        clipboard: { title: "Paste PDF from clipboard", run: fill("clipboard") },
        file: { title: "Import PDF file\u2026", run: fill("file") },
      }));
      return;
    }

    if (!_state.registerPdfPlaceholder) return;
    // Offline, a download can only fail: say so rather than start one.
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    let download;
    if (!ref || !pdfAtt) download = { title: "Zotero has no PDF for this item" };
    else if (offline) download = { title: "Download from Zotero \u2014 offline" };
    else download = { title: "Download from Zotero", run: async () => {
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
    } };

    // A new linked entry from the clipboard or a file on disk, described
    // by the cached reference — or, when the cache has never seen the
    // item, by the key the link carries (an `open-pdf` link names the
    // attachment).
    const meta = ref ? referencePdfMeta(ref, pdfAtt)
      : parsed.kind === "open-pdf" ? { zoteroAttKey: parsed.key } : { zoteroItemKey: parsed.key };
    const create = (source) => importAction(parsed.page, projectId, source, async (src) =>
      (await importPdfFileForReference(_state, meta, { source: src }))?.fileId || null);
    slot.appendChild(makeImportBlock({
      download,
      clipboard: { title: "Paste PDF from clipboard", run: create("clipboard") },
      file: { title: "Import PDF file\u2026", run: create("file") },
    }));
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
