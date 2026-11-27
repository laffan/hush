/**
 * The file the floating To-do list is opened over — its "context" — for
 * the quick input at the top of the panel (todo-list.js): the to-do for
 * that file, or a draft of one.
 *
 * The file is whatever the main surface holds that a to-do can link to:
 * a Doc, a notebook or a stack. Not a PDF or a project (todo-search.js
 * explains why neither can be linked), and not a Local Folder file,
 * which has no fileId in the desk's tree.
 *
 * The draft is titled "Changes to <name>" and is only a draft: it
 * becomes a to-do once it has a note or a sub-to-do (todo-list.js
 * `materialize`), and otherwise is never kept.
 */
import { findNodeByFileId } from "../state/tree-helpers.js";
import { deskIdOfFile } from "../state/cross-desk.js";

/** `{ fileId, type, name, deskId, node }` for the file in front, or null. */
export function contextFile(state) {
  let fileId = null;
  if (state.currentNotebookFileId) fileId = state.currentNotebookFileId;
  else if (state.currentStackFileId) fileId = state.currentStackFileId;
  else if (state.currentPdfFileId) return null;
  else if (state.currentFileId && !state.currentProjectId && !state.currentLocalSync) fileId = state.currentFileId;
  if (!fileId) return null;
  const node = findNodeByFileId(state.fileTree || [], fileId);
  if (!node || node.type === "pdf" || node.type === "project") return null;
  const deskId = deskIdOfFile(state, fileId);
  if (!deskId) return null;
  return { fileId, type: node.type || "document", name: node.name || "Untitled", deskId, node };
}

/** The draft's title. */
export const draftTitle = (name) => `Changes to ${name}`;

/** The id a draft's row carries — never a stored to-do's. */
export const DRAFT_ID = "__draft__";
