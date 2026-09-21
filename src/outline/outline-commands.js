/**
 * The outline commands the palette runs: "Convert to Outline" (both
 * halves), its inverse "Convert to List", and the "Outline mode" switch.
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
 * "Convert to List" is the Doc half only. A notebook outline shape is a
 * shape, not a run of lines: unfolding one back into a flowchart is a
 * different operation from stripping checkboxes, and the canvas owns it.
 *
 * Lives outside `command-palette-commands.js` so that file stays clear
 * of the 700-line cap; the palette entries are two lines each.
 */

import { getActiveModeContext } from "../state/mode-context.js";
import { getCanvasInstance } from "../notebook/notebook-bridge.js";
import {
  convertListToOutline, listBlockForSelection,
  convertOutlineToList, outlineBlockForSelection,
  toggleOutlineMode as patchOutlineMode, outlineFlagsOf,
} from "../editor/outline-frontmatter.js";

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

/** True when the caret sits in a run of checklist lines — an outline to
 *  take the boxes off. */
export function canConvertDocToList(state) {
  const view = docView(state);
  if (!view) return false;
  try { return !!outlineBlockForSelection(view.state); }
  catch { return false; }
}

export function convertDocToList(state) {
  const view = docView(state);
  if (!view) return;
  convertOutlineToList(view);
  view.focus();
}

/** Whether the open document carries `outline: true`. Drives which half
 *  of the Outline mode pair the palette shows. */
export function isOutlineModeOn(state) {
  const view = docView(state);
  if (!view) return false;
  try { return outlineFlagsOf(view.state).on; }
  catch { return false; }
}

/** Flip the document's outline switch. Docs only — a notebook shape
 *  carries its own `outline` flag and has no frontmatter to write to. */
export function toggleOutlineMode(state) {
  const view = docView(state);
  if (!view) return;
  patchOutlineMode(view);
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
