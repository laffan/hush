/**
 * Desk Dashboard — every desk at a glance, in a modal grid of cards.
 * Only offered with two desks or more: the sidebar footer's grid
 * button, "Dashboard" in the desk switcher's dropdown, and the palette's
 * "View Desk Dashboard".
 *
 * Each card shows the desk's icon and name, its YOU ARE HERE marker (if
 * it has one) and the files most recently edited in it. On hover a small
 * toolbar offers a new Doc or Notebook in that desk's Inbox, opening the
 * desk itself, and a grip to drag the card into a new place.
 *
 * Everything a card edits goes through the same calls the desk switcher
 * uses: the name is an input committed through `state.renameDesk` (with
 * the switcher's rule that a local desk can't be renamed on iOS), the
 * icon opens `change-icon.js#changeDeskIcon`, and a drop commits through
 * `state.reorderDesks`. Each fires `desks-changed`, which re-renders the
 * grid — except while a name is being typed or a card dragged, when the
 * render waits until that is done.
 *
 * Anything that leaves the dashboard for a file goes to that file's desk
 * first (`state/cross-desk.js`), as the ⌘O picker's all-desks mode does.
 */

import { escHtml, leafIcon, typeIcons, DRAG_HANDLE_SVG } from "./files-panel-shared.js";
import { isDesktopTauri, collectFileLeaves } from "../command-palette-helpers.js";
import { customIconSvg, deskIconName } from "../ui/custom-icons.js";
import { youAreHereEntriesFor, jumpToYouAreHere, markerNote } from "../you-are-here.js";
import { switchDeskAndLand, openLeafOnItsDesk } from "../state/cross-desk.js";
import { mountDashboardSearch } from "./desk-dashboard-search.js";

/** How many recently edited files a card lists. */
const RECENT_COUNT = 5;

/** Kinds that are edited (a PDF's `modified` is when it was added). */
const EDITABLE = new Set(["document", "notebook", "stack"]);

const NEW_DOC = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V5.5z"/><path d="M9.5 2v3.5H13"/><path d="M8 7.5v4M6 9.5h4"/></svg>`;
const NEW_NOTEBOOK = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="4" r="1"/><circle cx="8" cy="4" r="1"/><circle cx="12" cy="4" r="1"/><circle cx="4" cy="8" r="1"/><circle cx="4" cy="12" r="1"/><path d="M10.5 8.5v5M8 11h5"/></svg>`;
const OPEN_DESK = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10"/><path d="M9 2h5v5M14 2 7.5 8.5"/></svg>`;

