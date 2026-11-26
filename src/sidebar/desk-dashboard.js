/**
 * Desk Dashboard — every desk at a glance, in a modal grid of cards.
 * Only offered with two desks or more: the sidebar footer's grid
 * button, "Dashboard" in the desk switcher's dropdown, and the palette's
 * "View Desk Dashboard".
 *
 * Each card shows the desk's icon and name, its YOU ARE HERE marker (if
 * it has one) and the files most recently edited in it. The name is a
 * link: a click goes to the desk. On hover a small toolbar offers a new
 * Doc or Notebook in that desk's Inbox, opening the desk in a window of
 * its own, and a grip to drag the card into a new place. Desk
 * sections (`state/desk-sections.js`) run across the grid as full-width
 * label bars, with rename, delete and a grip on hover; cards and bars
 * drag among each other, and a drop commits through `commitDeskLayout`.
 *
 * Everything a card edits goes through the same calls the desk switcher
 * uses: the icon opens `change-icon.js#changeDeskIcon`, and a drop
 * commits through `state.reorderDesks`. (A desk is renamed from the desk
 * switcher; the dashboard's name is a link, not a field.) Each fires
 * `desks-changed`, which re-renders the grid — except while a section's
 * name is being typed or a card dragged, when the render waits until
 * that is done.
 *
 * Along the left runs a sidebar: at the top the recent files of every
 * desk (desk-dashboard-recents.js), and under them the To-do list — the
 * same list the double-⌘ panel shows (todo/todo-list.js), mounted here
 * while the dashboard is open, and the floating panel put away so only
 * one is live. Both its borders drag (desk-dashboard-resize.js), and
 * the sizes are kept in settings. The to-do modules are imported when a
 * dashboard opens, not at launch: the files sidebar (sidebar.js) imports
 * this module for its footer button.
 *
 * Anything that leaves the dashboard for a file goes to that file's desk
 * first (`state/cross-desk.js`), as the ⌘O picker's all-desks mode does.
 */

import { escHtml, leafIcon, typeIcons, DRAG_HANDLE_SVG } from "./files-panel-shared.js";
import { collectFileLeaves } from "../command-palette-helpers.js";
import { customIconSvg, deskIconName } from "../ui/custom-icons.js";
import { youAreHereEntriesFor, jumpToYouAreHere, markerNote } from "../you-are-here.js";
import { switchDeskAndLand, openLeafOnItsDesk } from "../state/cross-desk.js";
import { mountDashboardSearch } from "./desk-dashboard-search.js";
import { deskLayout, commitDeskLayout, renameDeskSection, deleteDeskSection } from "../state/desk-sections.js";
import { multiWindowAvailable, openDeskInNewWindow } from "../multi-window.js";
import { mountDashboardRecents } from "./desk-dashboard-recents.js";
import { wireDashboardResize } from "./desk-dashboard-resize.js";
import { wireDashboardKeys } from "./desk-dashboard-keys.js";

/** How many recently edited files a card lists. */
const RECENT_COUNT = 5;

/** Kinds that are edited (a PDF's `modified` is when it was added). */
const EDITABLE = new Set(["document", "notebook", "stack"]);

