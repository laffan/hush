/**
 * The outline commands the palette runs: "Convert to Outline" (both
 * halves), its inverse "Convert to List", and the "Outline mode" switch.
 *
 * A Doc converts the nested list under the cursor: every item that lacks
 * a checkbox gets one, and the document's frontmatter gains
 * `outline: true`. A Notebook converts either of two selections: a
 * flowchart, whose tree is read out as a nested checklist and becomes a
 * single outline shape where the chart's root node was; or a text shape
 * that is a markdown list, which becomes an outline where it stands —
 * checkboxes added, the shape's `outline` flag set.
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

import { getActiveModeContext, hasActiveDocSurface } from "../state/mode-context.js";
import { getCanvasInstance } from "../notebook/notebook-bridge.js";
import {
  convertListToOutline, listBlockForSelection,
  convertOutlineToList, outlineBlockForSelection,
  toggleOutlineMode as patchOutlineMode, outlineFlagsOf,
} from "../editor/outline-frontmatter.js";

/**
 * The doc surface a doc-side command should act on: the focused pane or
 * stack column when one owns the active mode context, else the main
 * editor.
 *
 * `hasActiveDocSurface` gates the fallback, and it has to. The main
 * editor is built once at boot and never torn down, so `state.editor`
 * still holds the last document while a notebook is on screen — without
 * the guard these commands would offer themselves over a canvas and
 * then rewrite a document nobody can see. With it, the same commands
 * reach a doc pane floating over that canvas, which is the surface the
 * user is actually typing in.
 */
function docView(state) {
  if (!hasActiveDocSurface(state)) return null;
  const ctx = getActiveModeContext(state);
  return ctx?.view || state.editor?.view || null;
}

/** True when a pane or stack column owns the caret — so a canvas-side
 *  command knows the user is working somewhere else. */
function docSurfaceHasCaret(state) {
  return !!getActiveModeContext(state)?.view;
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

/** True when there is a document to put the switch on at all. The pair
 *  below reads "on" or "off", and neither answer means anything with no
 *  doc surface holding the caret — so both entries hide instead. */
export function canToggleOutlineMode(state) {
  return !!docView(state);
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

/** True when the canvas selection is something an outline can be made
 *  of: a flowchart, or a text shape holding a markdown list.
 *
 *  A doc pane over the canvas takes precedence: both halves of the
 *  command carry the same label, and the one the user means is the
 *  surface holding their caret. */
export function canConvertNotebookToOutline(state) {
  if (state && docSurfaceHasCaret(state)) return false;
  const canvas = getCanvasInstance();
  if (!canvas || !canvas.state) return false;
  try {
    return canvas.state.outlineConvertNodes().length > 0
      || canvas.state.outlineConvertListShapes().length > 0;
  } catch { return false; }
}

export function convertNotebookToOutline() {
  const canvas = getCanvasInstance();
  if (!canvas || !canvas.state) return;
  canvas.state.convertSelectionToOutline();
}
