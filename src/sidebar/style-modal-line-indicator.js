/**
 * Line Indicator rows for the style editor's Editing section.
 *
 * The indicator itself (none / arrows / borders / underline / highlight) is a
 * single per-style value, but its colour is per-appearance and
 * optional: with no override the indicator tracks the style's cursor
 * colour, which is what most styles want. "Custom color" is the opt-in
 * — checking it reveals a light and a dark picker beside it on the same
 * row, unchecking it drops both overrides so the indicator falls back to
 * the cursor again.
 *
 * Underline and highlight add two more rows — Thickness and Width
 * (`lineIndicatorUnderlineThickness` / `lineIndicatorHighlightThickness`
 * / `lineIndicatorFullWidth`, top-level keys on the style, or on
 * AppSettings for the Default style).
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
import { splitAlphaColor, joinAlphaColor } from "../ui/color-picker.js";
import { UNDERLINE_THICKNESS_DEFAULT, HIGHLIGHT_THICKNESS_DEFAULT } from "../editor/line-indicator.js";

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

/** One appearance's swatch — the same markup as the Cursor section's
 *  colour pair (style-modal-cursor.js), so the two read alike, opted
 *  into the picker's opacity slider the same way (`data-alpha`). */
function swatchCell(id, label, value) {
  const { hex, alpha } = splitAlphaColor(value);
  return `
          <span class="style-appearance-swatch">
            <span class="style-appearance-swatch-label">${escHtml(label)}</span>
            <span class="style-color-group">
              <input type="color" id="${id}" value="${escAttr(hex)}" data-alpha="${alpha}" aria-label="${escHtml(label)} line indicator color" />
            </span>
          </span>`;
}

/** Underline and highlight have a shape the other variants don't: how
 *  thick the rule or the band is, and whether it runs the text column
 *  (Normal) or the editor's whole width (Full width). The underline's
 *  thickness is px; the highlight's is the share of the line it covers,
 *  measured up from the line's foot, so a thin one reads as a
 *  highlighter pen's stroke rather than a slab. */
function renderShapeRows(draft) {
  const v = draft.lineIndicator;
  if (v !== "underline" && v !== "highlight") return "";
  const isUnderline = v === "underline";
  const value = isUnderline
    ? (draft.lineIndicatorUnderlineThickness ?? UNDERLINE_THICKNESS_DEFAULT)
    : (draft.lineIndicatorHighlightThickness ?? HIGHLIGHT_THICKNESS_DEFAULT);
  const unit = isUnderline ? "px" : "%";
  const range = isUnderline ? 'min="1" max="10" step="1"' : 'min="10" max="100" step="5"';
  const full = !!draft.lineIndicatorFullWidth;
  return `
    <div class="style-editor-row">
      <label for="style-line-indicator-thickness">Thickness</label>
      <div class="style-slider-group">
        <input type="range" id="style-line-indicator-thickness" ${range} value="${value}" />
        <span class="style-slider-value">${value}${unit}</span>
      </div>
    </div>
    <div class="style-editor-row">
      <label for="style-line-indicator-width">Width</label>
      <div class="style-select-group">
        <select id="style-line-indicator-width" class="style-native-select">
          <option value="normal"${full ? "" : " selected"}>Normal</option>
          <option value="full"${full ? " selected" : ""}>Full width</option>
        </select>
      </div>
    </div>`;
}

/** The row under the Line Indicator dropdown: the "Custom color" box,
 *  and while it's ticked the Light and Dark pickers beside it on the same
 *  row. Nothing renders while the indicator is "none" — there's no mark
 *  to colour. */
export function renderLineIndicatorColorRows(draft) {
  if (!draft.lineIndicator || draft.lineIndicator === "none") return "";
  const custom = hasCustomLineIndicatorColor(draft);
  return `
    <div class="style-editor-row">
      <label for="style-line-indicator-custom">Custom color</label>
      <div class="style-line-ind-color">
        <input type="checkbox" id="style-line-indicator-custom" ${custom ? "checked" : ""} />
        ${custom ? `<div class="style-glow-pair">
          ${swatchCell("style-line-indicator-light", "Light", seedColor(draft, "light"))}
          ${swatchCell("style-line-indicator-dark", "Dark", seedColor(draft, "dark"))}
        </div>` : ""}
      </div>
    </div>${renderShapeRows(draft)}`;
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
      target.lineIndicator = joinAlphaColor(el.value, el.dataset.alpha);
      onCommit();
    };
    el.addEventListener("input", handler);
    el.addEventListener("change", handler);
  };
  bindColor("#style-line-indicator-light", "light");
  bindColor("#style-line-indicator-dark", "dark");

  // Thickness writes the key of whichever variant is showing; the label
  // follows the drag without a re-render, which would drop the slider
  // out from under the pointer.
  const thickEl = root.querySelector("#style-line-indicator-thickness");
  if (thickEl) thickEl.addEventListener("input", () => {
    const n = Number(thickEl.value);
    const isUnderline = draft.lineIndicator === "underline";
    if (isUnderline) draft.lineIndicatorUnderlineThickness = n;
    else draft.lineIndicatorHighlightThickness = n;
    const label = thickEl.parentElement?.querySelector(".style-slider-value");
    if (label) label.textContent = `${n}${isUnderline ? "px" : "%"}`;
    onCommit();
  });
  const widthEl = root.querySelector("#style-line-indicator-width");
  if (widthEl) widthEl.addEventListener("change", () => {
    draft.lineIndicatorFullWidth = widthEl.value === "full";
    onCommit();
  });
}
