/**
 * The Overview Doc's row, and the Project Overview button on a project's
 * row.
 *
 * A project's Overview Doc with nothing in it (nothing but white space)
 * is left out of the file browser: its row is drawn and hidden
 * (`hidesOverviewDoc`, files-panel.css), as an empty CARDS notebook's is.
 * Hidden rather than left out of the list, since the panel writes the
 * list it drew back to the tree after a drag. It appears with its first
 * words.
 *
 * The button: every project row offers its Overview among the hover
 * actions; once the project's Overview holds anything of the user's own
 * — an Overview Doc with words in it, a placeholder document, or notes
 * beside a document (the board's data on the project node,
 * board-model.js) — that same button stays in view where the hover
 * shows it (the menu beside it still waits for the hover), so a project
 * with an Overview worth going back to says so without one.
 * files-panel.css does the rest. The data rides the tree, so a tree save
 * re-renders the row.
 */

import { boardData, overviewDocNode, overviewDocHasText } from "../project-overview/board/board-model.js";
import { overviewDocFileIdOf } from "../state/tree-helpers.js";
import { hasProjectOverview } from "./files-panel-row-menu.js";

/** Whether `item`'s row keeps its Overview button in view. */
export function showsOverviewButton(state, item, inTrash) {
  if (!hasProjectOverview(item.id, item.type, inTrash, item)) return false;
  const data = boardData(item);
  const doc = overviewDocNode(item);
  return (!!doc && overviewDocHasText(state, doc.fileId))
    || data.placeholders.length > 0 || Object.keys(data.notes).length > 0;
}

/** Whether `item` (with its parent, `parent`) is an Overview Doc with
 *  nothing in it yet, whose row the file browser hides. */
export function hidesOverviewDoc(state, item, parent) {
  return item?.type === "document" && !!item.fileId && !!parent
    && overviewDocFileIdOf(parent) === item.fileId && !overviewDocHasText(state, item.fileId);
}
