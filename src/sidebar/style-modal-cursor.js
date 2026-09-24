/**
 * Style modal — the cursor rows in Editing: the mode dropdown and, for a
 * custom cursor, Blink, one Glow row holding the Light and Dark switches
 * side by side, and the glow's intensity.
 *
 * Split out of `style-modal.js` for the 700-line cap. The readers the
 * editor paints from live in `editor/cursor-options.js`; this module only
 * owns the markup and the draft writes.
 *
 * The draft keeps the retired single `cursorGlow` in lockstep (on when
 * either appearance glows), the same way `blockCursor` shadows
 * `cursorMode`, so an older client reading the same JSON still sees a
 * glowing caret rather than none.
 */

import { resolveCursorMode, renderCursorOptions } from "./styles-panel-shared.js";
import {
  glowForAppearance,
  hasAnyGlow,
  glowIntensity,
  cursorBlinks,
  GLOW_INTENSITY_MIN,
  GLOW_INTENSITY_MAX,
} from "../editor/cursor-options.js";

function checkboxRow(id, label, checked) {
  return `
              <div class="style-editor-row">
                <label for="${id}">${label}</label>
                <div class="style-select-group">
                  <input type="checkbox" id="${id}"${checked ? " checked" : ""} />
                </div>
              </div>`;
}

export function renderCursorRows(draft, settings) {
  const mode = resolveCursorMode(draft, settings);
  const intensity = glowIntensity(draft);
  return `
              <div class="style-editor-row">
                <label>Cursor</label>
                <div class="style-select-group">
                  <select id="style-cursor-mode" class="style-native-select">
                    ${renderCursorOptions(mode)}
                  </select>
                </div>
              </div>
              ${mode === "system" ? "" : `
              ${checkboxRow("style-cursor-blink", "Blink", cursorBlinks(draft))}
              <div class="style-editor-row">
                <label>Glow</label>
                <div class="style-glow-pair">
                  <label class="style-glow-option"><input type="checkbox" id="style-cursor-glow-light"${glowForAppearance(draft, "light") ? " checked" : ""} /><span>Light</span></label>
                  <label class="style-glow-option"><input type="checkbox" id="style-cursor-glow-dark"${glowForAppearance(draft, "dark") ? " checked" : ""} /><span>Dark</span></label>
                </div>
              </div>
              ${hasAnyGlow(draft) ? `
              <div class="style-editor-row">
                <label>Glow intensity</label>
                <div class="style-slider-group">
                  <input type="range" id="style-cursor-glow-intensity" min="${GLOW_INTENSITY_MIN}" max="${GLOW_INTENSITY_MAX}" step="0.05" value="${intensity}" />
                  <span class="style-slider-value">${intensity.toFixed(2)}x</span>
                </div>
              </div>` : ""}`}`;
}

/**
 * `render` rebuilds the modal (rows come and go with the mode and the
 * glow switches); `onLive` repaints the preview and schedules a save
 * without a rebuild, for the slider's drag.
 */
export function bindCursorRows(backdrop, draft, { render, onLive, scheduleSave }) {
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

  const blinkEl = backdrop.querySelector("#style-cursor-blink");
  if (blinkEl) blinkEl.addEventListener("change", () => {
    draft.cursorBlink = !!blinkEl.checked;
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
    // intensity slider here and the Cursor Glow row in Colors.
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
}
