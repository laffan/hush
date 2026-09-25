/**
 * Style modal — the Cursor section: the shape dropdown and the caret's
 * colour for both appearances, then, for a custom cursor, the Idle
 * Animation dropdown, one Glow row holding the Light and Dark switches
 * side by side, the glow's colour for each appearance that glows, and
 * the glow's intensity.
 *
 * Split out of `style-modal.js` for the 700-line cap. The readers the
 * editor paints from live in `editor/cursor-options.js`; this module only
 * owns the markup and the draft writes.
 *
 * ## Colours
 *
 * The caret and glow colours are per-appearance overrides like the rows
 * in Colors — `cursor` / `cursorGlow` in `lightColors` / `darkColors` —
 * but both halves are shown here at once, the way the Glow switches
 * are, so the section reads the same whichever appearance the preview
 * is on. The caret colour applies to every mode (the system caret takes
 * it too, through `--cursor`); the glow colour only exists while that
 * appearance's glow is switched on.
 *
 * ## Legacy fields
 *
 * The draft keeps the retired single `cursorGlow` in lockstep (on when
 * either appearance glows), and the retired `cursorBlink` switch in
 * lockstep with the idle animation (off only for "none"), the same way
 * `blockCursor` shadows `cursorMode` — so an older client reading the
 * same JSON still sees a glowing, blinking or steady caret as close to
 * this one as it can draw.
 */

import { resolveCursorMode, renderCursorOptions } from "./styles-panel-shared.js";
import {
  glowForAppearance,
  hasAnyGlow,
  glowIntensity,
  cursorIdleAnimation,
  IDLE_ANIMATIONS,
  GLOW_INTENSITY_MIN,
  GLOW_INTENSITY_MAX,
} from "../editor/cursor-options.js";
import { themeColorFor } from "./style-modal-preview.js";
import { getThemeById } from "../themes/index.js";
import { splitAlphaColor, joinAlphaColor } from "../ui/color-picker.js";

const APPEARANCES = [
  { tab: "light", label: "Light" },
  { tab: "dark", label: "Dark" },
];

function colorsFor(draft, tab) {
  return (tab === "light" ? draft.lightColors : draft.darkColors) || {};
}

function themeIdFor(draft, tab) {
  return tab === "light" ? draft.lightThemeId : draft.darkThemeId;
}

/** The colour a swatch opens on when it has no override — what is
 *  actually drawn, so a first drag starts from the caret on screen. The
 *  system caret falls back to the theme's text colour; a custom one to
 *  the theme's heading colour (block-cursor.js#resolveCursorPaint). The
 *  glow's default is the caret's own colour. */
function seedColor(draft, key, tab, mode) {
  const colors = colorsFor(draft, tab);
  if (key === "cursorGlow" && colors.cursor) return colors.cursor;
  const themeId = themeIdFor(draft, tab);
  if (mode !== "system") {
    const heading = getThemeById(themeId)?.headingColor;
    if (heading) return heading;
  }
  return themeColorFor(key, themeId, tab);
}

/** One appearance's swatch (and its reset while an override is set).
 *  `data-alpha` opts the swatch into the picker's opacity slider, the
 *  same as the rows in Colors. */
function swatchCell(draft, key, tab, label, mode) {
  const override = colorsFor(draft, tab)[key];
  const { hex, alpha } = splitAlphaColor(override || seedColor(draft, key, tab, mode));
  return `
                  <span class="style-appearance-swatch">
                    <span class="style-appearance-swatch-label">${label}</span>
                    <span class="style-color-group">
                      <input type="color" data-cursor-color-key="${key}" data-appearance="${tab}" value="${hex}" data-alpha="${alpha}" aria-label="${label} ${key === "cursor" ? "cursor" : "glow"} color" />
                      ${override ? `<button class="style-reset-color" data-cursor-color-key="${key}" data-appearance="${tab}" title="Reset">&times;</button>` : ""}
                    </span>
                  </span>`;
}

/** A row of the two appearance swatches. `showFor(tab)` leaves a cell
 *  empty (keeping the columns aligned with the Glow switches above). */
function swatchPairRow(draft, mode, key, rowLabel, showFor = () => true) {
  return `
              <div class="style-editor-row">
                <label>${rowLabel}</label>
                <div class="style-glow-pair">
                  ${APPEARANCES.map(a => showFor(a.tab) ? swatchCell(draft, key, a.tab, a.label, mode) : "<span></span>").join("")}
                </div>
              </div>`;
}

