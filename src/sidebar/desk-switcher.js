/**
 * Desk switcher — sidebar header that surfaces the active desk's name
 * with a dropdown of every desk plus an "Add desk" entry. Hidden when
 * `settings.useDesks` is false.
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
  if (!_state.settings?.useDesks) {
    _container.style.display = "none";
    _container.innerHTML = "";
    return;
  }
  _container.style.display = "";
  const active = (_state.settings.desks || []).find((d) => d.id === _state.settings.activeDeskId);
  const label = active?.name || "Desk";
  _container.innerHTML = `
    <button class="desk-switcher-header" type="button">
      <span class="desk-switcher-name">${escHtml(label)}</span>
      <span class="desk-switcher-caret">${CHEVRON}</span>
    </button>
  `;
  _container.querySelector(".desk-switcher-header").addEventListener("click", togglePopover);
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
  const desks = _state.settings.desks || [];
  const activeId = _state.settings.activeDeskId;
  const rows = desks.map((d) => {
    const checked = d.id === activeId ? CHECK : "";
    return `<button class="desk-switcher-row${d.id === activeId ? " active" : ""}" type="button" data-desk-id="${d.id}">
      <span class="desk-switcher-row-mark">${checked}</span>
      <span class="desk-switcher-row-name">${escHtml(d.name || "Untitled desk")}</span>
    </button>`;
  }).join("");
  popover.innerHTML = `
    ${rows}
    <button class="desk-switcher-row desk-switcher-add" type="button" data-action="add">
      <span class="desk-switcher-row-mark">${PLUS}</span>
      <span class="desk-switcher-row-name">Add desk</span>
    </button>
  `;
  _container.appendChild(popover);

  popover.addEventListener("click", async (ev) => {
    const row = ev.target.closest(".desk-switcher-row");
    if (!row) return;
    ev.stopPropagation();
    if (row.dataset.action === "add") {
      const newId = await _state.createDesk("Untitled desk");
      await _state.setActiveDesk(newId);
      closePopover();
      // Phase 4 doesn't ship inline rename yet; the user can rename
      // via the standard tree-row rename action on the desk node.
      return;
    }
    const id = row.dataset.deskId;
    if (id) await _state.setActiveDesk(id);
    closePopover();
  });

  // Capture-phase outside-click closes the popover. We attach on the
  // next tick so the click that opened it doesn't immediately close.
  setTimeout(() => {
    _outsideClickHandler = (e) => {
      if (!_container?.contains(e.target)) closePopover();
    };
    document.addEventListener("click", _outsideClickHandler, true);
  }, 0);
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