/** The 2 × 2 grid glyph the sidebar footer's button wears. */
export const DASHBOARD_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6.5" height="6.5" rx="1.25"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.25"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.25"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.25"/></svg>`;

let open = null; // the live dashboard's handle

/** The dashboard is offered only while there is more than one desk. */
export function deskDashboardAvailable(state) {
  return (state.settings?.desks || []).length >= 2;
}

export function closeDeskDashboard() {
  open?.close();
}

export function openDeskDashboard(state) {
  if (open) { open.render(); return; }
  if (!deskDashboardAvailable(state)) return;

  const root = document.createElement("div");
  root.className = "desk-dash-overlay";
  root.innerHTML = `
    <div class="desk-dash" role="dialog" aria-modal="true" aria-label="Desk dashboard">
      <div class="desk-dash-head">
        <span class="desk-dash-title">Desks</span>
        <span class="desk-dash-search-slot"></span>
        <button type="button" class="desk-dash-close" aria-label="Close">×</button>
      </div>
      <div class="desk-dash-grid"></div>
    </div>`;
  document.body.appendChild(root);
  const grid = root.querySelector(".desk-dash-grid");

  let dragging = false;
  let pending = false;
  const busy = () => dragging || !!grid.querySelector(".desk-dash-name:focus");

  function render() {
    if (!deskDashboardAvailable(state)) { close(); return; }
    if (busy()) { pending = true; return; }
    pending = false;
    grid.innerHTML = deskList(state).map((d) => cardHtml(state, d)).join("");
  }
  const settle = () => { if (pending) render(); };

  function close() {
    if (!open) return;
    open = null;
    window.removeEventListener("keydown", onKey, true);
    for (const ev of EVENTS) state.off(ev, render);
    search.destroy();
    root.remove();
  }
  function onKey(e) {
    if (e.key !== "Escape") return;
    // Escape in a name field abandons the edit, not the dashboard.
    // The search field takes its own Escape (clear, then close).
    if (e.target instanceof Element && e.target.closest(".desk-dash-name, .desk-dash-search-input")) return;
    // A modal opened over the dashboard (the icon picker, a name prompt)
    // takes its own Escape.
    if (document.querySelector(".tree-delete-modal-backdrop")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  }

  const EVENTS = ["desks-changed", "active-desk-changed", "files-changed", "you-are-here-changed", "desk-roots-changed"];
  for (const ev of EVENTS) state.on(ev, render);
  window.addEventListener("keydown", onKey, true);
  root.addEventListener("pointerdown", (e) => { if (e.target === root) close(); });
  root.querySelector(".desk-dash-close").addEventListener("click", close);
  // Keys stay in the modal — the window-level shortcut fallback must not
  // hear them.
  root.addEventListener("keydown", (e) => e.stopPropagation());

  const search = mountDashboardSearch(state, root.querySelector(".desk-dash-search-slot"), root, close);
  grid.addEventListener("click", (e) => onGridClick(state, e, close));
  wireNames(state, grid, settle);
  wireReorder(state, grid, (on) => { dragging = on; if (!on) settle(); });

  open = { close, render };
  render();
}

// ── Rendering ─────────────────────────────────────────────────────────

/** Desks in the user's order, each with the tree node that holds its files. */
function deskList(state) {
  const nodes = new Map((state.fileTree || []).filter((n) => n.type === "desk").map((n) => [n.id, n]));
  return (state.settings?.desks || [])
    .map((d) => ({ id: d.id, name: d.name || nodes.get(d.id)?.name || "Untitled desk", node: nodes.get(d.id) }))
    .filter((d) => d.node);
}

/** The desk's files, most recently edited first — its documents,
 *  notebooks and stacks, leaving out what is in its Archive or Trash. */
function recentlyEdited(state, deskNode) {
  const modified = new Map((state.files || []).map((f) => [f.id, f.modified || 0]));
  const kids = (deskNode.children || []).filter((n) =>
    !n.id?.startsWith("__archive__:") && !n.id?.startsWith("__trash__:"));
  return collectFileLeaves(kids)
    .filter((f) => EDITABLE.has(f.type) && modified.has(f.fileId))
    .map((f) => ({ ...f, at: modified.get(f.fileId) }))
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_COUNT);
}

/** "now", "5m", "3h", "2d", else a short date. `at` is in seconds. */
function ago(at) {
  if (!at) return "";
  const s = Math.max(0, Date.now() / 1000 - at);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(at * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The note the marker carries (`YOUAREHERE: …`), read from the live
 *  editor when the marker's document is the one open, else from the
 *  library's cached copy. Documents only: a notebook's text lives in its
 *  envelope, which the cache doesn't hold and the dashboard won't load. */
function yahNote(state, entry) {
  if (entry.fileType !== "document") return "";
  const live = state.currentFileId === entry.fileId && !state.currentProjectId
    ? state.editor?.view?.state.doc.toString()
    : null;
  const text = live ?? (state.files || []).find((f) => f.id === entry.fileId)?.content;
  return markerNote(text);
}

function cardHtml(state, d) {
  const active = d.id === state.settings?.activeDeskId;
  const icon = deskIconName(state, d.id);
  const glyph = icon ? customIconSvg(icon) : typeIcons.desk;
  // A local desk is named by its folder, and iOS won't let Hush rename
  // that folder (see desk-switcher.js) — the name stays read-only there.
  const isLocal = !!state.deskRoots?.[d.id];
  const lockName = isLocal && !isDesktopTauri();
  const nameTip = isLocal ? (lockName ? "" : "Rename (renames the folder too)") : "Rename";

  const yah = youAreHereEntriesFor(state, [d.id])[0];
  const note = yah ? yahNote(state, yah) : "";
  const yahHtml = yah
    ? `<button type="button" class="desk-dash-yah" data-action="yah">
        <span class="desk-dash-yah-line"><span class="yah-badge">YOU ARE HERE</span><span class="desk-dash-yah-file">${escHtml(yah.fileName)}</span></span>
        ${note ? `<span class="desk-dash-yah-note">${escHtml(note)}</span>` : ""}
      </button>`
    : "";

  const recent = recentlyEdited(state, d.node);
  const recentHtml = recent.length
    ? `<ul class="desk-dash-recent">${recent.map((f) => `
        <li><button type="button" class="desk-dash-file" data-action="file" data-file-id="${escHtml(f.fileId)}" data-type="${f.type}">
          ${leafIcon(f)}<span class="desk-dash-file-name">${escHtml(f.name)}</span><span class="desk-dash-file-time">${ago(f.at)}</span>
        </button></li>`).join("")}</ul>`
    : `<div class="desk-dash-empty">Nothing edited yet</div>`;

  return `<section class="desk-dash-card${active ? " active" : ""}" data-desk-id="${escHtml(d.id)}">
    <div class="desk-dash-card-head">
      <button type="button" class="desk-dash-icon${icon ? " has-icon" : ""}" data-action="icon" data-tooltip="Change icon" aria-label="Change icon">${glyph}</button>
      <input class="desk-dash-name" type="text" value="${escHtml(d.name)}" spellcheck="false" autocomplete="off"
        aria-label="Desk name"${nameTip ? ` data-tooltip="${nameTip}"` : ""}${lockName ? " readonly" : ""} />
      ${active ? `<span class="desk-dash-current">Current</span>` : ""}
    </div>
    <div class="desk-dash-tools">
      <button type="button" data-action="new-doc" data-tooltip="New Doc in Inbox" aria-label="New Doc in Inbox">${NEW_DOC}</button>
      <button type="button" data-action="new-notebook" data-tooltip="New Notebook in Inbox" aria-label="New Notebook in Inbox">${NEW_NOTEBOOK}</button>
      <button type="button" data-action="open" data-tooltip="Open desk" aria-label="Open desk">${OPEN_DESK}</button>
      <span class="desk-dash-grip" data-tooltip="Drag to reorder" aria-hidden="true">${DRAG_HANDLE_SVG}</span>
    </div>
    ${yahHtml}
    ${recentHtml}
  </section>`;
}

// ── Actions ───────────────────────────────────────────────────────────

async function onGridClick(state, e, close) {
  const el = e.target instanceof Element ? e.target.closest("[data-action]") : null;
  const card = el?.closest(".desk-dash-card");
  const deskId = card?.dataset.deskId;
  if (!el || !deskId) return;
  const action = el.dataset.action;
  if (action === "icon") {
    const { changeDeskIcon } = await import("./change-icon.js");
    changeDeskIcon(state, deskId);
    return;
  }
  // Everything else leaves the dashboard for the desk.
  close();
  if (action === "file") {
    await openLeafOnItsDesk(state, { fileId: el.dataset.fileId, type: el.dataset.type, deskId });
  } else if (action === "yah") {
    const entry = youAreHereEntriesFor(state, [deskId])[0];
    if (!entry) return;
    await switchDeskAndLand(state, deskId);
    await jumpToYouAreHere(state, entry);
  } else if (action === "open") {
    await switchDeskAndLand(state, deskId);
  } else if (action === "new-doc") {
    await switchDeskAndLand(state, deskId);
    await state.newFile();
  } else if (action === "new-notebook") {
    await switchDeskAndLand(state, deskId);
    const { promptNewNotebookName } = await import("../command-palette-pickers.js");
    promptNewNotebookName((name) => state.createNotebook(name));
  }
}

/** The name fields: Enter or leaving the field renames the desk, Escape
 *  puts the old name back. `settle` runs the render held off while the
 *  field had focus. */
function wireNames(state, grid, settle) {
  grid.addEventListener("keydown", (e) => {
    const input = e.target instanceof HTMLInputElement && e.target.closest(".desk-dash-name");
    if (!input) return;
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); input.value = input.defaultValue; input.blur(); }
  });
  grid.addEventListener("focusout", async (e) => {
    const input = e.target instanceof HTMLInputElement && e.target.closest(".desk-dash-name");
    if (!input) return;
    const deskId = input.closest(".desk-dash-card")?.dataset.deskId;
    const next = input.value.trim();
    const prev = input.defaultValue;
    if (deskId && next && next !== prev) {
      // A local desk's rename goes out to the filesystem and can fail in
      // ways the user has to hear about (a name already taken).
      try { await state.renameDesk(deskId, next); }
      catch (err) {
        console.warn("rename desk failed:", err);
        input.value = prev;
        window.alert(String(err?.message || err));
      }
    } else {
      input.value = prev;
    }
    settle();
  });
}

/** Drag a card by its grip into a new place in the grid. The cards move
 *  live under the pointer; the drop commits the order through
 *  `state.reorderDesks`, whose `desks-changed` re-renders the grid. */
function wireReorder(state, grid, setDragging) {
  grid.addEventListener("pointerdown", (e) => {
    const grip = e.target instanceof Element ? e.target.closest(".desk-dash-grip") : null;
    const card = grip?.closest(".desk-dash-card");
    if (!card) return;
    e.preventDefault();
    setDragging(true);
    card.classList.add("dragging");
    grid.classList.add("reordering");
    const startOrder = cardIds(grid);
    const onMove = (me) => {
      const over = [...grid.querySelectorAll(".desk-dash-card")].find((c) => {
        if (c === card) return false;
        const r = c.getBoundingClientRect();
        return me.clientX >= r.left && me.clientX <= r.right && me.clientY >= r.top && me.clientY <= r.bottom;
      });
      if (!over) return;
      const r = over.getBoundingClientRect();
      // Before or after the card under the pointer, by which half of it
      // the pointer is in (reading order: left half goes before).
      const before = me.clientX < r.left + r.width / 2;
      grid.insertBefore(card, before ? over : over.nextSibling);
    };
    const onUp = async () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      card.classList.remove("dragging");
      grid.classList.remove("reordering");
      const ids = cardIds(grid);
      // Still "dragging" while the order commits, so the render its
      // desks-changed asks for waits and then runs once, in the new order.
      try { if (ids.join() !== startOrder.join()) await state.reorderDesks(ids); }
      finally { setDragging(false); }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
}

const cardIds = (grid) => [...grid.querySelectorAll(".desk-dash-card")].map((c) => c.dataset.deskId);
