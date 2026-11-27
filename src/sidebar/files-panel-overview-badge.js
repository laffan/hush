/**
 * The Project Overview button on a project's row. Every project row
 * offers its Overview among the hover actions; once the project's
 * Overview holds anything of the user's own — an Overview Doc, a
 * placeholder document, or notes beside a document (the board's data on
 * the project node, board-model.js) — that same button stays in view
 * where the hover shows it (the menu beside it still waits for the
 * hover), so a project with an Overview worth going back to says so
 * without one. files-panel.css does the rest. The data rides the tree,
 * so a tree save re-renders the row.
 */

import { boardData, overviewDocNode } from "../project-overview/board/board-model.js";
import { hasProjectOverview } from "./files-panel-row-menu.js";

/** Whether `item`'s row keeps its Overview button in view. */
export function showsOverviewButton(state, item, inTrash) {
  if (!hasProjectOverview(item.id, item.type, inTrash, item)) return false;
  const data = boardData(item);
  return !!overviewDocNode(item) || data.placeholders.length > 0 || Object.keys(data.notes).length > 0;
}