// The plain filetype glyphs, as the Add popup and a folder's menu wear
// them for New Doc / New Notebook.
const NEW_DOC = typeIcons.document;
const NEW_NOTEBOOK = typeIcons.notebook;
const PENCIL = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7.5 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V8.5"/><path d="M12.25 1.75a1.06 1.06 0 0 1 1.5 1.5L8 9l-2 .5.5-2z"/></svg>`;
const TRASH = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11"/><path d="M5.5 4V2.75a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 .75.75V4"/><path d="M12.5 4l-.6 9.1a1 1 0 0 1-1 .9H5.1a1 1 0 0 1-1-.9L3.5 4"/></svg>`;
// The forward arrow turned 45° up, pointing out of the card: open the
// desk in a window of its own. (Going to the desk here is the name.)
const OPEN_IN_WINDOW = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" transform="rotate(-45 8 8)"/></svg>`;

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
      <aside class="desk-dash-side">
        <section class="desk-dash-recents" aria-label="Recent files"></section>
        <div class="desk-dash-resizer desk-dash-row-resizer" role="separator" aria-orientation="horizontal" aria-label="Resize Recent"></div>
        <div class="desk-dash-todo" aria-label="To-do list"></div>
      </aside>
      <div class="desk-dash-resizer desk-dash-col-resizer" role="separator" aria-orientation="vertical" aria-label="Resize sidebar"></div>
      <div class="desk-dash-main">
        <div class="desk-dash-head">
          <span class="desk-dash-search-slot"></span>
          <button type="button" class="desk-dash-close" aria-label="Close">×</button>
        </div>
        <div class="desk-dash-grid"></div>
      </div>
    </div>`;
  document.body.appendChild(root);
  const grid = root.querySelector(".desk-dash-grid");
  // Before anything takes it: where the focus goes back to on close.
  const returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement : null;
  const keys = wireDashboardKeys(root, { activeDeskId: state.settings?.activeDeskId || null });

  let dragging = false;
  let pending = false;
  let lastHtml = "";
  const busy = () => dragging || !!grid.querySelector(".desk-dash-section-name:focus");

  function render() {
    if (!deskDashboardAvailable(state)) { close(); return; }
    if (busy()) { pending = true; return; }
    pending = false;
    // Saves elsewhere fire files-changed constantly; only rebuild the
    // cards when what they show has actually changed.
    const html = deskLayout(state, deskList(state))
      .map((it) => (it.kind === "section" ? sectionHtml(it.section) : cardHtml(state, it.desk))).join("");
    if (html === lastHtml) return;
    lastHtml = html;
    // Rebuilding the cards drops the focus; the keyboard's place comes back.
    const restoreFocus = keys.remember();
    grid.innerHTML = html;
    restoreFocus();
  }
  const settle = () => { if (pending) render(); };

  function close() {
    if (!open) return;
    open = null;
    window.removeEventListener("keydown", onKey, true);
    for (const ev of EVENTS) state.off(ev, render);
    search.destroy();
    recents.destroy();
    resize.destroy();
    keys.destroy();
    todo?.destroy();
    const hadFocus = root.contains(document.activeElement);
    root.remove();
    // The focus came in with the dashboard; it goes back where it was
    // (the editor, usually) unless something has claimed it since.
    if (hadFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  function onKey(e) {
    if (e.key !== "Escape") return;
    // Escape in a section's name field abandons the edit, not the
    // dashboard. The search field takes its own Escape (clear, then close).
    if (e.target instanceof Element && e.target.closest(".desk-dash-section-name, .desk-dash-search-input")) return;
    // So does the To-do list: a field's Escape leaves the field (or clears
    // its search), and any other Escape in it comes back as `onEscape`.
    if (e.target instanceof Element && e.target.closest(".desk-dash-todo")) return;
    // Inside a card's files or the Recent list, Escape steps back out to
    // the desks (desk-dashboard-keys.js); on a desk, it closes.
    if (e.target instanceof Element && e.target.closest(".desk-dash-yah, .desk-dash-file, .desk-dash-recent-file")) return;
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

  const search = mountDashboardSearch(state, root.querySelector(".desk-dash-search-slot"), root, close,
    { onLeave: () => keys.focusStart() });
  const recents = mountDashboardRecents(state, root.querySelector(".desk-dash-recents"), close);
  const resize = wireDashboardResize(state, root);
  let todo = null;
  grid.addEventListener("click", (e) => onGridClick(state, e, close));
  wireNames(state, grid, settle);
  wireReorder(state, grid, (on) => { dragging = on; if (!on) settle(); });

  const handle = { close, render };
  open = handle;
  render();
  // The keyboard starts on the desk you are on, and keys stop reaching the
  // editor behind the dashboard.
  keys.focusStart();
  void mountTodo(state, root.querySelector(".desk-dash-todo"), handle, close).then((t) => {
    if (open === handle) todo = t;
    else t?.destroy();
  });
}

/** The To-do list in the sidebar, under Recent, once its modules have loaded —
 *  unless the dashboard has closed meanwhile. The floating panel goes
 *  away first: a second live list under the dashboard would not see this
 *  one's edits (todo-list.js). */
async function mountTodo(state, el, handle, close) {
  try {
    const [{ mountTodoList }, { closeTodoPanel }] = await Promise.all([
      import("../todo/todo-list.js"), import("../todo/todo-panel.js")]);
    if (open !== handle) return null;
    closeTodoPanel();
    return mountTodoList(state, el, { embedded: true, onEscape: close, onOpenFile: close });
  } catch (err) {
    console.error("Desk Dashboard: To-do list failed to load:", err);
    return null;
  }
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
      <button type="button" class="desk-dash-name" data-action="open">${escHtml(d.name)}</button>
      ${active ? `<span class="desk-dash-current">Current</span>` : ""}
    </div>
    <div class="desk-dash-tools">
      <button type="button" data-action="new-doc" data-tooltip="New Doc in Inbox" aria-label="New Doc in Inbox">${NEW_DOC}</button>
      <button type="button" data-action="new-notebook" data-tooltip="New Notebook in Inbox" aria-label="New Notebook in Inbox">${NEW_NOTEBOOK}</button>
      ${multiWindowAvailable() ? `<button type="button" data-action="new-window" data-tooltip="Open Desk in New Window" aria-label="Open Desk in New Window">${OPEN_IN_WINDOW}</button>` : ""}
      <span class="desk-dash-grip" data-tooltip="Drag to reorder" aria-hidden="true">${DRAG_HANDLE_SVG}</span>
    </div>
    ${yahHtml}
    ${recentHtml}
  </section>`;
}

