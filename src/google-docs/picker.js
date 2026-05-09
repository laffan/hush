/**
 * Google Drive picker — a small modal that lists the user's Google Docs
 * with a search filter, plus a "Create new" option that returns a
 * synthetic `{ create: true, title }` result for the caller to act on.
 *
 * Returns a Promise:
 *   { id, name, modifiedTime, owner }    when the user picks an existing doc
 *   { create: true, title }              when the user chooses "Create new"
 *   null                                  when the user cancels
 *
 * Reuses the same modal styling primitives as the Dropbox browser
 * (`gdoc-picker-*` classes; CSS lives alongside the link bar in
 * `styles/google-docs.css`).
 */
import { listDocuments } from "./api.js";

const SEARCH_DEBOUNCE_MS = 250;

export function openGoogleDocPicker(opts = {}) {
  const allowCreate = opts.allowCreate !== false;
  const defaultTitle = opts.defaultTitle || "";
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "gdoc-picker-backdrop";
    const modal = document.createElement("div");
    modal.className = "gdoc-picker-modal";
    modal.innerHTML = `
      <div class="gdoc-picker-header">
        <input class="gdoc-picker-search" type="text" placeholder="Search your Google Docs…" autocomplete="off" />
        <button class="gdoc-picker-close" title="Close">×</button>
      </div>
      <div class="gdoc-picker-list"></div>
      ${allowCreate ? `
        <div class="gdoc-picker-create-row">
          <button class="gdoc-picker-create-btn">Create new Google Doc${defaultTitle ? ` titled "${escHtml(defaultTitle)}"` : ""}</button>
        </div>
      ` : ""}
    `;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const searchEl = modal.querySelector(".gdoc-picker-search");
    const listEl = modal.querySelector(".gdoc-picker-list");
    const closeBtn = modal.querySelector(".gdoc-picker-close");
    const createBtn = modal.querySelector(".gdoc-picker-create-btn");
    let debounceTimer = null;
    let activeQuery = "";
    let lastRunId = 0;

    function close(result) {
      window.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(result);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
    }
    window.addEventListener("keydown", onKey, true);

    closeBtn.addEventListener("click", () => close(null));
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(null); });
    if (createBtn) {
      createBtn.addEventListener("click", () => {
        const title = (searchEl.value.trim() || defaultTitle || "Untitled").trim();
        close({ create: true, title });
      });
    }

    async function runSearch(query) {
      const runId = ++lastRunId;
      listEl.innerHTML = `<div class="gdoc-picker-loading">Loading…</div>`;
      try {
        const docs = await listDocuments({ query, pageSize: 50 });
        if (runId !== lastRunId) return; // a newer search superseded us
        if (!docs.length) {
          listEl.innerHTML = `<div class="gdoc-picker-empty">${query ? "No matches." : "No Google Docs in this account yet."}</div>`;
          return;
        }
        listEl.innerHTML = "";
        for (const d of docs) {
          const owner = d.owners?.[0]?.displayName || d.owners?.[0]?.emailAddress || "";
          const row = document.createElement("div");
          row.className = "gdoc-picker-item";
          row.innerHTML = `
            <div class="gdoc-picker-item-title">${escHtml(d.name || "Untitled")}</div>
            <div class="gdoc-picker-item-meta">${escHtml(owner)} · ${escHtml(formatModified(d.modifiedTime))}</div>
          `;
          row.addEventListener("click", () => {
            close({
              id: d.id,
              name: d.name,
              modifiedTime: d.modifiedTime,
              owner,
            });
          });
          listEl.appendChild(row);
        }
      } catch (e) {
        if (runId !== lastRunId) return;
        listEl.innerHTML = `<div class="gdoc-picker-error">${escHtml(e.message || String(e))}</div>`;
      }
    }

    searchEl.addEventListener("input", () => {
      const q = searchEl.value;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (q === activeQuery) return;
        activeQuery = q;
        runSearch(q);
      }, SEARCH_DEBOUNCE_MS);
    });

    searchEl.focus();
    runSearch("");
  });
}

function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatModified(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: now.getFullYear() === d.getFullYear() ? undefined : "numeric" });
}
