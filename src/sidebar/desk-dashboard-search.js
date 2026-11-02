/**
 * Search all Desks — the Desk Dashboard's search field, beside its close
 * button. Results drop down in a popup under the field rather than
 * replacing the grid: each one is the hit in its line (the Find panel's
 * snippet, `find-panel-search.js#lineAndSnippet`, the match marked), and
 * under it the desk and file it is in. ↑ / ↓ move through them, Enter or
 * a click opens one — on its desk, the hit selected.
 *
 * Plain, case-insensitive text. Documents are searched first, from the
 * live editor when the document is the one open and otherwise from the
 * library cache, so their results come at once; notebooks follow, their
 * text shapes read through the Find panel's loader. A notebook's envelope
 * can run to megabytes, so each is loaded once per dashboard and its
 * text kept for the next query. Trash is left out.
 */

import { findMatchesIn, lineAndSnippet } from "./find-panel-search.js";
import { loadContent } from "./find-panel-sources.js";
import { decodeNotebookContent } from "../notebook/notebook-content.ts";
import { escHtml } from "./files-panel-shared.js";
import { switchDeskAndLand } from "../state/cross-desk.js";

/** Rows the popup lists before saying how many more there are. */
const MAX_ROWS = 60;
/** Hits listed from any one file, so one long file can't fill the list. */
const PER_FILE = 5;
const DEBOUNCE_MS = 140;
const OPTS = { caseSensitive: false, wholeWord: false, useRegex: false };

const SEARCH_GLYPH = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>`;

/**
 * Put the field in `slot` and the popup in `layer` (the dashboard's
 * overlay, so the popup isn't clipped by the modal). `close` shuts the
 * dashboard before a result is opened. Returns `{ destroy }`.
 */
export function mountDashboardSearch(state, slot, layer, close) {
  slot.innerHTML = `<label class="desk-dash-search">${SEARCH_GLYPH}<input class="desk-dash-search-input" type="search"
    placeholder="Search all Desks" aria-label="Search all Desks" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" /></label>`;
  const input = slot.querySelector("input");
  const popup = document.createElement("div");
  popup.className = "desk-dash-results";
  popup.setAttribute("role", "listbox");
  popup.hidden = true;
  layer.appendChild(popup);

  const notebookText = new Map(); // fileId → [{ shapeId, text }]
  let rows = [];
  let picked = -1;
  let token = 0;
  let timer = 0;

  const hide = () => { popup.hidden = true; };
  function place() {
    const r = input.closest(".desk-dash-search").getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 440), window.innerWidth - 24);
    popup.style.top = `${r.bottom + 6}px`;
    popup.style.left = `${Math.max(12, Math.min(r.right - width, window.innerWidth - width - 12))}px`;
    popup.style.width = `${width}px`;
    popup.style.maxHeight = `${Math.max(160, window.innerHeight - r.bottom - 24)}px`;
  }

  async function run() {
    const query = input.value.trim();
    const my = ++token;
    rows = [];
    picked = -1;
    if (!query) { hide(); return; }
    const files = searchableFiles(state);
    let more = 0;
    const take = (file, hits) => {
      for (const h of hits.slice(0, PER_FILE)) {
        if (rows.length < MAX_ROWS) rows.push({ ...file, ...h, query });
        else more++;
      }
      more += Math.max(0, hits.length - PER_FILE);
    };
    // Documents: in memory already, so the first answer is immediate.
    for (const f of files.filter((f) => f.kind === "document")) {
      take(f, docHits(query, docText(state, f.fileId)));
    }
    // Notebooks: loaded once each, then kept. While any is still to
    // load, the documents' results show with a note that more may come.
    const notebooks = files.filter((f) => f.kind === "notebook");
    if (notebooks.some((f) => !notebookText.has(f.fileId))) paint(query, more, true);
    for (const f of notebooks) {
      if (!notebookText.has(f.fileId)) {
        const raw = await loadContent(state, f.fileId);
        if (my !== token) return;
        notebookText.set(f.fileId, shapeTexts(raw));
      }
      take(f, shapeHits(notebookText.get(f.fileId), query));
    }
    if (my !== token) return;
    paint(query, more, false);
  }

  function paint(query, more, loading) {
    picked = rows.length ? 0 : -1;
    const body = rows.map((r, i) => {
      const s = r.snippet;
      return `<button type="button" class="desk-dash-result${i === picked ? " picked" : ""}" role="option" data-i="${i}">
        <span class="desk-dash-result-text">${escHtml(s.leading)}${escHtml(s.prefix)}<mark>${escHtml(s.matchText)}</mark>${escHtml(s.suffix)}${escHtml(s.trailing)}</span>
        <span class="desk-dash-result-where">${escHtml(r.deskName)} · ${escHtml(r.name)}</span>
      </button>`;
    }).join("");
    const foot = loading ? `<div class="desk-dash-results-note">Searching notebooks…</div>`
      : !rows.length ? `<div class="desk-dash-results-note">No matches for “${escHtml(query)}”</div>`
      : more ? `<div class="desk-dash-results-note">${more} more not shown</div>` : "";
    popup.innerHTML = body + foot;
    place();
    popup.hidden = false;
  }

  function pick(i) {
    const els = popup.querySelectorAll(".desk-dash-result");
    if (!els.length) return;
    picked = (i + els.length) % els.length;
    els.forEach((el, k) => el.classList.toggle("picked", k === picked));
    els[picked].scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  });
  input.addEventListener("focus", () => { if (input.value.trim() && popup.innerHTML) { place(); popup.hidden = false; } });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (popup.hidden) return;
      pick(picked + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows[picked]) void open(state, rows[picked], close);
    } else if (e.key === "Escape") {
      // First Escape clears the search; the next closes the dashboard.
      e.preventDefault();
      if (input.value) { input.value = ""; token++; rows = []; hide(); }
      else close();
    }
  });
  // mousedown, not click: the field's blur would hide the popup first.
  popup.addEventListener("mousedown", (e) => {
    const el = e.target instanceof Element ? e.target.closest(".desk-dash-result") : null;
    e.preventDefault();
    if (el) void open(state, rows[Number(el.dataset.i)], close);
  });
  input.addEventListener("blur", hide);
  const onResize = () => { if (!popup.hidden) place(); };
  window.addEventListener("resize", onResize);

  return {
    destroy() {
      token++;
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
      popup.remove();
    },
  };
}

