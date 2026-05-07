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

import { escHtml } from "./files-panel-shared.js";

let _state = null;
let _container = null;
let _refreshHandlers = null;
let _outsideClickHandler = null;

const CHEVRON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
const PLUS = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
const CHECK = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const PENCIL = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
const TRASH = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

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
  _state.on("desks-changed", onDesks);
  _state.on("active-desk-changed", onActive);
  _refreshHandlers = { onDesks, onActive };
}

function detachListeners() {
  if (!_state || !_refreshHandlers) { _refreshHandlers = null; return; }
  _state.off("desks-changed", _refreshHandlers.onDesks);
  _state.off("active-desk-changed", _refreshHandlers.onActive);
  _refreshHandlers = null;
  closePopover();
}

function render() {
  if (!_container || !_state) return;
  // DEBUG: log render() calls so we can see what's churning while
  // the rename input has focus. Remove after diagnosis.
  const renaming = !!_container.querySelector(".desk-switcher-rename-input");
  if (renaming) {
    console.info("[desk-switcher] render() during rename\n", new Error().stack);
  }
  const desks = _state.settings?.desks || [];
  if (desks.length < 2) {
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
    header.innerHTML = `<span class="desk-switcher-name"></span><span class="desk-switcher-caret">${CHEVRON}</span>`;
    header.addEventListener("click", togglePopover);
    _container.insertBefore(header, _container.firstChild);
  }
  const nameSpan = header.querySelector(".desk-switcher-name");
  if (nameSpan && nameSpan.textContent !== label) nameSpan.textContent = label;
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
  const canDelete = desks.length > 1;
  const wrap = document.createElement("div");
  wrap.className = "desk-switcher-popover-body";
  wrap.innerHTML = desks.map((d) => deskRowHtml(d, activeId, canDelete)).join("") + addRowHtml();
  return wrap;
}

function deskRowHtml(d, activeId, canDelete) {
  const isActive = d.id === activeId;
  const mark = isActive ? CHECK : "";
  const pencilBtn = `<button class="desk-switcher-action" type="button" data-action="rename" data-tooltip="Rename">${PENCIL}</button>`;
  const trashBtn = canDelete
    ? `<button class="desk-switcher-action" type="button" data-action="delete" data-tooltip="Delete">${TRASH}</button>`
    : "";
  return `<div class="desk-switcher-row${isActive ? " active" : ""}" data-desk-id="${d.id}">
    <button class="desk-switcher-row-pick" type="button" data-action="pick">
      <span class="desk-switcher-row-mark">${mark}</span>
      <span class="desk-switcher-row-name">${escHtml(d.name || "Untitled desk")}</span>
    </button>
    <span class="desk-switcher-row-actions">${pencilBtn}${trashBtn}</span>
  </div>`;
}

function addRowHtml() {
  return `<button class="desk-switcher-row desk-switcher-add" type="button" data-action="add">
    <span class="desk-switcher-row-mark">${PLUS}</span>
    <span class="desk-switcher-row-name">Add desk</span>
  </button>`;
}

async function onPopoverClick(ev, popover) {
  const actionEl = ev.target.closest("[data-action]");
  if (!actionEl) return;
  ev.stopPropagation();
  const action = actionEl.dataset.action;
  if (action === "add") {
    const newId = await _state.createDesk("Untitled desk");
    await _state.setActiveDesk(newId);
    // Reopen so the user lands on a row in inline-rename mode.
    closePopover();
    setTimeout(() => { openPopover(); requestAnimationFrame(() => beginInlineRename(newId)); }, 0);
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
  } else if (action === "delete") {
    await runDeleteDesk(deskId);
  }
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
  // DEBUG: trace what causes the input to lose focus while typing.
  // Remove after diagnosis.
  input.addEventListener("focusout", (ev) => {
    console.warn("[desk-switcher] input focusout, relatedTarget:", ev.relatedTarget, "active:", document.activeElement);
  });
  input.addEventListener("input", () => {
    console.info("[desk-switcher] input keystroke, value=", input.value, "focused=", document.activeElement === input);
  });
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

async function runDeleteDesk(deskId) {
  const desk = (_state.settings.desks || []).find(d => d.id === deskId);
  const name = desk?.name || "this desk";
  const ok = window.confirm(`Delete "${name}" and everything inside it?\n\nThis cannot be undone.`);
  if (!ok) return;
  try { await _state.deleteDesk(deskId); } catch (e) { console.warn("delete desk failed:", e); }
}

function closePopover() {
  if (!_container) return;
  const popover = _container.querySelector(".desk-switcher-popover");
  if (popover) {
    // DEBUG: stack trace logged so the user can see who's calling close
    // while the rename input has focus. Remove after diagnosis.
    if (popover.querySelector(".desk-switcher-rename-input")) {
      console.warn("[desk-switcher] closePopover called while renaming\n", new Error().stack);
    }
    popover.remove();
  }
  if (_outsideClickHandler) {
    document.removeEventListener("click", _outsideClickHandler, true);
    _outsideClickHandler = null;
  }
}
