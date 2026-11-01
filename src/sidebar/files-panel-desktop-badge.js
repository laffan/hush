/**
 * The Desktop button on a project's row. Every project row offers its
 * Desktop among the hover actions; once the project's Desktop holds
 * anything of the user's own — a placeholder document, or notes beside
 * a document (the board's data on the project node, board-model.js) —
 * that same button stays in view where the hover shows it (the menu
 * beside it still waits for the hover), so a project with a Desktop
 * worth going back to says so without one. files-panel.css does the
 * rest. The data rides the tree, so a tree save re-renders the row.
 */

import { boardData } from "../desktop/board/board-model.js";
import { hasDesktop } from "./files-panel-row-menu.js";

/** Whether `item`'s row keeps its Desktop button in view. */
export function showsDesktopButton(state, item, inTrash) {
  if (!hasDesktop(item.id, item.type, inTrash, item)) return false;
  const data = boardData(item);
  return data.placeholders.length > 0 || Object.keys(data.notes).length > 0;
}
