/**
 * Shared helpers for the files panel and its sibling sub-modules
 * (files-panel-local-sync.js, etc.). Keeping these in their own file
 * avoids circular imports between files-panel.js and modules that
 * render rows on its behalf.
 */

// SVG icons for the tree-item types
export const typeIcons = {
  document: `<svg viewBox="0 0 16 16" class="tree-type-icon"><line x1="4" y1="4" x2="12" y2="4" /><line x1="4" y1="8" x2="12" y2="8" /><line x1="4" y1="12" x2="9" y2="12" /></svg>`,
  documentLocked: `<svg viewBox="0 0 16 16" class="tree-type-icon locked-style-icon"><line x1="4" y1="4" x2="12" y2="4" /><line x1="4" y1="8" x2="12" y2="8" /><line x1="4" y1="12" x2="9" y2="12" /><circle cx="13" cy="13" r="1.5" /></svg>`,
  documentFlagged: `<svg viewBox="0 0 16 16" class="tree-type-icon flagged-icon"><line x1="4" y1="4" x2="12" y2="4" /><line x1="4" y1="8" x2="12" y2="8" /><line x1="4" y1="12" x2="9" y2="12" /></svg>`,
  folder: `<svg viewBox="0 0 16 16" class="tree-type-icon"><circle cx="8" cy="8" r="6" /></svg>`,
  folderFlagged: `<svg viewBox="0 0 16 16" class="tree-type-icon flagged-icon"><circle cx="8" cy="8" r="6" /></svg>`,
  project: `<svg viewBox="0 0 16 16" class="tree-type-icon"><polygon points="8,1 15,15 1,15" /></svg>`,
  projectFlagged: `<svg viewBox="0 0 16 16" class="tree-type-icon flagged-icon"><polygon points="8,1 15,15 1,15" /></svg>`,
  notebook: `<svg viewBox="0 0 16 16" class="tree-type-icon notebook-icon"><circle cx="4" cy="4" r="1" /><circle cx="8" cy="4" r="1" /><circle cx="12" cy="4" r="1" /><circle cx="4" cy="8" r="1" /><circle cx="8" cy="8" r="1" /><circle cx="12" cy="8" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="8" cy="12" r="1" /><circle cx="12" cy="12" r="1" /></svg>`,
  notebookFlagged: `<svg viewBox="0 0 16 16" class="tree-type-icon notebook-icon flagged-icon"><circle cx="4" cy="4" r="1" /><circle cx="8" cy="4" r="1" /><circle cx="12" cy="4" r="1" /><circle cx="4" cy="8" r="1" /><circle cx="8" cy="8" r="1" /><circle cx="12" cy="8" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="8" cy="12" r="1" /><circle cx="12" cy="12" r="1" /></svg>`,
  syncedFolder: `<svg viewBox="0 0 16 16" class="tree-type-icon"><circle cx="8" cy="8" r="6" /><line x1="2" y1="8" x2="14" y2="8" /></svg>`,
  syncedFolderBroken: `<svg viewBox="0 0 16 16" class="tree-type-icon sync-broken-icon"><circle cx="8" cy="8" r="6" /><polyline points="2,8 5,8 6,6 7,10 8,6 9,10 10,8 14,8" /></svg>`,
  inbox: `<svg viewBox="0 0 16 16" class="tree-type-icon"><polyline points="2 9 5 9 6.5 11 9.5 11 11 9 14 9" /><path d="M3 2h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" /></svg>`,
  // Images folder: a centered square with the same rounded corners as the
  // `document` head and a single diagonal slash through it.
  images: `<svg viewBox="0 0 16 16" class="tree-type-icon"><rect x="3" y="3" width="10" height="10" rx="1.5" /><line x1="4.5" y1="11.5" x2="11.5" y2="4.5" /></svg>`,
  trash: `<svg viewBox="0 0 16 16" class="tree-type-icon"><polyline points="2 4 4 4 14 4" /><path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" /><path d="M12 4v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4" /></svg>`,
  flaggedFolder: `<svg viewBox="0 0 16 16" class="tree-type-icon"><path d="M3 10s1-1 3-1 4 2 6 2 3-1 3-1V2s-1 1-3 1-4-2-6-2-3 1-3 1z" /><line x1="3" y1="14" x2="3" y2="10" /></svg>`,
  // Local Sync folder icon: a plain outline square — distinct from the
  // plain folder (circle in the Add menu) and stripped of the line that
  // used to bisect it.
  localSync: `<svg viewBox="0 0 16 16" class="tree-type-icon"><rect x="2" y="2" width="12" height="12" /></svg>`,
};

export function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/** Small two-arrow badge for documents that carry a Google Doc link.
 *  Slots in between the type icon and the name so the row reads as
 *  "doc icon + link badge + name". Empty string for non-doc rows or
 *  unlinked docs. */
