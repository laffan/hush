/**
 * Doc export modal.
 *
 * Opens when the user presses Export with a document (or project) open.
 * Lets them choose Markdown (.md, same direct-write path the sidebar
 * used pre-modal) or PDF (rendered through Typst on the Rust side, see
 * `commands::pdf_export` and `typst_export/`).
 *
 * PDF surface:
 *   - Document style is sourced from the backend's registered styles
 *     so adding a style only requires touching one Rust file.
 *   - When Zotero is set up AND the document contains at least one
 *     `[@citekey]` reference, the user gets an "Include citations &
 *     bibliography" toggle.
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
  modal.className = "notebook-export-modal";

  const choices = {
    filename: name,
    format: "pdf",
    style: styles[0]?.id || "formal",
    lineSpacing: 1.5,
    includeCitations: hasZotero && hasCitations,
    citationStyle: citationStyles[0]?.id || "numbered",
    stripComments: true,
    stripFlags: true,
    includeTabs: true,
    numberHeadings: false,
    pageNumbers: true,
  };

  modal.innerHTML = `
    <div class="nxm-title">Export document</div>

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
        <input type="checkbox" class="nxm-cite-toggle" ${choices.includeCitations ? "checked" : ""} />
        Include citations &amp; bibliography
      </label>
      <div class="nxm-cite-style-row" style="${choices.includeCitations ? "" : "display:none"}">
        <label class="nxm-inline-label">Citation style
          <select class="nxm-cite-style-select">
            ${citationStyles.map((s) => `<option value="${escAttr(s.id)}">${escHtml(s.name)}</option>`).join("")}
          </select>
        </label>
      </div>
    </div>

    <div class="nxm-actions">
      <button class="nxm-cancel">Cancel</button>
      <button class="nxm-confirm">Export</button>
    </div>
  `;

  document.body.appendChild(backdrop);
  document.body.appendChild(modal);

  const cleanup = () => {
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

  modal.querySelectorAll(".nxm-seg").forEach((group) => {
    group.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-value]");
      if (!btn) return;
      const key = group.getAttribute("data-group");
      choices[key] = btn.dataset.value;
      group.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      applyVisibility();
    });
  });

  const filenameInput = modal.querySelector(".nxm-filename-input");
  if (filenameInput) {
    filenameInput.addEventListener("input", () => { choices.filename = filenameInput.value; });
  }

  const styleSelect = modal.querySelector(".nxm-style-select");
  styleSelect.addEventListener("change", () => { choices.style = styleSelect.value; });

  const spacingSelect = modal.querySelector(".nxm-spacing-select");
  spacingSelect.addEventListener("change", () => {
    const v = parseFloat(spacingSelect.value);
    choices.lineSpacing = Number.isFinite(v) ? v : 1.5;
  });

  const citeToggle = modal.querySelector(".nxm-cite-toggle");
  const citeStyleRow = modal.querySelector(".nxm-cite-style-row");
  const citeStyleSelect = modal.querySelector(".nxm-cite-style-select");
  citeToggle.addEventListener("change", () => {
    choices.includeCitations = citeToggle.checked;
    citeStyleRow.style.display = citeToggle.checked ? "" : "none";
  });
  citeStyleSelect.addEventListener("change", () => { choices.citationStyle = citeStyleSelect.value; });

  // Generic checkbox wiring keyed by `data-choice`. Lets us add more
  // layout toggles in HTML without touching the JS plumbing.
  modal.querySelectorAll("input[data-choice]").forEach((cb) => {
    cb.addEventListener("change", () => {
      choices[cb.dataset.choice] = cb.checked;
    });
  });

  modal.querySelector(".nxm-cancel").addEventListener("click", cleanup);
  modal.querySelector(".nxm-confirm").addEventListener("click", () => { void runExport(); });

  applyVisibility();

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
    confirmBtn.textContent = "Rendering…";
    confirmBtn.disabled = true;

    try {
      const bytes = await renderPdfBytes(state, content, choices);
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
  const references = choices.includeCitations
    ? await loadReferences().catch(() => [])
    : [];
  const imageFilenames = collectImageRefs(state, content);
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke("render_doc_pdf", {
    args: {
      markdown: content,
      styleId: choices.style,
      includeCitations: !!choices.includeCitations,
      citationStyle: choices.citationStyle,
      stripComments: !!choices.stripComments,
      stripFlags: !!choices.stripFlags,
      includeTabs: !!choices.includeTabs,
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
