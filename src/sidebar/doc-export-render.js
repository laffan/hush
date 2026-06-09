/**
 * Rendering, delivery, and small format helpers for the doc export
 * modal (`doc-export-modal.js`). Split out to keep the modal focused on
 * its UI wiring — everything here is stateless and takes whatever it
 * needs as an argument.
 *
 *   - PDF: `renderPdfBytes` (Typst via the Rust backend), `paintPdfPreview`
 *   - Delivery sinks: `deliver` (PDF), `deliverText` (RTF), `exportToGoogleDoc`
 *   - Style / citation-style lists from the backend
 *   - Naming + escaping helpers shared with the modal markup
 */

import { findNode } from "../state/tree-helpers.js";
import { loadReferences } from "../zotero.js";
import { collectImageRefs } from "../state/state-images.js";
import { isIOS } from "../settings/settings-ui.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

export const CITE_RE = /\[@([A-Za-z0-9_:.+-]+)\](?:\([^)\n]*\))?/;

// How many pages to rasterize into the preview pane. Keeps big docs from
// stalling the modal — a note appears when there are more.
const PREVIEW_MAX_PAGES = 12;

/** Rasterize the rendered PDF into the preview pane via pdf.js. */
export async function paintPdfPreview(previewEl, bytes) {
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

export async function fetchStyles() {
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

export async function fetchCitationStyles() {
  if (!IS_TAURI) return CITATION_FALLBACK;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const list = await invoke("list_citation_styles");
    if (Array.isArray(list) && list.length > 0) return list;
  } catch (_) { /* fall through */ }
  return CITATION_FALLBACK;
}

export async function renderPdfBytes(state, content, choices, name) {
  if (!IS_TAURI) {
    throw new Error("PDF export requires the desktop or iOS app");
  }
  // The document's first line is its filename by Hush's naming
  // convention; drop it from the PDF body so the name isn't duplicated
  // (it already rides into the OS via the export filename).
  const body = stripLeadingTitleLine(content, name);
  // Load references whenever the doc cites anything — they're needed both
  // for the bibliography (when on) and for inline author-date formatting
  // (always, so the prose never shows raw citekeys).
  const references = CITE_RE.test(body)
    ? await loadReferences().catch(() => [])
    : [];
  const imageFilenames = collectImageRefs(state, body);
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke("render_doc_pdf", {
    args: {
      markdown: body,
      styleId: choices.style,
      // Wire name stays `includeCitations` for IPC back-compat; on the
      // Rust side it now gates the bibliography specifically.
      includeCitations: !!choices.includeBibliography,
      citationStyle: choices.citationStyle,
      stripComments: !!choices.stripComments,
      stripFlags: !!choices.stripFlags,
      includeTabs: !!choices.includeTabs,
      numberHeadings: !!choices.numberHeadings,
      pageNumbers: !!choices.pageNumbers,
      lineSpacing: Number.isFinite(choices.lineSpacing) ? choices.lineSpacing : 1.5,
      headerScale: Number.isFinite(choices.headerScale) ? choices.headerScale : 1.0,
      references,
      imageFilenames,
    },
  });
  return new Uint8Array(bytes);
}

/** Write the rendered PDF bytes to disk (desktop) or hand them to the
 *  iOS share sheet. */
export async function deliver(bytes, fileName) {
  if (isIOS()) {
    const file = new File([bytes], fileName, { type: "application/pdf" });
    if (!(navigator.canShare && navigator.canShare({ files: [file] }))) {
      throw new Error("Web Share API cannot share this file on this device");
    }
    try {
      await navigator.share({ files: [file] });
    } catch (e) {
      // User-dismissed share sheets throw AbortError — not a failure.
      if (isAbort(e)) return;
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

/** Write a UTF-8 text payload (RTF) to disk or the iOS share sheet.
 *  Mirrors `deliver` for text formats. */
export async function deliverText(fileName, text, ext, mime) {
  if (isIOS()) {
    const file = new File([text], fileName, { type: mime });
    if (!(navigator.canShare && navigator.canShare({ files: [file] }))) {
      throw new Error("Web Share API cannot share this file on this device");
    }
    await navigator.share({ files: [file] });
    return;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const filePath = await save({
    defaultPath: fileName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (!filePath) return; // user cancelled
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  await writeTextFile(filePath, text);
}

/** Create a brand-new Google Doc from the processed markdown and open it
 *  in the browser. Reuses the same markdown → HTML converter the Google
 *  Docs push path uses, plus the Drive create endpoint. Unlike the
 *  command-palette "Create Google Doc from current", this is a one-shot
 *  export — it does not link the Hush file to the new doc. */
export async function exportToGoogleDoc(state, markdown, baseName) {
  const { markdownToHtml } = await import("../editor/google-docs/markdown-to-html.js");
  const { createDocumentFromHtml } = await import("../google-docs/api.js");
  const html = markdownToHtml(markdown);
  const created = await createDocumentFromHtml(baseName || "Untitled", html);
  const url = created?.webViewLink
    || (created?.id ? `https://docs.google.com/document/d/${created.id}/edit` : null);
  if (url) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch (_) {
      try { window.open(url, "_blank"); } catch (_) { /* best effort */ }
    }
  }
  // Surface the new doc in the Google sync log so the user has a record.
  try {
    const { appendLog } = await import("../google-docs/link-store.js");
    appendLog(state, `Exported "${created?.name || baseName}" to a new Google Doc`);
  } catch (_) { /* logging is best-effort */ }
  return created;
}

/** Drop the document's leading title line when it matches the export
 *  name (the first line is the filename by Hush's naming convention).
 *  Leaves a genuinely different first heading in place, and never touches
 *  a project whose first line is a `---Tab---` marker rather than a
 *  title. */
export function stripLeadingTitleLine(content, name) {
  if (!content || !name) return content;
  const target = normalizeTitle(name);
  if (!target) return content;
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length) return content;
  // A leading tab marker means the first content line isn't the title —
  // leave projects / tabbed docs untouched.
  if (/^---.+---$/.test(lines[i].trim())) return content;
  if (normalizeTitle(lines[i]) !== target) return content;
  lines.splice(i, 1);
  // Tidy up a now-leading blank line so the body doesn't start with a gap.
  if (i < lines.length && lines[i].trim() === "") lines.splice(i, 1);
  return lines.join("\n");
}

function normalizeTitle(s) {
  return String(s || "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Did this error come from a user dismissing the iOS share sheet? */
export function isAbort(e) {
  return !!e && (e.name === "AbortError" || /aborted|cancel/i.test(e.message || ""));
}

export function deriveDocName(state, content) {
  if (state.currentProjectId) {
    const node = findNode(state.fileTree, state.currentProjectId);
    return sanitize(node?.name || "project-export");
  }
  return sanitize(state._deriveName(content) || "hush-export");
}

export function sanitize(name) {
  return (name || "document").replace(/[\/\\:*?"<>|]/g, "-").slice(0, 120) || "document";
}

export function escHtml(s) {
  const div = document.createElement("div");
  div.textContent = s || "";
  return div.innerHTML;
}

export function escAttr(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
