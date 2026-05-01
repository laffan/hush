/**
 * Shared helpers for the files panel and its sibling sub-modules
 * (files-panel-local-sync.js, etc.). Keeping these in their own file
 * avoids circular imports between files-panel.js and modules that
 * render rows on its behalf.
 */

// SVG icons for the tree-item types
export const typeIcons = {
  document: `<svg viewBox="0 0 16 16" class="tree-type-icon"><rect x="3" y="1" width="10" height="14" rx="1.5" /></svg>`,
  documentLocked: `<svg viewBox="0 0 16 16" class="tree-type-icon locked-style-icon"><rect x="3" y="1" width="10" height="14" rx="1.5" /><circle cx="8" cy="8" r="2.5" /></svg>`,
  documentFlagged: `<svg viewBox="0 0 16 16" class="tree-type-icon flagged-icon"><rect x="3" y="1" width="10" height="14" rx="1.5" /></svg>`,
  folder: `<svg viewBox="0 0 16 16" class="tree-type-icon"><circle cx="8" cy="8" r="6" /></svg>`,
  folderFlagged: `<svg viewBox="0 0 16 16" class="tree-type-icon flagged-icon"><circle cx="8" cy="8" r="6" /></svg>`,
  project: `<svg viewBox="0 0 16 16" class="tree-type-icon"><polygon points="8,1 15,15 1,15" /></svg>`,
  projectFlagged: `<svg viewBox="0 0 16 16" class="tree-type-icon flagged-icon"><polygon points="8,1 15,15 1,15" /></svg>`,
  notebook: `<svg viewBox="0 0 16 16" class="tree-type-icon"><rect x="3" y="1" width="10" height="14" rx="1.5" /><line x1="5" y1="4" x2="11" y2="4" /><line x1="5" y1="7" x2="11" y2="7" /><line x1="5" y1="10" x2="9" y2="10" /></svg>`,
  notebookFlagged: `<svg viewBox="0 0 16 16" class="tree-type-icon flagged-icon"><rect x="3" y="1" width="10" height="14" rx="1.5" /><line x1="5" y1="4" x2="11" y2="4" /><line x1="5" y1="7" x2="11" y2="7" /><line x1="5" y1="10" x2="9" y2="10" /></svg>`,
  syncedFolder: `<svg viewBox="0 0 16 16" class="tree-type-icon"><circle cx="8" cy="8" r="6" /><line x1="2" y1="8" x2="14" y2="8" /></svg>`,
  syncedFolderBroken: `<svg viewBox="0 0 16 16" class="tree-type-icon sync-broken-icon"><circle cx="8" cy="8" r="6" /><polyline points="2,8 5,8 6,6 7,10 8,6 9,10 10,8 14,8" /></svg>`,
  inbox: `<svg viewBox="0 0 16 16" class="tree-type-icon"><polyline points="2 9 5 9 6.5 11 9.5 11 11 9 14 9" /><path d="M3 2h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" /></svg>`,
  // Images folder: a centered square with the same rounded corners as the
  // `document` head and a single diagonal slash through it.
  images: `<svg viewBox="0 0 16 16" class="tree-type-icon"><rect x="3" y="3" width="10" height="10" rx="1.5" /><line x1="4.5" y1="11.5" x2="11.5" y2="4.5" /></svg>`,
  trash: `<svg viewBox="0 0 16 16" class="tree-type-icon"><polyline points="2 4 4 4 14 4" /><path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" /><path d="M12 4v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4" /></svg>`,
  flaggedFolder: `<svg viewBox="0 0 16 16" class="tree-type-icon"><path d="M3 10s1-1 3-1 4 2 6 2 3-1 3-1V2s-1 1-3 1-4-2-6-2-3 1-3 1z" /><line x1="3" y1="14" x2="3" y2="10" /></svg>`,
  // Local Sync folder icon: circle with a horizontal line through the
  // middle — visually distinct from the plain folder (filled circle).
  localSync: `<svg viewBox="0 0 16 16" class="tree-type-icon"><circle cx="8" cy="8" r="6" /><line x1="2" y1="8" x2="14" y2="8" /></svg>`,
};

export function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
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
