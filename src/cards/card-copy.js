/**
 * Copy card content (the command palette): the words of the cards
 * selected on a canvas go to the clipboard as markdown, in reading order
 * (top to bottom, then left to right), a blank line between each.
 *
 * The canvas is the one in front of the user: the active pane's, if it
 * is a notebook, else the main surface's. Shown only while that canvas
 * has a card selected.
 */

import { panes } from "../pane/pane-state.js";
import { getActivePaneId } from "../pane/pane-manager.js";
import { getCanvasInstance } from "../notebook/notebook-bridge.js";

function frontCanvasState(state) {
  const pane = panes.get(getActivePaneId());
  if (pane?.fileType === "notebook") return pane.notebook?.state || null;
  if (!state?.currentNotebookFileId) return null;
  return getCanvasInstance()?.state || null;
}

/** The selected cards, in reading order. */
function selectedCards(state) {
  const st = frontCanvasState(state);
  if (!st?.selectedIds?.size || !Array.isArray(st.shapes)) return [];
  return st.shapes
    .filter((s) => s.card === true && st.selectedIds.has(s.id))
    .sort((a, b) => (a.position.y - b.position.y) || (a.position.x - b.position.x));
}

/** Whether the palette entry shows. */
export function hasSelectedCards(state) {
  return selectedCards(state).length > 0;
}

export async function copySelectedCards(state) {
  const cards = selectedCards(state);
  if (!cards.length) return;
  const text = cards.map((s) => String(s.text || "").replace(/\s+$/, "")).join("\n\n") + "\n";
  const [{ writeClipboardText }, { showImportToast }] = await Promise.all([
    import("../multi-select-view.js"),
    import("../editor/import-toast.js"),
  ]);
  const ok = await writeClipboardText(text);
  showImportToast(ok ? `Copied ${cards.length === 1 ? "card" : `${cards.length} cards`}` : "Couldn't copy to the clipboard", ok ? "info" : "error");
}
