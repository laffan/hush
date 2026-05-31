/**
 * Switch Desks modal — small picker over every desk in the library.
 *
 * `openSwitchDeskModal(state)` shows one row per desk, highlights the
 * current active desk, and switches via `state.setActiveDesk(id)` on
 * pick. No-ops when there's only one desk (the command palette already
 * hides itself in that case, but the guard makes the helper safe to
 * call from anywhere — e.g. a keyboard shortcut bound to the same
 * action).
 */

import { escHtml } from "./files-panel-shared.js";

let _overlayEl = null;

export function openSwitchDeskModal(state) {
  const desks = state.settings?.desks || [];
  if (desks.length < 2) return;
  closeModal();

  const activeId = state.settings?.activeDeskId;
  const rows = desks.map((d) => {
    const isActive = d.id === activeId;
    return `<button class="switch-desk-row${isActive ? " is-active" : ""}" type="button" data-desk-id="${d.id}">
      <span class="switch-desk-name">${escHtml(d.name || "Untitled desk")}</span>
      ${isActive ? '<span class="switch-desk-current">current</span>' : ""}
    </button>`;
  }).join("");

  const overlay = document.createElement("div");
  overlay.className = "switch-desk-overlay";
  overlay.innerHTML = `
    <div class="switch-desk-modal">
      <div class="switch-desk-title">Switch desks</div>
      <div class="switch-desk-list">${rows}</div>
      <div class="switch-desk-actions">
        <button class="switch-desk-cancel" type="button">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  _overlayEl = overlay;

  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  overlay.querySelector(".switch-desk-cancel").addEventListener("click", closeModal);
  overlay.querySelectorAll(".switch-desk-row").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.deskId;
      closeModal();
      if (id && id !== activeId && typeof state.setActiveDesk === "function") {
        try { await state.setActiveDesk(id); } catch (e) { console.error("setActiveDesk failed:", e); }
      }
    });
  });
  document.addEventListener("keydown", onKey, true);
  // Focus the first non-active row so arrow / enter navigation works without a click.
  const firstRow = overlay.querySelector(".switch-desk-row:not(.is-active)")
    || overlay.querySelector(".switch-desk-row");
  if (firstRow) firstRow.focus();
}

function onKey(e) {
  if (e.key === "Escape") {
    closeModal();
    e.stopPropagation();
  }
}

function closeModal() {
  if (_overlayEl?.parentNode) _overlayEl.parentNode.removeChild(_overlayEl);
  _overlayEl = null;
  document.removeEventListener("keydown", onKey, true);
}