export function googleLinkBadgeHtml(item, state) {
  if (item.type !== "document" || !item.fileId) return "";
  const link = state?.settings?.googleDocLinks?.[item.fileId];
  if (!link) return "";
  const tip = escHtml(`Linked to Google Doc: ${link.title || "Untitled"}`);
  return `<svg class="tree-gdoc-link" viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><title>${tip}</title><path d="M3.5 10.5 V1.5 M1.5 3.5 L3.5 1.5 L5.5 3.5"/><path d="M8.5 1.5 V10.5 M6.5 8.5 L8.5 10.5 L10.5 8.5"/></svg>`;
}

export function escAttrValue(str) {
  return String(str ?? "").replace(/"/g, "&quot;").replace(/&/g, "&amp;");
}

/**
 * Wire mouseenter / mouseleave on a `.sl-item` so only the innermost
 * row under the cursor carries `.sl-hovered` (mirrors the logic in
 * sortable-list/rendering.js). Used by the Flagged section and Local
 * Sync rows, which render outside SortableList's own machinery.
 */
/** Generic confirmation modal — used by the rename / duplicate / delete
 *  flows. Shares the existing `tree-delete-modal-*` styles. */
export function showConfirmModal({ title, message, confirmLabel = "Confirm", onConfirm }) {
  document.querySelectorAll(".tree-delete-modal-backdrop").forEach((el) => el.remove());
  const backdrop = document.createElement("div");
  backdrop.className = "tree-delete-modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "tree-delete-modal";
  modal.innerHTML = `
    <div class="tree-delete-modal-title">${escHtml(title)}</div>
    <pre class="tree-delete-modal-message">${escHtml(message)}</pre>
    <div class="tree-delete-modal-btns">
      <button class="tree-delete-cancel">Cancel</button>
      <button class="tree-delete-confirm">${escHtml(confirmLabel)}</button>
    </div>`;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  modal.querySelector(".tree-delete-cancel").addEventListener("click", () => backdrop.remove());
  modal.querySelector(".tree-delete-confirm").addEventListener("click", () => {
    backdrop.remove();
    onConfirm();
  });
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
}

export function showDeleteConfirmModal(title, message, onConfirm) {
  showConfirmModal({ title, message, confirmLabel: "Delete", onConfirm });
}

/** Single-input prompt modal — used by flows that need a name from the
 *  user before they create a file. Calls `onConfirm(trimmedValue)` with
 *  the input value (never empty — the confirm button stays disabled
 *  while the field is blank). Submits on Enter, cancels on Escape or
 *  backdrop click. */
export function showPromptModal({ title, label = "", placeholder = "", initialValue = "", confirmLabel = "Create", onConfirm, onCancel }) {
  document.querySelectorAll(".tree-delete-modal-backdrop").forEach((el) => el.remove());
  const backdrop = document.createElement("div");
  backdrop.className = "tree-delete-modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "tree-delete-modal";
  modal.innerHTML = `
    <div class="tree-delete-modal-title">${escHtml(title)}</div>
    ${label ? `<label class="tree-prompt-modal-label" for="tree-prompt-modal-input">${escHtml(label)}</label>` : ""}
    <input id="tree-prompt-modal-input" class="tree-prompt-modal-input" type="text" autocomplete="off" spellcheck="false" />
    <div class="tree-delete-modal-btns">
      <button class="tree-delete-cancel">Cancel</button>
      <button class="tree-delete-confirm tree-prompt-modal-confirm">${escHtml(confirmLabel)}</button>
    </div>`;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  const input = modal.querySelector("input");
  const confirmBtn = modal.querySelector(".tree-prompt-modal-confirm");
  input.value = initialValue;
  if (placeholder) input.placeholder = placeholder;
  const sync = () => { confirmBtn.disabled = input.value.trim().length === 0; };
  sync();
  // The prompt-modal confirm sits in the same DOM slot as the
  // delete-confirm button — strip its red tint so a routine "Create"
  // doesn't masquerade as a destructive action.
  confirmBtn.classList.add("tree-prompt-modal-confirm");
  const cleanup = () => backdrop.remove();
  const submit = () => {
    const value = input.value.trim();
    if (!value) return;
    cleanup();
    onConfirm(value);
  };
  const cancel = () => { cleanup(); onCancel?.(); };
  modal.querySelector(".tree-delete-cancel").addEventListener("click", cancel);
  confirmBtn.addEventListener("click", submit);
  input.addEventListener("input", sync);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) cancel(); });
  // Focus + select-all so the user can immediately overwrite the default.
  // Done synchronously inside the click that opened the modal so iOS
  // honours the user-gesture and surfaces the on-screen keyboard.
  input.focus();
  input.select();
}

export function attachLeafHoverHandlers(li) {
  li.addEventListener("mouseenter", () => {
    let ancestor = li.parentElement?.closest(".sl-item");
    while (ancestor) {
      ancestor.classList.remove("sl-hovered");
      ancestor = ancestor.parentElement?.closest(".sl-item");
    }
    li.classList.add("sl-hovered");
  });
  li.addEventListener("mouseleave", () => {
    li.classList.remove("sl-hovered");
    const parentItem = li.parentElement?.closest(".sl-item");
    if (parentItem) parentItem.classList.add("sl-hovered");
  });
}