export function renderCursorSection(draft, settings) {
  const mode = resolveCursorMode(draft, settings);
  const intensity = glowIntensity(draft);
  const idle = cursorIdleAnimation(draft);
  return `
            <div class="style-modal-section">
              <h3 class="style-modal-section-title">Cursor</h3>
              <div class="style-editor-row">
                <label>Shape</label>
                <div class="style-select-group">
                  <select id="style-cursor-mode" class="style-native-select">
                    ${renderCursorOptions(mode)}
                  </select>
                </div>
              </div>
              ${swatchPairRow(draft, mode, "cursor", "Color")}
              ${mode === "system" ? "" : `
              <div class="style-editor-row">
                <label>Idle Animation</label>
                <div class="style-select-group">
                  <select id="style-cursor-idle" class="style-native-select">
                    ${IDLE_ANIMATIONS.map(a => `<option value="${a.value}"${a.value === idle ? " selected" : ""}>${a.label}</option>`).join("")}
                  </select>
                </div>
              </div>
              <div class="style-editor-row">
                <label>Glow</label>
                <div class="style-glow-pair">
                  <label class="style-glow-option"><input type="checkbox" id="style-cursor-glow-light"${glowForAppearance(draft, "light") ? " checked" : ""} /><span>Light</span></label>
                  <label class="style-glow-option"><input type="checkbox" id="style-cursor-glow-dark"${glowForAppearance(draft, "dark") ? " checked" : ""} /><span>Dark</span></label>
                </div>
              </div>
              ${hasAnyGlow(draft) ? `
              ${swatchPairRow(draft, mode, "cursorGlow", "Glow color", (tab) => glowForAppearance(draft, tab))}
              <div class="style-editor-row">
                <label>Glow intensity</label>
                <div class="style-slider-group">
                  <input type="range" id="style-cursor-glow-intensity" min="${GLOW_INTENSITY_MIN}" max="${GLOW_INTENSITY_MAX}" step="0.05" value="${intensity}" />
                  <span class="style-slider-value">${intensity.toFixed(2)}x</span>
                </div>
              </div>` : ""}`}
            </div>`;
}

/**
 * `render` rebuilds the modal (rows come and go with the mode and the
 * glow switches); `onLive` repaints the preview and schedules a save
 * without a rebuild, for the slider's drag and the swatches.
 */
export function bindCursorSection(backdrop, draft, { render, onLive, scheduleSave }) {
  const cursorEl = backdrop.querySelector("#style-cursor-mode");
  if (cursorEl) cursorEl.addEventListener("change", () => {
    const mode = cursorEl.value || "system";
    draft.cursorMode = mode;
    // Keep `blockCursor` in lockstep for backwards-compat with
    // existing consumers (settings serializer, exported styles, sync).
    draft.blockCursor = mode === "block";
    // The system caret wears no glow, and the switches for it go with
    // the mode — leaving them set would hide a state the user can no
    // longer see or reach.
    if (mode === "system") {
      draft.cursorGlow = false;
      draft.cursorGlowLight = false;
      draft.cursorGlowDark = false;
    }
    render();
    scheduleSave();
  });

  const idleEl = backdrop.querySelector("#style-cursor-idle");
  if (idleEl) idleEl.addEventListener("change", () => {
    draft.cursorIdleAnimation = idleEl.value || "blink";
    draft.cursorBlink = draft.cursorIdleAnimation !== "none";
    onLive();
  });

  const lightEl = backdrop.querySelector("#style-cursor-glow-light");
  const darkEl = backdrop.querySelector("#style-cursor-glow-dark");
  const onGlow = () => {
    // Both halves are written explicitly once either is touched, so the
    // legacy single flag stops standing in for the other appearance.
    draft.cursorGlowLight = !!lightEl?.checked;
    draft.cursorGlowDark = !!darkEl?.checked;
    draft.cursorGlow = draft.cursorGlowLight || draft.cursorGlowDark;
    // Re-render rather than patch: the switches add (or remove) the
    // glow's colour swatches and its intensity slider.
    render();
    scheduleSave();
  };
  if (lightEl) lightEl.addEventListener("change", onGlow);
  if (darkEl) darkEl.addEventListener("change", onGlow);

  const intensityEl = backdrop.querySelector("#style-cursor-glow-intensity");
  if (intensityEl) intensityEl.addEventListener("input", () => {
    const v = parseFloat(intensityEl.value);
    draft.cursorGlowIntensity = v;
    intensityEl.nextElementSibling.textContent = v.toFixed(2) + "x";
    onLive();
  });

  const mapFor = (tab) => tab === "light"
    ? (draft.lightColors || (draft.lightColors = {}))
    : (draft.darkColors || (draft.darkColors = {}));

  backdrop.querySelectorAll("input[type='color'][data-cursor-color-key]").forEach((input) => {
    input.addEventListener("input", () => {
      // `dataset.alpha` is the picker's opacity — see style-modal-colors.js.
      mapFor(input.dataset.appearance)[input.dataset.cursorColorKey] =
        joinAlphaColor(input.value, input.dataset.alpha);
      onLive();
    });
  });

  backdrop.querySelectorAll(".style-reset-color[data-cursor-color-key]").forEach((btn) => {
    btn.addEventListener("click", () => {
      delete mapFor(btn.dataset.appearance)[btn.dataset.cursorColorKey];
      render();
      scheduleSave();
    });
  });
}
