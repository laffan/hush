/**
 * Doc export modal.
 *
 * Opens when the user presses Export with a document (or project) open.
 * Lets them choose Markdown (.md, same direct-write path the sidebar
 * used pre-modal) or PDF (rendered through Typst on the Rust side, see
 * `commands::pdf_export` and `typst_export/`).
 *
 * Layout: two columns. The left column carries the controls; the right
 * column shows a live preview of the document about to be exported. For
 * PDF the preview *is* the real render — the Typst pipeline runs as the
 * user tweaks options (debounced), and the resulting bytes are cached so
 * pressing Export reuses the already-rendered PDF instead of rendering a
 * second time. Markdown shows the joined buffer as text.
 *
 * PDF surface:
 *   - Document style is sourced from the backend's registered styles
 *     so adding a style only requires touching one Rust file.
 *   - Citations in the prose are always formatted (author-date) as long
 *     as Zotero is set up and the references resolve. The toggle below
 *     them — "Include bibliography" — only controls whether a sorted
 *     bibliography section is appended (and, when on, switches inline
 *     cites to the chosen CSL grammar).
 *
 * The visual shell reuses the notebook-export-modal CSS classes — the
 * styling is purely cosmetic and the visual language should match.
 */

import { findNode } from "../state/tree-helpers.js";
import { exportCurrentFile } from "./sidebar-export.js";
import { loadReferences } from "../zotero.js";
import { collectImageRefs } from "../state/state-images.js";
import { isIOS } from "../settings/settings-ui.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

const CITE_RE = /\[@([A-Za-z0-9_:.+-]+)\](?:\([^)\n]*\))?/;

// How many pages to rasterize into the preview pane. Keeps big docs from
// stalling the modal — a note appears when there are more.
const PREVIEW_MAX_PAGES = 12;

