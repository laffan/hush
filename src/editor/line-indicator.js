/**
 * Line Indicator — paints the active line with a per-style "highlight the
 * current line" affordance (left arrow / double arrow / left border /
 * border / highlight).
 *
 * Rendering is two halves:
 *   1. CodeMirror's built-in `highlightActiveLine()` paints the
 *      `.cm-activeLine` class on whichever line carries the cursor.
 *   2. `applyLineIndicatorClass()` writes a `line-ind-<variant>` class
 *      on each editor's container element so the matching CSS rule
 *      (`.line-ind-left-arrow .cm-activeLine::before {…}`) lights up.
 * Driving the visual through a container class avoids relying on
 * Decoration.line surviving every other line-level decoration in the
 * stack — the active-line element is owned by CodeMirror itself.
 */
import { highlightActiveLine } from "@codemirror/view";

const VARIANTS = ["left-arrow", "double-arrow", "left-border", "border", "highlight"];

export const lineIndicatorBaseExtension = highlightActiveLine();

function resolveLineIndicator(state) {
  const styleId = state.settings.activeStyleId;
  if (!styleId) {
    const v = state.settings.lineIndicator;
    return v && v !== "none" ? v : null;
  }
  const style = (state.settings.styles || []).find(s => s.id === styleId);
  if (!style) return null;
  const v = style.lineIndicator;
  return v && v !== "none" ? v : null;
}

/** Toggle the `line-ind-<variant>` class on the given container so the
 *  active-line CSS variant takes effect. Pass the same element you'd
 *  attach the indicator to — main `#editor-container`, a pane host,
 *  or any wrapper that contains the CodeMirror surface. */
export function applyLineIndicatorClass(container, state) {
  if (!container) return;
  const indicator = resolveLineIndicator(state);
  for (const v of VARIANTS) container.classList.toggle("line-ind-" + v, indicator === v);
}

/** Wire a container to re-apply the indicator class on every
 *  `style-changed` / `settings-changed` so dropdown edits land live. */
export function bindLineIndicatorToContainer(container, state) {
  applyLineIndicatorClass(container, state);
  state.on("style-changed", () => applyLineIndicatorClass(container, state));
  state.on("settings-changed", () => applyLineIndicatorClass(container, state));
}
