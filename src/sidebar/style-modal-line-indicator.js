/**
 * Line Indicator rows for the style editor's Editing section.
 *
 * The indicator itself (none / arrows / borders / highlight) is a
 * single per-style value, but its colour is per-appearance and
 * optional: with no override the indicator tracks the style's cursor
 * colour, which is what most styles want. "Custom color" is the opt-in
 * — checking it reveals a light and a dark picker, unchecking it drops
 * both overrides so the indicator falls back to the cursor again.
 *
 * The overrides live where every other per-appearance colour lives —
 * `lightColors.lineIndicator` / `darkColors.lineIndicator` — so
 * `style-application.js` and the preview keep reading them from the
 * one place, and an existing style that set the colour before this
 * checkbox existed opens with it already ticked.
 */

import { escAttr, escHtml } from "./styles-panel-shared.js";
import { getThemeById } from "../themes/index.js";
import { themeColorFor } from "./style-modal-preview.js";

/** True when either appearance carries a line-indicator override. */
export function hasCustomLineIndicatorColor(draft) {
  return !!(draft.lightColors?.lineIndicator || draft.darkColors?.lineIndicator);
}

/** The colour a picker should open on for one appearance — the stored
 *  override if there is one, otherwise the same chain the indicator
 *  actually renders through (cursor override → theme heading → theme
 *  foreground), so ticking the box starts from what's on screen rather
 *  than from an arbitrary swatch. */
function seedColor(draft, tab) {
  const colors = (tab === "light" ? draft.lightColors : draft.darkColors) || {};
  if (colors.lineIndicator) return colors.lineIndicator;
  if (colors.cursor) return colors.cursor;
  const themeId = tab === "light" ? draft.lightThemeId : draft.darkThemeId;
  return getThemeById(themeId)?.headingColor || themeColorFor("cursor", themeId, tab);
}

/** Rows that sit under the Line Indicator dropdown. Nothing renders
 *  while the indicator is "none" — there's no mark to colour. */
export function renderLineIndicatorColorRows(draft) {
  if (!draft.lineIndicator || draft.lineIndicator === "none") return "";
  const custom = hasCustomLineIndicatorColor(draft);
  const colorRow = (id, label, value) => `
    <div class="style-editor-color-row">
      <label>${escHtml(label)}</label>
      <div class="style-color-group">
        <input type="color" id="${id}" value="${escAttr(value)}" />
      </div>
    </div>`;
  return `
    <div class="style-editor-row">
      <label>Custom color</label>
      <div class="style-checkbox-group">
        <input type="checkbox" id="style-line-indicator-custom" ${custom ? "checked" : ""} />
      </div>
    </div>
    ${custom
      ? colorRow("style-line-indicator-light", "Color (Light)", seedColor(draft, "light"))
        + colorRow("style-line-indicator-dark", "Color (Dark)", seedColor(draft, "dark"))
      : ""}`;
}

/**
 * Wire the rows above.
 *
 * @param root      the modal element to query within
 * @param draft     the style draft being edited (mutated in place)
 * @param rerender  re-render the modal (the checkbox shows / hides the
 *                  two pickers, exactly as the caret layer's
 *                  "Match caret color" does)
 * @param onCommit  schedule a save + refresh the preview
 */
export function bindLineIndicatorColorRows(root, draft, rerender, onCommit) {
  const customEl = root.querySelector("#style-line-indicator-custom");
  if (customEl) customEl.addEventListener("change", () => {
    if (!draft.lightColors) draft.lightColors = {};
    if (!draft.darkColors) draft.darkColors = {};
    if (customEl.checked) {
      // Seed both halves so the style renders identically the instant
      // the box is ticked — the seeds are the colours it was already
      // resolving to.
      draft.lightColors.lineIndicator = seedColor(draft, "light");
      draft.darkColors.lineIndicator = seedColor(draft, "dark");
    } else {
      delete draft.lightColors.lineIndicator;
      delete draft.darkColors.lineIndicator;
    }
    rerender();
    onCommit();
  });

  const bindColor = (sel, tab) => {
    const el = root.querySelector(sel);
    if (!el) return;
    const handler = () => {
      const target = tab === "light"
        ? (draft.lightColors || (draft.lightColors = {}))
        : (draft.darkColors || (draft.darkColors = {}));
      target.lineIndicator = el.value;
      onCommit();
    };
    el.addEventListener("input", handler);
    el.addEventListener("change", handler);
  };
  bindColor("#style-line-indicator-light", "light");
  bindColor("#style-line-indicator-dark", "dark");
}
