/**
 * Desk switcher — sidebar header that surfaces the active desk's name
 * with a dropdown of every desk plus an "Add desk" entry. Hidden when
 * the user only has one desk (the structural default) so single-desk
 * sessions don't carry an empty-looking switcher.
 *
 * The header is mounted above the create-buttons row in the files
 * panel. Clicking the header toggles a popover with one row per desk
 * (active marker, click to switch) and an "Add desk" row that creates
 * a new "Untitled desk" and immediately puts its row into rename mode.
 *
 * The component listens for `desks-changed` and `active-desk-changed`
 * to refresh in place; outside clicks dismiss the popover.
 */

import { escHtml, DRAG_HANDLE_SVG, deskRatchetGlyph } from "./files-panel-shared.js";

let _state = null;
let _container = null;
let _refreshHandlers = null;
let _outsideClickHandler = null;

const CHEVRON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
const PLUS = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
const CHECK = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const PENCIL = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
// Archive box, not a trash can — a desk is put away here, not destroyed.
const ARCHIVE_BOX = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="4" rx="1"/><path d="M4 8v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8"/><line x1="10" y1="13" x2="14" y2="13"/></svg>`;

export function mountDeskSwitcher(parent, state) {
  unmountDeskSwitcher();
  _state = state;
  _container = document.createElement("div");
  _container.className = "desk-switcher";
  parent.insertBefore(_container, parent.firstChild);
  render();
  attachListeners();
}

export function unmountDeskSwitcher() {
  detachListeners();
  if (_container?.parentNode) _container.parentNode.removeChild(_container);
  _container = null;
  _state = null;
}

function attachListeners() {
  if (!_state) return;
  const onDesks = () => render();
  const onActive = () => render();
  // The "show all desks" toggle lives in settings; re-render so the
  // switcher hides itself when that view takes over (the desk list in
  // the panel becomes the switcher there).
  const onSettings = () => render();
  _state.on("desks-changed", onDesks);
  _state.on("active-desk-changed", onActive);
  _state.on("settings-changed", onSettings);
  _state.on("desk-roots-changed", onDesks);
  _refreshHandlers = { onDesks, onActive, onSettings };
}

function detachListeners() {
  if (!_state || !_refreshHandlers) { _refreshHandlers = null; return; }
  _state.off("desks-changed", _refreshHandlers.onDesks);
  _state.off("active-desk-changed", _refreshHandlers.onActive);
  _state.off("settings-changed", _refreshHandlers.onSettings);
  _state.off("desk-roots-changed", _refreshHandlers.onDesks);
  _refreshHandlers = null;
  closePopover();
}

function render() {
  if (!_container || !_state) return;
  const desks = _state.settings?.desks || [];
  // Hidden when there's nothing to switch (single desk) or when the
  // all-desks panel view is active (the desk rows there replace it).
  if (desks.length < 2 || _state.settings?.deskDisplayMode === "all") {
    _container.style.display = "none";
    _container.innerHTML = "";
    return;
  }
  _container.style.display = "";
  const active = desks.find((d) => d.id === _state.settings.activeDeskId);
  const label = active?.name || "Desk";
  // Update the header in place rather than nuking _container.innerHTML
  // — that would destroy any open popover (and the rename input inside
  // it). A sync apply firing desks-changed while the user is renaming
  // a desk would otherwise close the popover before they could press
  // Enter, losing the typed value.
  let header = _container.querySelector(".desk-switcher-header");
  if (!header) {
    header = document.createElement("button");
    header.className = "desk-switcher-header";
    header.type = "button";
    header.innerHTML = `<span class="desk-switcher-title"><span class="desk-switcher-name"></span><span class="desk-switcher-ratchet"></span></span><span class="desk-switcher-caret">${CHEVRON}</span>`;
    header.addEventListener("click", togglePopover);
    _container.insertBefore(header, _container.firstChild);
  }
  const nameSpan = header.querySelector(".desk-switcher-name");
  if (nameSpan && nameSpan.textContent !== label) nameSpan.textContent = label;
  // Ratchet badge for the desk the header is showing — the mode is
  // persistent, so the closed switcher has to carry it too.
  const ratchetSpan = header.querySelector(".desk-switcher-ratchet");
  const ratchetMark = active ? deskRatchetGlyph(_state, active.id) : "";
  if (ratchetSpan && ratchetSpan.innerHTML !== ratchetMark) ratchetSpan.innerHTML = ratchetMark;
  // Refresh the popover body too, but only when one is open AND no
  // rename input is active. The active-rename case is left alone so
  // typing isn't interrupted; the user's commit (Enter / blur / Esc)
  // closes the popover normally and the next open will pick up the
  // new desk list.
  const popover = _container.querySelector(".desk-switcher-popover");
  if (popover && !popover.querySelector(".desk-switcher-rename-input")) {
    const fresh = buildPopoverBody(_state);
    popover.innerHTML = "";
    popover.appendChild(fresh);
  }
}

function togglePopover(e) {
  e?.stopPropagation();
  const open = _container.querySelector(".desk-switcher-popover");
  if (open) { closePopover(); return; }
  openPopover();
}

function openPopover() {
  if (!_container || !_state) return;
  closePopover();
  const popover = document.createElement("div");
  popover.className = "desk-switcher-popover";
  popover.appendChild(buildPopoverBody(_state));
  _container.appendChild(popover);

  popover.addEventListener("click", (ev) => onPopoverClick(ev, popover));
  attachReorder(popover);

  // Capture-phase outside-click closes the popover. We attach on the
  // next tick so the click that opened it doesn't immediately close.
  setTimeout(() => {
    _outsideClickHandler = (e) => {
      if (!_container?.contains(e.target)) closePopover();
    };
    document.addEventListener("click", _outsideClickHandler, true);
  }, 0);
}

function buildPopoverBody(state) {
  const desks = state.settings.desks || [];
  const activeId = state.settings.activeDeskId;
  // The last desk stays: the tree must always carry at least one.
  const canArchive = desks.length > 1;
  const wrap = document.createElement("div");
  wrap.className = "desk-switcher-popover-body";
  const roots = _state?.deskRoots || {};
  wrap.innerHTML = desks.map((d) => deskRowHtml(d, activeId, canArchive, !!roots[d.id])).join("") + addRowHtml();
  return wrap;
}

function deskRowHtml(d, activeId, canArchive, isLocal = false) {
  const isActive = d.id === activeId;
  const mark = isActive ? CHECK : "";
  // Desks in Ratchet mode wear the ratchet glyph after their name.
  const ratchetGlyph = deskRatchetGlyph(_state, d.id);
  // Local desks (operating from a user-picked folder) wear a small
  // outline-square glyph after the name — the same shape Local Folder
  // mounts use in the files tree.
  const localGlyph = isLocal
    ? `<svg viewBox="0 0 16 16" class="desk-switcher-local-glyph" data-tooltip="Local desk"><rect x="2" y="2" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`
    : "";
  // A local desk is named by its folder, so there's nothing to rename
  // here — the pencil is dropped rather than shown disabled.
  const pencilBtn = isLocal
    ? ""
    : `<button class="desk-switcher-action" type="button" data-action="rename" data-tooltip="Rename">${PENCIL}</button>`;
  const archiveBtn = canArchive
    ? `<button class="desk-switcher-action" type="button" data-action="archive" data-tooltip="Archive">${ARCHIVE_BOX}</button>`
    : "";
  const handle = `<span class="desk-switcher-drag-handle" data-action="drag" data-tooltip="Drag to reorder">${DRAG_HANDLE_SVG}</span>`;
  return `<div class="desk-switcher-row${isActive ? " active" : ""}" data-desk-id="${d.id}">
    <button class="desk-switcher-row-pick" type="button" data-action="pick">
      <span class="desk-switcher-row-mark">${mark}</span>
      <span class="desk-switcher-row-name">${escHtml(d.name || "Untitled desk")}</span>${ratchetGlyph}${localGlyph}
    </button>
    <span class="desk-switcher-row-actions">${handle}${pencilBtn}${archiveBtn}</span>
  </div>`;
}

function addRowHtml() {
  return `<button class="desk-switcher-row desk-switcher-add" type="button" data-action="add">
    <span class="desk-switcher-row-mark">${PLUS}</span>
    <span class="desk-switcher-row-name">Add desk</span>
  </button>`;
}

async function onPopoverClick(ev, popover) {
  // While a rename input is open, route everything to it. The input
  // lives inside the row's `<button data-action="pick">`, and browsers
  // synthesize a click on that button when Space is pressed on a child
  // input — without this guard the synthesized click bubbles here and
  // closes the popover mid-rename.
  if (popover.querySelector(".desk-switcher-rename-input")) {
    ev.stopPropagation();
    return;
  }
  const actionEl = ev.target.closest("[data-action]");
  if (!actionEl) return;
  ev.stopPropagation();
  const action = actionEl.dataset.action;
  if (action === "add") {
    // The Internal / Local fork owns creation now (see new-desk-flow.js).
    // The popover has to close first — the flow's modal takes over the
    // screen — and reopens on the way out so the new desk is visible.
    closePopover();
    const { startNewDeskFlow } = await import("./new-desk-flow.js");
    const newId = await startNewDeskFlow(_state, {
      // Only an internal desk lands in inline-rename mode; a local desk
      // is named by its folder and can't be renamed at all.
      onCreated: (id, kind) => {
        if (kind !== "internal") return;
        setTimeout(() => { openPopover(); requestAnimationFrame(() => beginInlineRename(id)); }, 0);
      },
    });
    // Backed out — put the popover back where it was.
    if (!newId) setTimeout(() => openPopover(), 0);
    return;
  }
  const row = actionEl.closest(".desk-switcher-row");
  const deskId = row?.dataset.deskId;
  if (!deskId) return;
  if (action === "pick") {
    await _state.setActiveDesk(deskId);
    closePopover();
  } else if (action === "rename") {
    beginInlineRename(deskId);
  } else if (action === "archive") {
    closePopover();
    import("./desk-archive.js").then((m) => m.confirmArchiveDesk(_state, deskId));
  }
}

/** Wire pointer-drag reordering off the per-row drag handles. Reorders
 *  the rows in place during the drag, then commits the new order via
 *  `state.reorderDesks` on pointer-up (which fires desks-changed and
 *  rebuilds the popover body in the committed order). */
function attachReorder(popover) {
  popover.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest(".desk-switcher-drag-handle");
    if (!handle) return;
    const row = handle.closest(".desk-switcher-row[data-desk-id]");
    if (!row) return;
    // While a rename input is open we leave reordering alone.
    if (popover.querySelector(".desk-switcher-rename-input")) return;
    e.preventDefault();
    e.stopPropagation();
    startRowDrag(popover, row);
  });
}

function startRowDrag(popover, row) {
  const body = row.parentElement;
  if (!body) return;
  row.classList.add("dragging");
  const dataRows = () => [...body.querySelectorAll(".desk-switcher-row[data-desk-id]")];
  const onMove = (e) => {
    const target = dataRows().find((r) => {
      if (r === row) return false;
      const rect = r.getBoundingClientRect();
      return e.clientY < rect.top + rect.height / 2;
    });
    if (target) { body.insertBefore(row, target); return; }
    const addRow = body.querySelector(".desk-switcher-add");
    if (addRow) body.insertBefore(row, addRow); else body.appendChild(row);
  };
  const onUp = () => {
    row.classList.remove("dragging");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    const ids = dataRows().map((r) => r.dataset.deskId);
    _state?.reorderDesks(ids);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function beginInlineRename(deskId) {
  if (!_container) return;
  const row = _container.querySelector(`.desk-switcher-row[data-desk-id="${deskId}"]`);
  if (!row) return;
  const nameEl = row.querySelector(".desk-switcher-row-name");
  const current = nameEl?.textContent || "";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "desk-switcher-rename-input";
  input.value = current;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  // The input lives inside the row's `<button data-action="pick">`,
  // so a click that lands on it would otherwise bubble up to the
  // popover handler and be interpreted as "pick this desk" — closing
  // the popover before the user can press Enter. Stop click /
  // mousedown / keydown from bubbling so the row's pick / outside-click
  // chain doesn't fire while the user is editing.
  const stop = (ev) => ev.stopPropagation();
  input.addEventListener("click", stop);
  input.addEventListener("mousedown", stop);
  let committing = false;
  const commit = async (save) => {
    if (committing) return;
    committing = true;
    const next = input.value.trim();
    if (save && next && next !== current) {
      try { await _state.renameDesk(deskId, next); } catch (e) { console.warn("rename desk failed:", e); }
    }
    // The desks-changed listener re-renders the header; reopen the
    // popover after a save so the user sees the result.
    closePopover();
    if (save) openPopover();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commit(true); }
    else if (e.key === "Escape") { e.preventDefault(); commit(false); }
  });
  input.addEventListener("blur", () => commit(true));
}

function closePopover() {
  if (!_container) return;
  const popover = _container.querySelector(".desk-switcher-popover");
  if (popover) popover.remove();
  if (_outsideClickHandler) {
    document.removeEventListener("click", _outsideClickHandler, true);
    _outsideClickHandler = null;
  }
}