export async function openDocExportModal(state) {
  if (!state.editor) return () => {};

  // The current doc text — also doubles as the "is there anything to
  // export?" signal. An empty doc still exports fine, but it lets us
  // skip citation detection when there are no cites.
  let content = state.editor.getContent();
  if (state.currentProjectId) {
    content = content.replace(/\n---hush-separator---\n/g, "\n\n");
  }
  const name = deriveDocName(state, content);

  const hasZotero = !!(state.settings?.zoteroUserId && state.settings?.zoteroApiKey);
  const hasCitations = CITE_RE.test(content);

  const styles = await fetchStyles();
  const citationStyles = await fetchCitationStyles();

  // Desktop save dialogs surface a filename field already, so the
  // modal-level input only mounts on iOS — where the system share
  // sheet has nowhere for the user to override the export name.
  const showFilenameField = isIOS();

  // Remove any stale modal first — keeps the export button idempotent
  // even if the user clicks twice.
  document.querySelectorAll(".notebook-export-modal").forEach((el) => el.remove());
  document.querySelectorAll(".notebook-export-backdrop").forEach((el) => el.remove());

  const backdrop = document.createElement("div");
  backdrop.className = "notebook-export-backdrop";

  const modal = document.createElement("div");
  modal.className = "notebook-export-modal nxm-2col";

  const choices = {
    filename: name,
    format: "pdf",
    style: styles[0]?.id || "formal",
    lineSpacing: 1.5,
    // Whether to append a bibliography section. Inline citations are
    // formatted regardless (see renderPdfBytes / the Rust side).
    includeBibliography: hasZotero && hasCitations,
    citationStyle: citationStyles[0]?.id || "numbered",
    stripComments: true,
    stripFlags: true,
    includeTabs: true,
    commentNotes: true,
    numberHeadings: false,
    pageNumbers: true,
  };

  modal.innerHTML = `
    <div class="nxm-title">Export document</div>

    <div class="nxm-columns">
      <div class="nxm-left">
        ${showFilenameField ? `
        <div class="nxm-section">
          <div class="nxm-label">Filename</div>
          <input type="text" class="nxm-filename-input" value="${escAttr(name)}" />
        </div>
        ` : ""}

        <div class="nxm-section">
          <div class="nxm-label">Format</div>
          <div class="nxm-seg" data-group="format">
            <button data-value="md">Markdown</button>
            <button data-value="pdf" class="active">PDF</button>
          </div>
        </div>

        <div class="nxm-section" data-visible-when="format=pdf">
          <div class="nxm-label">Document style</div>
          <select class="nxm-style-select">
            ${styles.map((s) => `<option value="${escAttr(s.id)}">${escHtml(s.name)}</option>`).join("")}
          </select>
        </div>

        <div class="nxm-section" data-visible-when="format=pdf">
          <div class="nxm-label">Line spacing</div>
          <select class="nxm-spacing-select">
            <option value="1">1</option>
            <option value="1.5" selected>1.5</option>
            <option value="2">2</option>
          </select>
        </div>

        <div class="nxm-section" data-visible-when="format=pdf">
          <div class="nxm-label">Layout</div>
          <label class="nxm-checkbox-label">
            <input type="checkbox" data-choice="stripComments" checked />
            Strip comments
          </label>
          <label class="nxm-checkbox-label">
            <input type="checkbox" data-choice="stripFlags" checked />
            Strip flags
          </label>
          <label class="nxm-checkbox-label">
            <input type="checkbox" data-choice="includeTabs" checked />
            Include tabs
          </label>
          <label class="nxm-checkbox-label">
            <input type="checkbox" data-choice="commentNotes" checked />
            Comment margin notes
          </label>
          <label class="nxm-checkbox-label">
            <input type="checkbox" data-choice="numberHeadings" />
            Number headings (1, 1.1, 1.1.1)
          </label>
          <label class="nxm-checkbox-label">
            <input type="checkbox" data-choice="pageNumbers" checked />
            Page numbers
          </label>
        </div>

        <div class="nxm-section" data-visible-when="format=pdf" data-cite-row style="${hasZotero && hasCitations ? "" : "display:none"}">
          <label class="nxm-checkbox-label">
            <input type="checkbox" class="nxm-cite-toggle" ${choices.includeBibliography ? "checked" : ""} />
            Include bibliography
          </label>
          <div class="nxm-cite-style-row" style="${choices.includeBibliography ? "" : "display:none"}">
            <label class="nxm-inline-label">Bibliography style
              <select class="nxm-cite-style-select">
                ${citationStyles.map((s) => `<option value="${escAttr(s.id)}">${escHtml(s.name)}</option>`).join("")}
              </select>
            </label>
          </div>
        </div>
      </div>

      <div class="nxm-right">
        <div class="nxm-label">Preview</div>
        <div class="nxm-preview"></div>
      </div>
    </div>

    <div class="nxm-actions">
      <button class="nxm-cancel">Cancel</button>
      <button class="nxm-confirm">Export</button>
    </div>
  `;

  document.body.appendChild(backdrop);
  document.body.appendChild(modal);

  const previewEl = modal.querySelector(".nxm-preview");
  // Cache of the most recently rendered PDF so Export can reuse the bytes
  // the preview already produced instead of rendering twice.
  let lastRender = { key: null, bytes: null };
  let previewToken = 0;
  let previewTimer = null;

  const cleanup = () => {
    if (previewTimer) clearTimeout(previewTimer);
    backdrop.remove();
    modal.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") cleanup();
    if (e.key === "Enter" && !e.isComposing) {
      const active = document.activeElement;
      const inInput = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
      if (!inInput) { e.preventDefault(); void runExport(); }
    }
  };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", cleanup);

  // Anything that changes the *rendered* output re-runs the preview. The
  // filename doesn't, so its input deliberately skips this.
  function markChanged() {
    applyVisibility();
    schedulePreview();
  }

  modal.querySelectorAll(".nxm-seg").forEach((group) => {
    group.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-value]");
      if (!btn) return;
      const key = group.getAttribute("data-group");
      choices[key] = btn.dataset.value;
      group.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      markChanged();
    });
  });

  const filenameInput = modal.querySelector(".nxm-filename-input");
  if (filenameInput) {
    filenameInput.addEventListener("input", () => { choices.filename = filenameInput.value; });
  }

  const styleSelect = modal.querySelector(".nxm-style-select");
  styleSelect.addEventListener("change", () => { choices.style = styleSelect.value; markChanged(); });

  const spacingSelect = modal.querySelector(".nxm-spacing-select");
  spacingSelect.addEventListener("change", () => {
    const v = parseFloat(spacingSelect.value);
    choices.lineSpacing = Number.isFinite(v) ? v : 1.5;
    markChanged();
  });

  const citeToggle = modal.querySelector(".nxm-cite-toggle");
  const citeStyleRow = modal.querySelector(".nxm-cite-style-row");
  const citeStyleSelect = modal.querySelector(".nxm-cite-style-select");
  citeToggle.addEventListener("change", () => {
    choices.includeBibliography = citeToggle.checked;
    citeStyleRow.style.display = citeToggle.checked ? "" : "none";
    markChanged();
  });
  citeStyleSelect.addEventListener("change", () => { choices.citationStyle = citeStyleSelect.value; markChanged(); });

  // Generic checkbox wiring keyed by `data-choice`. Lets us add more
  // layout toggles in HTML without touching the JS plumbing.
  modal.querySelectorAll("input[data-choice]").forEach((cb) => {
    cb.addEventListener("change", () => {
      choices[cb.dataset.choice] = cb.checked;
      markChanged();
    });
  });

  modal.querySelector(".nxm-cancel").addEventListener("click", cleanup);
  modal.querySelector(".nxm-confirm").addEventListener("click", () => { void runExport(); });

  applyVisibility();
  // Kick off the first preview now that the layout has a measurable width.
  requestAnimationFrame(() => { void renderPreview(); });

  function applyVisibility() {
    for (const el of modal.querySelectorAll("[data-visible-when]")) {
      const [key, val] = el.dataset.visibleWhen.split("=");
      // The citation row has an additional precondition — only show
      // when Zotero is set up and the document actually contains cites.
      if (el.hasAttribute("data-cite-row")) {
        el.style.display = (choices[key] === val && hasZotero && hasCitations) ? "" : "none";
      } else {
        el.style.display = choices[key] === val ? "" : "none";
      }
    }
  }

  // Identity of the current render-relevant choice set. When it's
  // unchanged we can reuse the cached PDF bytes on Export.
  function renderKey() {
    return JSON.stringify({
      format: choices.format,
      style: choices.style,
      lineSpacing: choices.lineSpacing,
      includeBibliography: choices.includeBibliography,
      citationStyle: choices.citationStyle,
      stripComments: choices.stripComments,
      stripFlags: choices.stripFlags,
      includeTabs: choices.includeTabs,
      commentNotes: choices.commentNotes,
      numberHeadings: choices.numberHeadings,
      pageNumbers: choices.pageNumbers,
    });
  }

  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { void renderPreview(); }, 350);
  }

  async function renderPreview() {
    const token = ++previewToken;
    if (choices.format === "md") {
      previewEl.classList.add("is-text");
      const pre = document.createElement("pre");
      pre.className = "nxm-preview-text";
      pre.textContent = content || "(empty document)";
      previewEl.replaceChildren(pre);
      return;
    }
    previewEl.classList.remove("is-text");
    if (!IS_TAURI) {
      setPreviewMessage("PDF preview is available in the desktop / iOS app.");
      return;
    }
    setPreviewMessage("Rendering…");
    try {
      let bytes;
      const key = renderKey();
      if (lastRender.key === key && lastRender.bytes) {
        bytes = lastRender.bytes;
      } else {
        bytes = await renderPdfBytes(state, content, choices);
        lastRender = { key, bytes };
      }
      if (token !== previewToken) return; // a newer render superseded us
      await paintPdfPreview(previewEl, bytes);
    } catch (err) {
      console.error("PDF preview failed:", err);
      if (token === previewToken) setPreviewMessage("Preview failed to render.");
    }
  }

  function setPreviewMessage(text) {
    const div = document.createElement("div");
    div.className = "nxm-preview-note";
    div.textContent = text;
    previewEl.replaceChildren(div);
  }

  async function runExport() {
    if (choices.format === "md") {
      // Defer to the established markdown path so iOS share-sheet
      // handling and folder-with-images export stays in one place.
      cleanup();
      await exportCurrentFile(state);
      return;
    }

    const confirmBtn = modal.querySelector(".nxm-confirm");
    const original = confirmBtn.textContent;
    confirmBtn.textContent = "Exporting…";
    confirmBtn.disabled = true;

    try {
      // Reuse the bytes the preview already rendered when nothing that
      // affects the output changed since.
      let bytes;
      const key = renderKey();
      if (lastRender.key === key && lastRender.bytes) {
        bytes = lastRender.bytes;
      } else {
        confirmBtn.textContent = "Rendering…";
        bytes = await renderPdfBytes(state, content, choices);
        lastRender = { key, bytes };
      }
      const baseName = sanitize(choices.filename) || name;
      const fileName = `${baseName.replace(/\.pdf$/i, "")}.pdf`;
      await deliver(bytes, fileName);
      cleanup();
    } catch (err) {
      console.error("PDF export failed:", err);
      confirmBtn.textContent = "Export failed";
      confirmBtn.disabled = false;
      setTimeout(() => { confirmBtn.textContent = original; }, 2200);
    }
  }

  return cleanup;
}

