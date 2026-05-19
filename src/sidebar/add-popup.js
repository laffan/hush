/**
 * Footer Add (+) popup — surfaces the four "create" actions that used
 * to live in the top row of the files panel (New Doc / New Notebook /
 * New Folder / New Project). Anchored to the Add button in the panel
 * footer; closes on click outside, Esc, or after selection.
 */

import { typeIcons } from "./files-panel-shared.js";
import { showPromptModal } from "./files-panel-shared.js";

let openPopup = null;

export function mountAddPopup(state, anchorEl) {
  if (openPopup) { closePopup(); return; }

  const popup = document.createElement("div");
  popup.className = "panel-add-popup";
  popup.innerHTML = `
    <button type="button" data-action="new-doc">${typeIcons.document}<span>New Doc</span></button>
    <button type="button" data-action="new-notebook">${typeIcons.notebook}<span>New Notebook</span></button>
    <button type="button" data-action="new-folder">${typeIcons.folder}<span>New Folder</span></button>
    <button type="button" data-action="new-project">${typeIcons.project}<span>New Project</span></button>
  `;
  document.body.appendChild(popup);

  // Position above the anchor (the Add button) with a small gap. The
  // popup is rendered before being positioned so its measured width can
  // be lined up with the anchor's left edge.
  const rect = anchorEl.getBoundingClientRect();
  popup.style.left = rect.left + "px";
  popup.style.top = (rect.top - popup.offsetHeight - 8) + "px";

  popup.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    closePopup();
    if (action === "new-doc") {
      state.newFile();
    } else if (action === "new-notebook") {
      showPromptModal({
        title: "New notebook",
        label: "Name",
        placeholder: "New Notebook",
        initialValue: "New Notebook",
        confirmLabel: "Create",
        onConfirm: async (name) => { await state.createNotebook(name); },
      });
    } else if (action === "new-folder") {
      await state.createFolder("New Folder");
    } else if (action === "new-project") {
      await state.createProject("New Project");
    }
  });

  // Close on click outside or Esc.
  const onDocMouseDown = (e) => {
    if (popup.contains(e.target) || anchorEl.contains(e.target)) return;
    closePopup();
  };
  const onKey = (e) => { if (e.key === "Escape") closePopup(); };
  // Attach one tick later so the click that opened the popup isn't
  // immediately consumed as a click-outside.
  setTimeout(() => {
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
  }, 0);

  openPopup = { el: popup, onDocMouseDown, onKey };
}

export function closePopup() {
  if (!openPopup) return;
  document.removeEventListener("mousedown", openPopup.onDocMouseDown);
  document.removeEventListener("keydown", openPopup.onKey);
  openPopup.el.remove();
  openPopup = null;
}
