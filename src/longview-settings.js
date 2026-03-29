/**
 * LongView settings tab — renders and binds the Long View settings panel.
 * Extracted to keep settings-window.js under the 700-line limit.
 */

export function renderLongViewTab(settings) {
  const s = settings;
  return `
    <div class="settings-section">
      <h2>Minimap Display</h2>
      <div class="settings-row">
        <label>Show paragraph text</label>
        <input type="checkbox" id="setting-lv-paragraphs" ${s.longviewShowParagraphs !== false ? "checked" : ""} />
      </div>
      <div class="settings-row">
        <label>Show section numbers</label>
        <input type="checkbox" id="setting-lv-numbers" ${s.longviewShowNumbers !== false ? "checked" : ""} />
      </div>
      <div class="settings-row">
        <label>Show comments</label>
        <input type="checkbox" id="setting-lv-comments" ${s.longviewShowComments ? "checked" : ""} />
      </div>
      <div class="settings-row">
        <label>Show flags</label>
        <input type="checkbox" id="setting-lv-flags" ${s.longviewShowFlags !== false ? "checked" : ""} />
      </div>
      <div class="settings-row">
        <label>Show flag type labels</label>
        <input type="checkbox" id="setting-lv-flag-types" ${s.longviewShowFlagTypes ? "checked" : ""} />
      </div>
      <div class="settings-row">
        <label>Wrap flag text</label>
        <input type="checkbox" id="setting-lv-wrap-flags" ${s.longviewWrapFlagText !== false ? "checked" : ""} />
      </div>
    </div>

    <div class="settings-section">
      <h2>Minimap Text Size</h2>
      <div class="settings-slider-row">
        <label>Paragraph text size</label>
        <div class="slider-group">
          <input type="range" id="setting-lv-body-font" min="1" max="8" step="0.5" value="${s.longviewBodyFontSize || 3}" />
          <span class="slider-value">${s.longviewBodyFontSize || 3}px</span>
        </div>
      </div>
      <div class="settings-slider-row">
        <label>Heading text size</label>
        <div class="slider-group">
          <input type="range" id="setting-lv-heading-font" min="8" max="20" step="1" value="${s.longviewHeadingFontSize || 12}" />
          <span class="slider-value">${s.longviewHeadingFontSize || 12}px</span>
        </div>
      </div>
      <div class="settings-slider-row">
        <label>Flag label size</label>
        <div class="slider-group">
          <input type="range" id="setting-lv-flag-font" min="8" max="18" step="1" value="${s.longviewFlagFontSize || 12}" />
          <span class="slider-value">${s.longviewFlagFontSize || 12}px</span>
        </div>
      </div>
      <div class="settings-slider-row">
        <label>Line height / gap</label>
        <div class="slider-group">
          <input type="range" id="setting-lv-line-gap" min="0" max="8" step="0.5" value="${s.longviewLineGap != null ? s.longviewLineGap : 2}" />
          <span class="slider-value">${s.longviewLineGap != null ? s.longviewLineGap : 2}px</span>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h2>Current Position</h2>
      <div class="settings-row">
        <label>Highlight color</label>
        <input type="color" id="setting-lv-position-color" value="${s.longviewCurrentPositionColor || '#ff0000'}" />
      </div>
    </div>
  `;
}

/**
 * Bind LongView settings controls.
 * @param {function} bindCheckbox
 * @param {function} bindSlider
 * @param {function} saveSetting
 */
export function bindLongViewTab(bindCheckbox, bindSlider, saveSetting) {
  bindCheckbox("setting-lv-paragraphs", "longviewShowParagraphs");
  bindCheckbox("setting-lv-numbers", "longviewShowNumbers");
  bindCheckbox("setting-lv-comments", "longviewShowComments");
  bindCheckbox("setting-lv-flags", "longviewShowFlags");
  bindCheckbox("setting-lv-flag-types", "longviewShowFlagTypes");
  bindCheckbox("setting-lv-wrap-flags", "longviewWrapFlagText");
  bindSlider("setting-lv-body-font", "longviewBodyFontSize", "px");
  bindSlider("setting-lv-heading-font", "longviewHeadingFontSize", "px");
  bindSlider("setting-lv-flag-font", "longviewFlagFontSize", "px");
  bindSlider("setting-lv-line-gap", "longviewLineGap", "px");
  const lvColorInput = document.getElementById("setting-lv-position-color");
  if (lvColorInput) {
    lvColorInput.addEventListener("input", () => saveSetting("longviewCurrentPositionColor", lvColorInput.value));
  }
}
