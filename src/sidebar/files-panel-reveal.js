/**
 * Open a file, see where it lives: whenever a surface opens a file — a
 * sidebar click, the command palette, Recent Files, YOU ARE HERE, a
 * wikilink, a new window — every folder, project and desk row above it in
 * the files panel is expanded.
 *
 * Keyed off the state's open events rather than the entry points, so a
 * new way of opening a file gets the rule without knowing about it. The
 * collapsed set lives in two places, and both are updated: the mounted
 * list's live `collapsedIds` (when the panel exists) and the persisted
 * `collapsedFolderIds`, which is what a panel mounted later starts from —
 * so a file opened with the sidebar closed is still revealed when it
 * opens.
 *
 * Only ancestors are expanded. The opened row itself is left as it was:
 * opening a project shouldn't also unfold everything inside it.
 */

import { AppState } from "../state/state.js";
import { findAncestorIds, findNodeByFileId } from "../state/tree-helpers.js";
import { allSpecialIds } from "./files-panel-rows.js";

/** The collapsed set a panel starts from before the user has ever
 *  toggled anything: Inbox open, Trash / Images / PDFs / Archive shut. */
export function defaultCollapsedIds(state) {
  const ids = [];
  for (const k of [AppState.TRASH_ID, AppState.IMAGES_ID, AppState.PDFS_ID, AppState.ARCHIVE_ID]) {
    ids.push(...allSpecialIds(state, k));
  }
  return ids;
}

/** The tree node the main surface just opened, or null (a Local Folder
 *  file has no node — its section expands on its own terms). */
function openedNodeId(state, event, fileId) {
  if (event === "file-opened") {
    if (state.currentProjectId) return state.currentProjectId;
    fileId = state.currentFileId;
  }
  if (!fileId || typeof fileId !== "string") return null;
  return findNodeByFileId(state.fileTree, fileId)?.id || null;
}

/**
 * Wire the rule. Idempotent.
 *
 * @param getSortable  the mounted files list, or null while none is
 * @param afterRender  re-place what lives inside the list after a
 *                     programmatic re-render (Local Folders, the desk
 *                     YOU ARE HERE row) — the same hook a user's own
 *                     disclosure toggle runs
 */
let installed = false;
export function installRevealOnOpen(state, getSortable, afterRender) {
  if (installed) return;
  installed = true;
  const reveal = (event, fileId) => {
    const nodeId = openedNodeId(state, event, fileId);
    if (!nodeId) return;
    const ancestors = findAncestorIds(state.fileTree, nodeId);
    if (!ancestors?.length) return;

    const sortable = getSortable();
    const persisted = state.settings?.collapsedFolderIds;
    const collapsed = sortable?.state?.collapsedIds
      || new Set(Array.isArray(persisted) ? persisted : defaultCollapsedIds(state));
    const toOpen = ancestors.filter((id) => collapsed.has(id));
    if (!toOpen.length) return;

    for (const id of toOpen) collapsed.delete(id);
    state.updateSettings({ collapsedFolderIds: [...collapsed] });
    if (sortable) {
      sortable.render();
      afterRender?.();
    }
  };
  state.on("file-opened", () => reveal("file-opened"));
  state.on("notebook-open", (id) => reveal("notebook-open", id));
  state.on("pdf-open", (id) => reveal("pdf-open", id));
  state.on("stack-open", (id) => reveal("stack-open", id));

  // The file restored at launch opened before anything was listening —
  // reveal it once now. Only here, not on every panel mount: that would
  // undo a collapse the user made after opening it.
  if (state.currentNotebookFileId) reveal("notebook-open", state.currentNotebookFileId);
  else if (state.currentPdfFileId) reveal("pdf-open", state.currentPdfFileId);
  else if (state.currentStackFileId) reveal("stack-open", state.currentStackFileId);
  else reveal("file-opened");
}
