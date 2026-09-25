/**
 * Style modal — the per-appearance colour rows.
 *
 * Split out of `style-modal.js` for the 700-line cap. Owns which rows
 * the Colors section shows, their markup, and the read/write path
 * between a swatch and the draft's `lightColors` / `darkColors` map.
 *
 * ## Opacity
 *
 * The swatch is an `input[type="color"]`, whose value can only ever be
 * `#rrggbb` — there is nowhere in it to put an alpha channel. So the
 * picker publishes opacity beside the value, on `dataset.alpha`, and
 * this module is what folds the two back into the one string the rest of
 * the app reads: `#rrggbb` at full opacity, `#rrggbbaa` below it. Both
 * are ordinary CSS colours, and both are what a canvas `fillStyle`
 * takes, so nothing downstream has to learn about the split.
 */

import { themeColorFor } from "./style-modal-preview.js";
import { splitAlphaColor, joinAlphaColor } from "../ui/color-picker.js";

// Three per-appearance overrides live outside this list, each beside
// the control it colours, with both appearances editable there at once:
// the line indicator's in Editing (behind its "Custom color" checkbox —
// an indicator set to "none" has no colour to pick), and the caret's and
// its glow's in the Cursor section (style-modal-cursor.js).
const COLOR_KEYS = [
  { key: "bg", label: "Background" }, { key: "fg", label: "Text" },
  { key: "header", label: "Header" }, { key: "links", label: "Links" },
  { key: "selection", label: "Selection" },
];

/**
 * The Colors section's rows for one appearance. `activeColors` is the
 * draft's override map for that appearance; `themeId` supplies the
 * fallback each unset row opens on.
 */
export function renderColorRows(draft, activeColors, colorTab, themeId) {
  return COLOR_KEYS.map((ck) => {
    const overrideVal = activeColors[ck.key];
    const { hex, alpha } = splitAlphaColor(overrideVal || themeColorFor(ck.key, themeId, colorTab));
    return `<div class="style-editor-color-row">
      <label>${ck.label}</label>
      <div class="style-color-group">
        <input type="color" data-color-key="${ck.key}" value="${hex}" data-alpha="${alpha}" />
        ${overrideVal ? `<button class="style-reset-color" data-color-key="${ck.key}" title="Reset">&times;</button>` : ''}
      </div>
    </div>`;
  }).join("");
}

/**
 * Wire the rendered rows. `ctx` carries what the handlers need from the
 * modal's closure: the draft, which appearance is on show, and the three
 * callbacks (`updatePreview`, `scheduleSave`, `render`).
 */
export function bindColorRows(backdrop, ctx) {
  const { draft, colorTab, updatePreview, scheduleSave, render } = ctx;
  const mapFor = () => (colorTab === "light" ? draft.lightColors : draft.darkColors);

  backdrop.querySelectorAll(".style-editor-color-row input[type='color'][data-color-key]").forEach((input) => {
    input.addEventListener("input", () => {
      // `dataset.alpha` is the picker's other half — see the module
      // header. Absent means the platform panel wrote the value (or
      // nothing has touched it yet), which is always fully opaque.
      mapFor()[input.dataset.colorKey] = joinAlphaColor(input.value, input.dataset.alpha);
      updatePreview();
      scheduleSave();
    });
  });

  backdrop.querySelectorAll(".style-reset-color[data-color-key]").forEach((btn) => {
    btn.addEventListener("click", () => {
      delete mapFor()[btn.dataset.colorKey];
      render();
      scheduleSave();
    });
  });
}