/** Rasterize the rendered PDF into the preview pane via pdf.js. */
async function paintPdfPreview(previewEl, bytes) {
  const { getPdfjs } = await import("../pdf/pdf-viewer.js");
  const pdfjs = await getPdfjs();
  // pdf.js can detach the underlying buffer, so hand it a private copy
  // and keep our cached bytes intact for the eventual save.
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const frag = document.createDocumentFragment();
  const dpr = window.devicePixelRatio || 1;
  const avail = Math.max(160, (previewEl.clientWidth || 320) - 8);
  const pageCount = Math.min(doc.numPages, PREVIEW_MAX_PAGES);
  for (let p = 1; p <= pageCount; p++) {
    const page = await doc.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const cssScale = avail / base.width;
    const viewport = page.getViewport({ scale: cssScale * dpr });
    const canvas = document.createElement("canvas");
    canvas.className = "nxm-preview-page";
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = "100%";
    canvas.style.height = "auto";
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    frag.appendChild(canvas);
  }
  if (doc.numPages > pageCount) {
    const note = document.createElement("div");
    note.className = "nxm-preview-note";
    note.textContent = `… ${doc.numPages - pageCount} more page${doc.numPages - pageCount === 1 ? "" : "s"} not shown`;
    frag.appendChild(note);
  }
  previewEl.replaceChildren(frag);
  doc.cleanup?.();
}