// ── Sources ───────────────────────────────────────────────────────────

/** Every document and notebook on every desk, outside its Trash, in the
 *  user's desk order: `{ fileId, name, kind, deskId, deskName }`. */
function searchableFiles(state) {
  const nodes = new Map((state.fileTree || []).filter((n) => n.type === "desk").map((n) => [n.id, n]));
  const out = [];
  for (const d of state.settings?.desks || []) {
    const desk = nodes.get(d.id);
    if (!desk) continue;
    const deskName = d.name || desk.name || "Untitled desk";
    const walk = (list) => {
      for (const n of list || []) {
        if (n.id?.startsWith("__trash__:")) continue;
        if ((n.type === "document" || n.type === "notebook") && n.fileId && !n.useAsNote) {
          out.push({ fileId: n.fileId, name: n.name || "Untitled", kind: n.type, deskId: d.id, deskName });
        }
        if (n.children?.length) walk(n.children);
      }
    };
    walk(desk.children);
  }
  return out;
}

/** A document's text: the live buffer when it is the one open (it may be
 *  ahead of the last save), else the library cache. */
function docText(state, fileId) {
  if (state.currentFileId === fileId && !state.currentProjectId && state.editor?.view) {
    return state.editor.view.state.doc.toString();
  }
  const cached = (state.files || []).find((f) => f.id === fileId)?.content;
  return typeof cached === "string" ? cached : "";
}

function docHits(query, text) {
  return findMatchesIn(text, query, OPTS).map((m, nth) => ({ nth, snippet: lineAndSnippet(text, m.from, m.to) }));
}

/** A notebook envelope's text shapes, as `[{ shapeId, text }]`. */
function shapeTexts(raw) {
  try {
    const shapes = decodeNotebookContent(raw)?.shapes;
    if (!Array.isArray(shapes)) return [];
    return shapes
      .filter((s) => s?.type === "text" && typeof s.text === "string" && !s.headerLabel)
      .map((s) => ({ shapeId: s.id, text: s.text }));
  } catch (_) { return []; }
}

function shapeHits(texts, query) {
  const out = [];
  for (const { shapeId, text } of texts || []) {
    for (const m of findMatchesIn(text, query, OPTS)) out.push({ shapeId, snippet: lineAndSnippet(text, m.from, m.to) });
  }
  return out;
}

// ── Opening a result ──────────────────────────────────────────────────

/** Close the dashboard, go to the result's desk, open its file and land
 *  on the hit: a document's nth match selected and scrolled to (counted
 *  again in the opened buffer, so an edit since the search can't send
 *  the selection somewhere stale), a notebook panned to its shape. */
async function open(state, row, close) {
  if (!row) return;
  close();
  await switchDeskAndLand(state, row.deskId);
  if (row.kind === "notebook") {
    if (state.currentNotebookFileId !== row.fileId) await state.openNotebook(row.fileId);
    const { getCanvasInstance } = await import("../notebook/notebook-bridge.js");
    const ci = await poll(() => {
      const c = getCanvasInstance?.();
      return c?.state && c.getShapes?.()?.some((s) => s.id === row.shapeId) ? c : null;
    });
    try { ci?.state.focusShape(row.shapeId); } catch (_) {}
    return;
  }
  if (state.currentFileId !== row.fileId || state.currentProjectId) await state.openFile(row.fileId);
  const view = await poll(() => (state.currentFileId === row.fileId ? state.editor?.view : null));
  if (!view) return;
  const hits = findMatchesIn(view.state.doc.toString(), row.query, OPTS);
  const hit = hits[Math.min(row.nth, hits.length - 1)];
  if (!hit) return;
  view.dispatch({ selection: { anchor: hit.from, head: hit.to }, scrollIntoView: true });
  view.focus();
}

async function poll(get, ms = 1200) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = get();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
  return null;
}