/** A section: a full-width label bar across the grid. Its name is a
 *  field (the pencil puts the caret in it). */
function sectionHtml(section) {
  return `<div class="desk-dash-section" data-section-id="${escHtml(section.id)}">
    <input class="desk-dash-section-name" type="text" value="${escHtml(section.name)}" spellcheck="false" autocomplete="off" aria-label="Section name" />
    <div class="desk-dash-section-tools">
      <button type="button" data-action="rename-section" data-tooltip="Rename" aria-label="Rename section">${PENCIL}</button>
      <button type="button" data-action="delete-section" data-tooltip="Delete section" aria-label="Delete section">${TRASH}</button>
      <span class="desk-dash-grip" data-tooltip="Drag to reorder" aria-hidden="true">${DRAG_HANDLE_SVG}</span>
    </div>
  </div>`;
}

// ── Actions ───────────────────────────────────────────────────────────

async function onGridClick(state, e, close) {
  const el = e.target instanceof Element ? e.target.closest("[data-action]") : null;
  const sectionId = el?.closest(".desk-dash-section")?.dataset.sectionId;
  if (sectionId) {
    if (el.dataset.action === "rename-section") {
      const input = el.closest(".desk-dash-section").querySelector(".desk-dash-section-name");
      input?.focus();
      input?.select();
    } else if (el.dataset.action === "delete-section") {
      await deleteDeskSection(state, sectionId);
    }
    return;
  }
  const card = el?.closest(".desk-dash-card");
  const deskId = card?.dataset.deskId;
  if (!el || !deskId) return;
  const action = el.dataset.action;
  if (action === "icon") {
    const { changeDeskIcon } = await import("./change-icon.js");
    changeDeskIcon(state, deskId);
    return;
  }
  // The desk in a window of its own: this window and the dashboard stay.
  if (action === "new-window") {
    await openDeskInNewWindow(state, deskId);
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

/** The section name fields: Enter or leaving the field renames the
 *  section, Escape puts the old name back. `settle` runs the render held
 *  off while the field had focus. */
function wireNames(state, grid, settle) {
  grid.addEventListener("keydown", (e) => {
    const input = e.target instanceof HTMLInputElement && e.target.closest(".desk-dash-section-name");
    if (!input) return;
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); input.value = input.defaultValue; input.blur(); }
  });
  grid.addEventListener("focusout", async (e) => {
    const input = e.target instanceof HTMLInputElement && e.target.closest(".desk-dash-section-name");
    if (!input) return;
    const id = input.closest(".desk-dash-section")?.dataset.sectionId;
    const next = input.value.trim();
    if (id && next && next !== input.defaultValue) await renameDeskSection(state, id, next);
    else input.value = input.defaultValue;
    settle();
  });
}

/** Drag a card — or a section bar — by its grip into a new place in the
 *  grid. Everything stays put while it moves; a rule in the gap before
 *  or after the card or bar under the pointer shows where it will land
 *  (none while the drop would leave it where it is). The drop moves the
 *  element and commits the whole order through `commitDeskLayout`,
 *  whose `desks-changed` re-renders. */
