/**
 * "Convert to Outline" — the two halves of one command.
 *
 * A Doc converts the nested list under the cursor: every item that lacks
 * a checkbox gets one, and the document's frontmatter gains
 * `outline: true`. A Notebook converts the selected flowchart: the tree
 * is read out as a nested checklist and becomes a single outline shape
 * where the chart's top-left node was.
 *
 * They produce the same thing — a nested markdown checklist — which is
 * the point: an outline made on either surface opens as an outline on
 * the other, with no conversion in between.
 *
 * Lives outside `command-palette-commands.js` so that file stays clear
 * of the 700-line cap; the palette entries are two lines each.
 */

import { getActiveModeContext } from "../state/mode-context.js";
import { getCanvasInstance } from "../notebook/notebook-bridge.js";
import { convertListToOutline, listBlockForSelection } from "../editor/outline-frontmatter.js";

/** The doc surface a doc-side command should act on: the focused pane or
 *  stack column when one owns the active mode context, else the main
 *  editor. Same resolution the fold commands use. */
function docView(state) {
  const ctx = getActiveModeContext(state);
  return ctx?.view || state.editor?.view || null;
}

/** True when the caret sits in a list with at least one item still
 *  missing its checkbox. */
export function canConvertDocToOutline(state) {
  const view = docView(state);
  if (!view) return false;
  try { return !!listBlockForSelection(view.state); }
  catch { return false; }
}

export function convertDocToOutline(state) {
  const view = docView(state);
  if (!view) return;
  convertListToOutline(view);
  view.focus();
}

/** True when the canvas selection takes part in a flowchart. */
export function canConvertNotebookToOutline() {
  const canvas = getCanvasInstance();
  if (!canvas || !canvas.state) return false;
  try { return canvas.state.outlineConvertNodes().length > 0; }
  catch { return false; }
}

export function convertNotebookToOutline() {
  const canvas = getCanvasInstance();
  if (!canvas || !canvas.state) return;
  canvas.state.convertSelectionToOutline();
}
