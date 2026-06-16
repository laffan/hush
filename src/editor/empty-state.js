/**
 * "No file selected" empty editor state. Shown when the active file is
 * deleted, when a desk has nothing to restore, or when there are no files
 * at all. Previously these cases jumped the editor to the first file in
 * the DB (often in another desk), which was disorienting — this pane
 * instead offers a calm starting point with the three create actions.
 *
 * Mounted once over the editor area; mode toggling in main-modes.js shows
 * it via the `empty-mode` body/app class (mirrors notebook/pdf/stack).
 */

import { typeIcons, showPromptModal } from "../sidebar/files-panel-shared.js";

let _mounted = false;

const DOC_ICON = typeIcons.document;
const NOTEBOOK_ICON = typeIcons.notebook;
const STACK_ICON = typeIcons.stack;

/** Render the empty-state UI into `container` once and wire its buttons
 *  to the create actions. Idempotent — repeated calls are no-ops. */
export function mountEmptyState(container, state) {
  if (_mounted || !container) return;
  _mounted = true;
  container.innerHTML = `
    <div class="empty-state-inner">
      <p class="empty-state-title">No file selected</p>
      <div class="empty-state-actions">
        <button type="button" data-empty-action="new-doc">${DOC_ICON}<span>New Doc</span></button>
        <button type="button" data-empty-action="new-notebook">${NOTEBOOK_ICON}<span>New Notebook</span></button>
        <button type="button" data-empty-action="new-stack">${STACK_ICON}<span>New Stack</span></button>
      </div>
    </div>`;
  container.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-empty-action]");
    if (!btn) return;
    const action = btn.dataset.emptyAction;
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
    } else if (action === "new-stack") {
      showPromptModal({
        title: "New stack",
        label: "Name",
        placeholder: "New Stack",
        initialValue: "New Stack",
        confirmLabel: "Create",
        onConfirm: async (name) => { await state.createStack(name); },
      });
    }
  });
}
