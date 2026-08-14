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

import { exportCurrentFile } from "./sidebar-export.js";
import { loadReferences } from "../zotero.js";
import { isIOS } from "../settings/settings-ui.js";
import { applyCitations } from "./export-citations.js";
import { markdownToRtf } from "./markdown-to-rtf.js";
import { hasTokensAsync } from "../google-docs/auth.js";
import {
  paintPdfPreview,
  fetchStyles,
  fetchCitationStyles,
  renderPdfBytes,
  deliver,
  deliverText,
  exportToGoogleDoc,
  isAbort,
  deriveDocName,
  sanitize,
  escHtml,
  escAttr,
} from "./doc-export-render.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

const CITE_RE = /\[@([A-Za-z0-9_:.+-]+)\](?:\([^)\n]*\))?/;

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
  // Citation toggles only matter when Zotero is set up *and* the doc
  // actually cites something — same precondition the PDF cite row uses.
  const showCiteControls = hasZotero && hasCitations;

  // The Google Doc format is offered only once Google Sync is connected.
  // `hasTokensAsync` primes its cache from settings, so this works even
  // in the main editor window where the module starts unprimed.
  const googleReady = await hasTokensAsync().catch(() => false);

  const styles = await fetchStyles();
  const citationStyles = await fetchCitationStyles();

  // Loaded lazily the first time a citation-aware format needs them, then
  // reused for previews and the final export.
  let referencesCache = null;
  async function getReferences() {
    if (referencesCache) return referencesCache;
    referencesCache = await loadReferences().catch(() => []);
    return referencesCache;
  }

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
    // Header-size slider (PDF). Scales every heading level by the same
    // factor so they keep their relationship while shifting relative to
    // the body text. 1.0 = the style's design sizes.
    headerScale: 1.0,
    // Extra room above every heading, in em. 0 = whatever spacing the
    // chosen document style designed for itself.
    headingSpace: 0,
    // Whether to append a bibliography section. Inline citations are
    // formatted regardless (see renderPdfBytes / the Rust side).
    includeBibliography: showCiteControls,
    citationStyle: citationStyles[0]?.id || "numbered",
    // Citation knobs for the text-shaped formats (Markdown / RTF /
    // Google Doc). Independent of the PDF's always-on inline formatting.
    renderCitations: showCiteControls,
    includeBibliographyText: showCiteControls,
    stripComments: true,
    stripFlags: true,
    includeTabs: true,
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
            <button data-value="rtf">RTF</button>
            ${googleReady ? `<button data-value="gdoc">Google Doc</button>` : ""}
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
          <div class="nxm-label">Header size <span class="nxm-header-scale-val">100%</span></div>
          <input type="range" class="nxm-header-scale" min="60" max="180" step="5" value="100" />
        </div>

        <div class="nxm-section" data-visible-when="format=pdf">
          <div class="nxm-label">Header top margin <span class="nxm-heading-space-val">Style default</span></div>
          <input type="range" class="nxm-heading-space" min="0" max="12" step="1" value="0" />
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

        <div class="nxm-section" data-visible-in="md rtf gdoc" data-cite-text-row style="${showCiteControls ? "" : "display:none"}">
          <div class="nxm-label">Zotero</div>
          <label class="nxm-checkbox-label">
            <input type="checkbox" data-choice="renderCitations" ${choices.renderCitations ? "checked" : ""} />
            Render citations
          </label>
          <label class="nxm-checkbox-label">
            <input type="checkbox" data-choice="includeBibliographyText" ${choices.includeBibliographyText ? "checked" : ""} />
            Include bibliography
          </label>
        </div>
      </div>

      <div class="nxm-right">
        <div class="nxm-label">Preview</div>
        <div class="nxm-preview"></div>
      </div>
    </div>

    <div class="nxm-actions">
      <button class="nxm-cancel">Cancel</button>
      <button class="nxm-alt" data-visible-in="pdf">Save to Desk</button>
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

  const headerScaleInput = modal.querySelector(".nxm-header-scale");
  const headerScaleVal = modal.querySelector(".nxm-header-scale-val");
  headerScaleInput.addEventListener("input", () => {
    const pct = parseInt(headerScaleInput.value, 10) || 100;
    choices.headerScale = pct / 100;
    headerScaleVal.textContent = `${pct}%`;
    // `input` fires continuously while dragging; the preview is already
    // debounced (350 ms) so a quick drag only renders once it settles.
    markChanged();
  });

  // Quarter-em steps up to 3em, so the slider's integer positions map
  // to round typographic values rather than arbitrary decimals.
  const headingSpaceInput = modal.querySelector(".nxm-heading-space");
  const headingSpaceVal = modal.querySelector(".nxm-heading-space-val");
  headingSpaceInput.addEventListener("input", () => {
    const em = (parseInt(headingSpaceInput.value, 10) || 0) * 0.25;
    choices.headingSpace = em;
    // 0 isn't "no margin" — it's "leave the style's own spacing alone",
    // which is a different enough thing to say in words.
    headingSpaceVal.textContent = em === 0 ? "Style default" : `${em}em`;
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
  modal.querySelector(".nxm-alt").addEventListener("click", () => { void runSaveToDesk(); });

  applyVisibility();
  // Kick off the first preview now that the layout has a measurable width.
  requestAnimationFrame(() => { void renderPreview(); });

  function applyVisibility() {
    for (const el of modal.querySelectorAll("[data-visible-when]")) {
      const [key, val] = el.dataset.visibleWhen.split("=");
      // The citation row has an additional precondition — only show
      // when Zotero is set up and the document actually contains cites.
      if (el.hasAttribute("data-cite-row")) {
        el.style.display = (choices[key] === val && showCiteControls) ? "" : "none";
      } else {
        el.style.display = choices[key] === val ? "" : "none";
      }
    }
    // `data-visible-in="md rtf gdoc"` — show when the active format is in
    // the space-separated list. The text-format cite row layers on the
    // same Zotero precondition as the PDF one.
    for (const el of modal.querySelectorAll("[data-visible-in]")) {
      const formats = el.dataset.visibleIn.split(/\s+/).filter(Boolean);
      let visible = formats.includes(choices.format);
      if (el.hasAttribute("data-cite-text-row")) visible = visible && showCiteControls;
      el.style.display = visible ? "" : "none";
    }
  }

  // Identity of the current render-relevant choice set. When it's
  // unchanged we can reuse the cached PDF bytes on Export.
  function renderKey() {
    return JSON.stringify({
      format: choices.format,
      style: choices.style,
      lineSpacing: choices.lineSpacing,
      headerScale: choices.headerScale,
      headingSpace: choices.headingSpace,
      includeBibliography: choices.includeBibliography,
      citationStyle: choices.citationStyle,
      stripComments: choices.stripComments,
      stripFlags: choices.stripFlags,
      includeTabs: choices.includeTabs,
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
    // Every non-PDF format is text-shaped: show the markdown that will be
    // written / converted, with citation processing already applied so
    // the preview reflects the Zotero toggles.
    if (choices.format !== "pdf") {
      previewEl.classList.add("is-text");
      const text = await processedTextContent();
      if (token !== previewToken) return;
      const pre = document.createElement("pre");
      pre.className = "nxm-preview-text";
      pre.textContent = text || "(empty document)";
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
        bytes = await renderPdfBytes(state, content, choices, name);
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

  // The markdown that the text-shaped formats (Markdown / RTF / Google
  // Doc) start from — citation processing applied per the Zotero toggles.
  async function processedTextContent() {
    if (!showCiteControls) return content;
    const refs = await getReferences();
    return applyCitations(content, refs, {
      renderCitations: choices.renderCitations,
      includeBibliography: choices.includeBibliographyText,
    });
  }

  async function runExport() {
    if (choices.format === "md") {
      // Defer to the established markdown path so iOS share-sheet
      // handling and folder-with-images export stays in one place. The
      // citation-processed body is handed over so the Zotero toggles
      // apply (when no toggles fire, this equals the raw content).
      const processed = await processedTextContent();
      cleanup();
      await exportCurrentFile(state, { content: processed });
      return;
    }

    const confirmBtn = modal.querySelector(".nxm-confirm");
    const original = confirmBtn.textContent;
    confirmBtn.textContent = "Exporting…";
    confirmBtn.disabled = true;
    const fail = (msg, err) => {
      console.error(msg, err);
      confirmBtn.textContent = "Export failed";
      confirmBtn.disabled = false;
      setTimeout(() => { confirmBtn.textContent = original; }, 2200);
    };

    if (choices.format === "rtf") {
      try {
        const processed = await processedTextContent();
        const rtf = markdownToRtf(processed);
        const baseName = sanitize(choices.filename) || name;
        await deliverText(`${baseName.replace(/\.rtf$/i, "")}.rtf`, rtf, "rtf",
          "application/rtf");
        cleanup();
      } catch (err) {
        if (isAbort(err)) { cleanup(); return; }
        fail("RTF export failed:", err);
      }
      return;
    }

    if (choices.format === "gdoc") {
      try {
        confirmBtn.textContent = "Creating…";
        const processed = await processedTextContent();
        const baseName = sanitize(choices.filename) || name;
        await exportToGoogleDoc(state, processed, baseName);
        cleanup();
      } catch (err) {
        fail("Google Doc export failed:", err);
      }
      return;
    }

    try {
      const bytes = await pdfBytes((t) => { confirmBtn.textContent = t; });
      const baseName = sanitize(choices.filename) || name;
      const fileName = `${baseName.replace(/\.pdf$/i, "")}.pdf`;
      await deliver(bytes, fileName);
      cleanup();
    } catch (err) {
      fail("PDF export failed:", err);
    }
  }

  /** Render (or reuse) the PDF bytes for the current choices. Shared by
   *  Export and Save to Desk so switching between them never re-renders
   *  output the preview already produced. */
  async function pdfBytes(onStatus) {
    const key = renderKey();
    if (lastRender.key === key && lastRender.bytes) return lastRender.bytes;
    onStatus?.("Rendering…");
    const bytes = await renderPdfBytes(state, content, choices, name);
    lastRender = { key, bytes };
    return bytes;
  }

  /** Land the rendered PDF in the desk's PDFs folder instead of on disk
   *  — the export half of the read-and-mark-up loop, which otherwise
   *  needs a round trip through the file system and a re-import. */
  async function runSaveToDesk() {
    const btn = modal.querySelector(".nxm-alt");
    const original = btn.textContent;
    btn.disabled = true;
    try {
      const bytes = await pdfBytes((t) => { btn.textContent = t; });
      btn.textContent = "Saving…";
      const { savePdfBytesToDesk } = await import("../pdf/save-pdf-to-desk.js");
      const baseName = sanitize(choices.filename) || name;
      await savePdfBytesToDesk(state, bytes, baseName);
      cleanup();
    } catch (err) {
      console.error("Save to Desk failed:", err);
      btn.textContent = "Save failed";
      btn.disabled = false;
      setTimeout(() => { btn.textContent = original; }, 2200);
    }
  }

  return cleanup;
}
