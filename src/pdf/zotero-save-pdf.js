/**
 * "Zotero: Save PDF" — modal to pick a Zotero reference, download its
 * PDF attachment, and save it as a first-class PDF file in the tree.
 *
 * The UI mirrors the Insert Reference modal (same search + result list)
 * but the detail view is simplified: once an item is selected, only its
 * PDF attachments are shown with "Back" and "Save PDF" buttons.
 */

import { loadReferences, fuzzySearch, clearCache } from "../zotero.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

let modal = null;

export async function openZoteroSavePdfModal(state) {
  if (modal) { closeModal(); return; }

  clearCache();
  const refs = await loadReferences();
  if (!refs || refs.length === 0) {
    showNoRefsMessage();
    return;
  }

  modal = document.createElement("div");
  modal.className = "zotero-modal";
  modal.innerHTML = `
    <div class="zotero-search-row">
      <input type="text" class="zotero-search-input" placeholder="Search Zotero library..." autofocus />
      <button class="zotero-close-btn" title="Close">×</button>
    </div>
    <div class="zotero-results"></div>
    <div class="zotero-detail hidden"></div>
  `;
  document.body.appendChild(modal);

  const input = modal.querySelector(".zotero-search-input");
  const resultsEl = modal.querySelector(".zotero-results");
  const detailEl = modal.querySelector(".zotero-detail");

  function renderResults(query) {
    const results = fuzzySearch(refs, query);
    resultsEl.innerHTML = results.map(r => {
      const hasPdf = r.attachments?.some(a => a.isPdf);
      return `
        <div class="zotero-result${hasPdf ? "" : " no-pdf"}" data-key="${r.key}">
          <span class="zotero-result-title">${escHtml(r.shortTitle || r.title)}</span>
          <span class="zotero-result-meta">${escHtml(r.year)}${r.authors ? " — " + escHtml(r.authors) : ""}${hasPdf ? "" : " (no PDF)"}</span>
        </div>
      `;
    }).join("") || '<div class="zotero-empty">No results found.</div>';
    resultsEl.classList.remove("hidden");
    detailEl.classList.add("hidden");
  }

  function showDetail(ref) {
    resultsEl.classList.add("hidden");
    const pdfAttachments = (ref.attachments || []).filter(a => a.isPdf);
    if (!pdfAttachments.length) {
      detailEl.innerHTML = `
        <div class="zotero-detail-header">
          <div class="zotero-detail-title">${escHtml(ref.title)}</div>
          <div class="zotero-detail-meta">${escHtml(ref.year)}${ref.authors ? " — " + escHtml(ref.authors) : ""}</div>
        </div>
        <div class="zotero-empty" style="padding: 16px 0;">No PDF attachments found for this item.</div>
        <div class="zotero-actions">
          <button class="zotero-back-btn">Back</button>
        </div>
      `;
      detailEl.classList.remove("hidden");
      detailEl.querySelector(".zotero-back-btn").addEventListener("click", () => renderResults(input.value));
      return;
    }

    const showRadios = pdfAttachments.length > 1;
    detailEl.innerHTML = `
      <div class="zotero-detail-header">
        <div class="zotero-detail-title">${escHtml(ref.title)}</div>
        <div class="zotero-detail-meta">${escHtml(ref.year)}${ref.authors ? " — " + escHtml(ref.authors) : ""}</div>
      </div>
      ${showRadios ? `<div class="zotero-link-options">
        ${pdfAttachments.map((att, i) => `
          <label class="zotero-option">
            <input type="radio" name="zotero-pdf-target" value="${att.key}" ${i === 0 ? "checked" : ""} />
            <span>${escHtml(att.title)}</span>
          </label>
        `).join("")}
      </div>` : ""}
      <div class="zotero-actions">
        <button class="zotero-back-btn">Back</button>
        <button class="zotero-insert-btn zotero-save-pdf-btn">Save PDF</button>
      </div>
      <div class="zotero-status zotero-insert-status"></div>
    `;
    detailEl.classList.remove("hidden");

    detailEl.querySelector(".zotero-back-btn").addEventListener("click", () => renderResults(input.value));

    detailEl.querySelector(".zotero-save-pdf-btn").addEventListener("click", async () => {
      const attKey = showRadios
        ? detailEl.querySelector('input[name="zotero-pdf-target"]:checked')?.value
        : pdfAttachments[0].key;
      if (!attKey) return;

      const status = detailEl.querySelector(".zotero-insert-status");
      const saveBtn = detailEl.querySelector(".zotero-save-pdf-btn");
      saveBtn.disabled = true;
      saveBtn.textContent = "Downloading...";
      if (status) { status.textContent = "Downloading PDF from Zotero..."; status.className = "zotero-status zotero-insert-status"; }

      try {
        const userId = state.settings?.zoteroUserId;
        const apiKey = state.settings?.zoteroApiKey;
        if (!userId || !apiKey) throw new Error("Zotero credentials missing");

        let bytes;
        if (IS_TAURI) {
          bytes = await tauriInvoke("download_zotero_pdf", { itemKey: attKey, userId, apiKey });
        } else {
          const url = `https://api.zotero.org/users/${userId}/items/${attKey}/file?key=${apiKey}`;
          const resp = await fetch(url, { redirect: "follow" });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const ab = await resp.arrayBuffer();
          bytes = new Uint8Array(ab);
        }

        if (status) { status.textContent = "Saving PDF..."; }

        const pdfBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const baseName = sanitizeFilename(ref.shortTitle || ref.title || "PDF");
        const result = await state.importPdf(baseName, pdfBytes, null, {
          openImmediately: true,
          zoteroAttKey: attKey,
          zoteroItemKey: ref.key,
          zoteroTitle: ref.title || "Untitled",
          zoteroAuthors: ref.authors || "",
          zoteroFirstAuthor: ref.firstAuthor || "",
          zoteroYear: ref.year || "",
          zoteroCitekey: ref.citekey || "",
        });

        if (status) { status.textContent = "Saved!"; status.className = "zotero-status zotero-insert-status success"; }
        setTimeout(() => closeModal(), 400);
      } catch (e) {
        console.error("Save PDF failed:", e);
        if (status) { status.textContent = "Failed: " + (e?.message || e); status.className = "zotero-status zotero-insert-status error"; }
        saveBtn.disabled = false;
        saveBtn.textContent = "Save PDF";
      }
    });
  }

  input.addEventListener("input", () => renderResults(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  resultsEl.addEventListener("click", (e) => {
    const row = e.target.closest(".zotero-result");
    if (!row || row.classList.contains("no-pdf")) return;
    const key = row.dataset.key;
    const ref = refs.find(r => r.key === key);
    if (ref) showDetail(ref);
  });

  modal.querySelector(".zotero-close-btn").addEventListener("click", closeModal);

  setTimeout(() => {
    document.addEventListener("mousedown", function handler(e) {
      if (modal && !modal.contains(e.target)) {
        closeModal();
        document.removeEventListener("mousedown", handler);
      }
    });
  }, 0);

  renderResults("");
  input.focus();
}

function closeModal() {
  if (modal) { modal.remove(); modal = null; }
}

function showNoRefsMessage() {
  const msg = document.createElement("div");
  msg.className = "zotero-modal zotero-no-refs";
  msg.innerHTML = `
    <div class="zotero-no-refs-content">
      <p>No Zotero references found.</p>
      <p>Set up your Zotero API credentials and download references in Settings > Zotero.</p>
      <button class="zotero-dismiss-btn">OK</button>
    </div>
  `;
  document.body.appendChild(msg);
  msg.querySelector(".zotero-dismiss-btn").addEventListener("click", () => msg.remove());
  setTimeout(() => {
    document.addEventListener("mousedown", function handler(e) {
      if (!msg.contains(e.target)) { msg.remove(); document.removeEventListener("mousedown", handler); }
    });
  }, 0);
}

function sanitizeFilename(s) {
  return (s || "PDF")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60) || "PDF";
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}
