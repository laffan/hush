/**
 * Flags settings tab — manages flag types, colors, and custom flags.
 * Replaces the former LongView settings tab in the settings window.
 */

/** Fixed flag types that cannot be removed (only color can be changed) */
const FIXED_FLAGS = ["TODO", "MISSING", "COMMENT"];

const DEFAULT_FLAG_COLORS = {
  TODO: "#ffd700",
  MISSING: "#ff4444",
  COMMENT: "#888888",
  REWRITE: "#ff66aa",
  RESEARCH: "#66aaff",
};

export function renderFlagsTab(settings) {
  const flagColors = settings.flagColors || { ...DEFAULT_FLAG_COLORS };
  const customFlags = settings.customFlags || [
    { name: "REWRITE", color: "#ff66aa" },
    { name: "RESEARCH", color: "#66aaff" },
  ];

  let fixedHtml = "";
  for (const name of FIXED_FLAGS) {
    const color = flagColors[name] || DEFAULT_FLAG_COLORS[name] || "#4488ff";
    fixedHtml += `
      <div class="settings-row flag-row">
        <span class="flag-name-fixed">${name}</span>
        <span class="flag-preview" style="background:${color};color:${getFgColor(color)};padding:2px 8px;border-radius:3px;font-size:11px;">${name}</span>
        <input type="color" class="flag-color-input" data-flag-fixed="${name}" value="${color}" />
      </div>
    `;
  }

  let customHtml = "";
  customFlags.forEach((flag, i) => {
    const color = flagColors[flag.name.toUpperCase()] || flag.color || "#66aaff";
    customHtml += `
      <div class="settings-row flag-row" data-flag-index="${i}">
        <input type="text" class="flag-name-input" data-flag-idx="${i}" value="${flag.name}" placeholder="FLAG NAME" />
        <span class="flag-preview" style="background:${color};color:${getFgColor(color)};padding:2px 8px;border-radius:3px;font-size:11px;">${flag.name}</span>
        <input type="color" class="flag-color-input-custom" data-flag-idx="${i}" value="${color}" />
        <button class="flag-delete-btn" data-flag-idx="${i}" title="Remove flag">×</button>
      </div>
    `;
  });

  return `
    <div class="settings-section">
      <h2>Built-in Flags</h2>
      <p class="settings-hint">These flags are always available. You can change their colors.</p>
      ${fixedHtml}
    </div>

    <div class="settings-section">
      <h2>Custom Flags</h2>
      <p class="settings-hint">Add your own flag types using <code>==NAME: message==</code> syntax in your documents.</p>
      <div id="custom-flags-list">
        ${customHtml}
      </div>
      <div class="flag-actions-row">
        <button id="flag-add-btn" class="flag-action-btn">+ Add Flag</button>
        <button id="flag-reset-btn" class="flag-action-btn flag-reset">Reset to Defaults</button>
      </div>
    </div>
  `;
}

/**
 * Bind Flags settings controls.
 * @param {function} saveSetting - Function to save a single setting key/value
 * @param {object} settings - Current settings object
 * @param {function} rerender - Function to re-render the settings UI
 */
export function bindFlagsTab(saveSetting, settings, rerender) {
  // Fixed flag color pickers
  document.querySelectorAll(".flag-color-input").forEach(input => {
    input.addEventListener("input", () => {
      const name = input.dataset.flagFixed;
      const colors = { ...(settings.flagColors || { ...DEFAULT_FLAG_COLORS }) };
      colors[name] = input.value;
      saveSetting("flagColors", colors);
      settings.flagColors = colors;
      rerender();
    });
  });

  // Custom flag name inputs
  document.querySelectorAll(".flag-name-input").forEach(input => {
    input.addEventListener("change", () => {
      const idx = parseInt(input.dataset.flagIdx);
      const customFlags = [...(settings.customFlags || [])];
      const colors = { ...(settings.flagColors || { ...DEFAULT_FLAG_COLORS }) };
      const oldName = customFlags[idx].name.toUpperCase();
      const newName = input.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 25);
      if (!newName || FIXED_FLAGS.includes(newName)) {
        input.value = customFlags[idx].name;
        return;
      }
      // Move color from old key to new key
      const oldColor = colors[oldName] || customFlags[idx].color;
      delete colors[oldName];
      colors[newName] = oldColor;
      customFlags[idx] = { name: newName, color: oldColor };
      input.value = newName;
      settings.customFlags = customFlags;
      settings.flagColors = colors;
      saveSetting("customFlags", customFlags);
      saveSetting("flagColors", colors);
      rerender();
    });
  });

  // Custom flag color pickers
  document.querySelectorAll(".flag-color-input-custom").forEach(input => {
    input.addEventListener("input", () => {
      const idx = parseInt(input.dataset.flagIdx);
      const customFlags = [...(settings.customFlags || [])];
      const colors = { ...(settings.flagColors || { ...DEFAULT_FLAG_COLORS }) };
      const name = customFlags[idx].name.toUpperCase();
      colors[name] = input.value;
      customFlags[idx] = { ...customFlags[idx], color: input.value };
      settings.customFlags = customFlags;
      settings.flagColors = colors;
      saveSetting("customFlags", customFlags);
      saveSetting("flagColors", colors);
      rerender();
    });
  });

  // Delete buttons
  document.querySelectorAll(".flag-delete-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.flagIdx);
      const customFlags = [...(settings.customFlags || [])];
      const colors = { ...(settings.flagColors || { ...DEFAULT_FLAG_COLORS }) };
      const name = customFlags[idx].name.toUpperCase();
      delete colors[name];
      customFlags.splice(idx, 1);
      settings.customFlags = customFlags;
      settings.flagColors = colors;
      saveSetting("customFlags", customFlags);
      saveSetting("flagColors", colors);
      rerender();
    });
  });

  // Add flag button
  const addBtn = document.getElementById("flag-add-btn");
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      const customFlags = [...(settings.customFlags || [])];
      const colors = { ...(settings.flagColors || { ...DEFAULT_FLAG_COLORS }) };
      let name = "NEWFLAG";
      let n = 1;
      while (colors[name] || FIXED_FLAGS.includes(name)) {
        name = "NEWFLAG" + n++;
      }
      customFlags.push({ name, color: "#66aaff" });
      colors[name] = "#66aaff";
      settings.customFlags = customFlags;
      settings.flagColors = colors;
      saveSetting("customFlags", customFlags);
      saveSetting("flagColors", colors);
      rerender();
    });
  }

  // Reset button
  const resetBtn = document.getElementById("flag-reset-btn");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      const colors = { ...DEFAULT_FLAG_COLORS };
      const customFlags = [
        { name: "REWRITE", color: "#ff66aa" },
        { name: "RESEARCH", color: "#66aaff" },
      ];
      settings.flagColors = colors;
      settings.customFlags = customFlags;
      saveSetting("flagColors", colors);
      saveSetting("customFlags", customFlags);
      rerender();
    });
  }
}

/** Determine a legible foreground color (dark or light) for a given background hex. */
function getFgColor(hex) {
  hex = hex.replace("#", "");
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.5 ? "#1a1a1a" : "#f0f0f0";
}