async function fetchStyles() {
  if (!IS_TAURI) {
    return [{ id: "formal", name: "Formal" }];
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const list = await invoke("list_doc_styles");
    if (Array.isArray(list) && list.length > 0) return list;
  } catch (_) { /* fall through to hardcoded default */ }
  return [{ id: "formal", name: "Formal" }];
}

const CITATION_FALLBACK = [
  { id: "numbered", name: "Numbered (gutter)" },
  { id: "apa", name: "APA" },
  { id: "mla", name: "MLA" },
  { id: "chicago", name: "Chicago / Turabian" },
  { id: "ieee", name: "IEEE" },
  { id: "harvard", name: "Harvard" },
];

async function fetchCitationStyles() {
  if (!IS_TAURI) return CITATION_FALLBACK;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const list = await invoke("list_citation_styles");
    if (Array.isArray(list) && list.length > 0) return list;
  } catch (_) { /* fall through */ }
  return CITATION_FALLBACK;
}

async function renderPdfBytes(state, content, choices) {
  if (!IS_TAURI) {
    throw new Error("PDF export requires the desktop or iOS app");
  }
  // Load references whenever the doc cites anything — they're needed both
  // for the bibliography (when on) and for inline author-date formatting
  // (always, so the prose never shows raw citekeys).
  const references = CITE_RE.test(content)
    ? await loadReferences().catch(() => [])
    : [];
  const imageFilenames = collectImageRefs(state, content);
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke("render_doc_pdf", {
    args: {
      markdown: content,
      styleId: choices.style,
      // Wire name stays `includeCitations` for IPC back-compat; on the
      // Rust side it now gates the bibliography specifically.
      includeCitations: !!choices.includeBibliography,
      citationStyle: choices.citationStyle,
      stripComments: !!choices.stripComments,
      stripFlags: !!choices.stripFlags,
      includeTabs: !!choices.includeTabs,
      commentNotes: !!choices.commentNotes,
      numberHeadings: !!choices.numberHeadings,
      pageNumbers: !!choices.pageNumbers,
      lineSpacing: Number.isFinite(choices.lineSpacing) ? choices.lineSpacing : 1.5,
      references,
      imageFilenames,
    },
  });
  return new Uint8Array(bytes);
}

async function deliver(bytes, fileName) {
  if (isIOS()) {
    const file = new File([bytes], fileName, { type: "application/pdf" });
    if (!(navigator.canShare && navigator.canShare({ files: [file] }))) {
      throw new Error("Web Share API cannot share this file on this device");
    }
    try {
      await navigator.share({ files: [file] });
    } catch (e) {
      // User-dismissed share sheets throw AbortError — not a failure.
      if (e && (e.name === "AbortError" || /aborted|cancel/i.test(e.message || ""))) return;
      throw e;
    }
    return;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const filePath = await save({
    defaultPath: fileName,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!filePath) return; // user cancelled
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("write_binary_file", { path: filePath, bytes: Array.from(bytes) });
}

function deriveDocName(state, content) {
  if (state.currentProjectId) {
    const node = findNode(state.fileTree, state.currentProjectId);
    return sanitize(node?.name || "project-export");
  }
  return sanitize(state._deriveName(content) || "hush-export");
}

function sanitize(name) {
  return (name || "document").replace(/[\/\\:*?"<>|]/g, "-").slice(0, 120) || "document";
}

function escHtml(s) {
  const div = document.createElement("div");
  div.textContent = s || "";
  return div.innerHTML;
}

function escAttr(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
