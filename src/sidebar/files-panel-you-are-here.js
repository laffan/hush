/**
 * The sidebar's YOU ARE HERE row — one red `YOU ARE HERE : <filename>`
 * chip for the desk the user is actually on. Clicking jumps to the file
 * AND to the marker's position inside it (doc scroll / notebook pan).
 * Split out of files-panel.js for the 700-line cap.
 *
 * Where the row lands depends on the panel view, because "you are here"
 * is a statement about *this* desk and has to read as one:
 *
 * - Single-desk view — pinned above the Flagged list, at the top of the
 *   panel, rendered by `renderYouAreHereRows` from the Flagged section.
 * - All-desks view — nested under the active desk's own row, directly
 *   beneath its title (`renderDeskYouAreHere`). Every desk's marker
 *   stacked at the top of the panel said nothing about which desk you
 *   were on, which is the only thing the row is for.
 */
import { escHtml } from "./files-panel-shared.js";
import { isAllDesksMode } from "./files-panel-rows.js";
import { youAreHereEntriesFor, deskIdOfOpenFile, jumpToYouAreHere } from "../you-are-here.js";

/** The desks whose markers the panel may show: the active desk, plus the
 *  open file's desk when it differs — a torn restore can show a marker
 *  doc in the editor while the sidebar browses another desk, and the row
 *  must not hide then. Never every desk: see the module header. */
function currentDeskIds(state) {
  const ids = [state.getActiveDesk?.()?.id].filter(Boolean);
  const openDesk = deskIdOfOpenFile(state);
  if (openDesk && !ids.includes(openDesk)) ids.push(openDesk);
  return ids;
}

/** Build the `<li>` for one marker entry. */
function buildRow(state, entry, hidePanel) {
  const li = document.createElement("li");
  li.className = "sl-item yah-row";
  const content = document.createElement("div");
  content.className = "sl-item-content";
  const spacer = document.createElement("button");
  spacer.className = "sl-fold-arrow sl-fold-empty";
  spacer.type = "button";
  spacer.tabIndex = -1;
  content.appendChild(spacer);
  const label = document.createElement("span");
  label.className = "sl-item-label";
  const main = document.createElement("span");
  main.className = "sl-item-main-label";
  const row = document.createElement("span");
  row.className = "tree-item-row";
  row.innerHTML = `<span class="yah-badge">YOU ARE HERE : ${escHtml(entry.fileName)}</span>`;
  main.appendChild(row);
  label.appendChild(main);
  content.appendChild(label);
  li.appendChild(content);
  content.addEventListener("click", () => {
    void jumpToYouAreHere(state, entry);
    const isInset = document.querySelector("#panel-overlay")?.classList.contains("panel-inset");
    if (!isInset && hidePanel) hidePanel();
  });
  // Nested under a desk the row sits *inside* the SortableList's
  // container and wears `.sl-item`, but it is not one of its items (no
  // `data-path`). Swallow pointerdown so the list never tries to start a
  // drag from it; the click listener above is unaffected.
  li.addEventListener("pointerdown", (e) => e.stopPropagation());
  return li;
}

/** Append the marker row (if any) to `containerEl` — the Flagged
 *  section's host. No-op in the all-desks view, where the row belongs
 *  under its desk instead (`renderDeskYouAreHere`). */
export function renderYouAreHereRows(state, containerEl, hidePanel) {
  if (isAllDesksMode(state)) return;
  let entries = [];
  try {
    entries = youAreHereEntriesFor(state, currentDeskIds(state));
  } catch (_) { return; }
  for (const entry of entries) containerEl.appendChild(buildRow(state, entry, hidePanel));
}

/** All-desks view: hang the active desk's marker row directly under that
 *  desk's title. Called after every SortableList render (which wipes the
 *  list wholesale), beside the Local Folders re-placement. */
export function renderDeskYouAreHere(state, treeListEl, hidePanel) {
  if (!treeListEl) return;
  // Clear whatever a previous render left behind before deciding again —
  // a desk switch or a view-mode flip moves the row.
  for (const stale of treeListEl.querySelectorAll(".yah-row.yah-desk-row")) stale.remove();
  if (!isAllDesksMode(state)) return;
  let entries = [];
  try {
    entries = youAreHereEntriesFor(state, currentDeskIds(state));
  } catch (_) { return; }
  if (!entries.length) return;
  for (const entry of entries) {
    const sel = window.CSS?.escape ? CSS.escape(entry.deskId) : entry.deskId;
    const deskLi = treeListEl.querySelector(`:scope > .sl-item[data-id="${sel}"]`);
    if (!deskLi) continue;
    // A collapsed desk renders no child list; the row would have nowhere
    // to sit under the title, so it waits for the desk to be opened.
    const childList = deskLi.querySelector(":scope > .sl-list");
    if (!childList) continue;
    const li = buildRow(state, entry, hidePanel);
    li.classList.add("yah-desk-row");
    childList.insertBefore(li, childList.firstChild);
  }
}
