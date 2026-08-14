/**
 * "Which pages?" modal for Create Proofread Notebook.
 *
 * A proof is expensive in a way the user can't see before it happens —
 * every page becomes a full-size raster inside the notebook — so the
 * choice of pages is the one decision worth interrupting for. It also
 * covers the case the old are-you-sure gate handled: a 400-page book
 * asks nothing now, because the answer is "just chapter three".
 *
 * The field takes the notation people already use in print dialogs
 * ("1-3, 5-8, 12"). Empty means every page, which is both the default
 * and the thing most people want, so Enter straight through works.
 */

import { escHtml } from "../sidebar/files-panel-shared.js";

/**
 * Parse a page-range expression into sorted, deduped 1-based page
 * numbers clamped to `total`.
 *
 * Returns `{ pages, error }`. Anything unparseable is an error rather
 * than a silent drop: quietly proofreading pages 1-3 when the user
 * typed "1-3, 5-8" with a typo in the second range is worse than
 * saying so.
 */
export function parsePageRanges(expr, total) {
  const text = (expr || "").trim();
  if (!text) return { pages: allPages(total), error: null };

  const pages = new Set();
  for (const rawPart of text.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    const m = /^(\d+)\s*(?:[-–—]\s*(\d+))?$/.exec(part);
    if (!m) return { pages: [], error: `Couldn't read "${part}".` };
    const from = parseInt(m[1], 10);
    const to = m[2] === undefined ? from : parseInt(m[2], 10);
    if (!from || !to) return { pages: [], error: "Pages start at 1." };
    if (from > total || to > total) {
      return { pages: [], error: `This PDF only has ${total} page${total === 1 ? "" : "s"}.` };
    }
    // Accept a reversed range rather than rejecting it — "8-5" is a
    // typo with an obvious intent, not a question.
    for (let p = Math.min(from, to); p <= Math.max(from, to); p++) pages.add(p);
  }
  if (!pages.size) return { pages: [], error: "No pages selected." };
  return { pages: Array.from(pages).sort((a, b) => a - b), error: null };
}

function allPages(total) {
  const out = [];
  for (let i = 1; i <= total; i++) out.push(i);
  return out;
}

/** Page count above which the modal warns about size / time. Not a
 *  block — the user has been told, and it's their document. */
const HEAVY_PAGE_COUNT = 60;

/**
 * Ask which pages to proofread.
 *
 * Resolves to the chosen 1-based page numbers, or `null` if the user
 * cancelled.
 */
export function openProofreadPagesModal({ name, total }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "ppm-backdrop";
    const modal = document.createElement("div");
    modal.className = "proofread-pages-modal";
    modal.innerHTML = `
      <div class="ppm-title">Create Proofread Notebook</div>
      <div class="ppm-sub">${escHtml(name)} — ${total} page${total === 1 ? "" : "s"}</div>
      <label class="ppm-label" for="ppm-range">Pages</label>
      <input id="ppm-range" class="ppm-input" type="text" placeholder="All pages — or 1-3, 5-8" autocomplete="off" spellcheck="false" />
      <div class="ppm-status"></div>
      <div class="ppm-actions">
        <button class="ppm-cancel">Cancel</button>
        <button class="ppm-confirm">Create</button>
      </div>
    `;
    document.body.appendChild(backdrop);
    document.body.appendChild(modal);

    const input = modal.querySelector(".ppm-input");
    const status = modal.querySelector(".ppm-status");
    const confirm = modal.querySelector(".ppm-confirm");
    let current = allPages(total);

    const cleanup = (result) => {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      modal.remove();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); cleanup(null); }
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); accept(); }
    };
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", () => cleanup(null));
    modal.querySelector(".ppm-cancel").addEventListener("click", () => cleanup(null));
    confirm.addEventListener("click", accept);

    function validate() {
      const { pages, error } = parsePageRanges(input.value, total);
      current = pages;
      modal.classList.toggle("ppm-invalid", !!error);
      confirm.disabled = !!error;
      if (error) {
        status.textContent = error;
        return;
      }
      const n = pages.length;
      status.textContent = n >= HEAVY_PAGE_COUNT
        ? `${n} pages — this will take a while and make a large notebook.`
        : `${n} page${n === 1 ? "" : "s"} selected.`;
      status.classList.toggle("ppm-warn", n >= HEAVY_PAGE_COUNT);
    }

    function accept() {
      if (confirm.disabled || !current.length) return;
      cleanup(current);
    }

    input.addEventListener("input", validate);
    validate();
    requestAnimationFrame(() => input.focus());
  });
}