function wireReorder(state, grid, setDragging) {
  grid.addEventListener("pointerdown", (e) => {
    const grip = e.target instanceof Element ? e.target.closest(".desk-dash-grip") : null;
    const card = grip?.closest(".desk-dash-card, .desk-dash-section");
    if (!card) return;
    e.preventDefault();
    setDragging(true);
    card.classList.add("dragging");
    grid.classList.add("reordering");
    const startOrder = itemKeys(grid);
    const marker = document.createElement("div");
    marker.className = "desk-dash-drop";
    marker.hidden = true;
    grid.appendChild(marker);
    let target = null; // { card, before }

    const onMove = (me) => {
      const cards = [...grid.querySelectorAll(ITEMS)];
      const over = cards.find((c) => {
        const r = c.getBoundingClientRect();
        return me.clientX >= r.left && me.clientX <= r.right && me.clientY >= r.top && me.clientY <= r.bottom;
      });
      // In a gap between cards the last answer stands.
      if (!over) return;
      if (over === card) { target = null; marker.hidden = true; return; }
      const r = over.getBoundingClientRect();
      // One column (a narrow window) stacks the cards, so it is the upper
      // or lower half that decides, and the rule lies across the gap. A
      // section bar spans the grid, so it always reads that way.
      const stacked = over.classList.contains("desk-dash-section")
        || getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length < 2;
      const before = stacked ? me.clientY < r.top + r.height / 2 : me.clientX < r.left + r.width / 2;
      // A drop beside the card's own place moves nothing: no rule there.
      const i = cards.indexOf(over);
      const j = cards.indexOf(card);
      if ((before && i === j + 1) || (!before && i === j - 1)) { target = null; marker.hidden = true; return; }
      target = { card: over, before };
      placeMarker(grid, marker, r, before, stacked);
    };
    const onUp = async () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      marker.remove();
      card.classList.remove("dragging");
      grid.classList.remove("reordering");
      if (target) grid.insertBefore(card, target.before ? target.card : target.card.nextSibling);
      const keys = itemKeys(grid);
      // Still "dragging" while the order commits, so the render its
      // desks-changed asks for waits and then runs once, in the new order.
      try { if (keys.join() !== startOrder.join()) await commitDeskLayout(state, layoutItems(grid)); }
      finally { setDragging(false); }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
}

/** Lay the drop rule in the middle of the gap beside a card's rect `r`:
 *  upright between columns, flat between stacked cards. */
function placeMarker(grid, marker, r, before, stacked) {
  const g = grid.getBoundingClientRect();
  const cs = getComputedStyle(grid);
  const ox = grid.scrollLeft - g.left;
  const oy = grid.scrollTop - g.top;
  if (stacked) {
    const half = (parseFloat(cs.rowGap) || 14) / 2;
    marker.style.left = `${r.left + ox}px`;
    marker.style.width = `${r.width}px`;
    const y = (before ? r.top - half : r.bottom + half) + oy - 1;
    marker.style.top = `${Math.max(0, Math.min(y, grid.scrollHeight - 2))}px`;
    marker.style.height = "2px";
  } else {
    const half = (parseFloat(cs.columnGap) || 14) / 2;
    // Kept inside the grid: before the first column or after the last
    // there is no gap, and the grid clips what overflows it.
    const x = (before ? r.left - half : r.right + half) + ox - 1;
    marker.style.left = `${Math.max(0, Math.min(x, grid.scrollWidth - 2))}px`;
    marker.style.width = "2px";
    marker.style.top = `${r.top + oy}px`;
    marker.style.height = `${r.height}px`;
  }
  marker.hidden = false;
}

const ITEMS = ".desk-dash-card, .desk-dash-section";

/** The grid's cards and bars, top to bottom, as `commitDeskLayout` takes them. */
const layoutItems = (grid) => [...grid.querySelectorAll(ITEMS)].map((el) => (el.dataset.sectionId
  ? { kind: "section", id: el.dataset.sectionId }
  : { kind: "desk", id: el.dataset.deskId }));
const itemKeys = (grid) => layoutItems(grid).map((it) => `${it.kind}:${it.id}`);
