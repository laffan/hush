/**
 * Options blocks for the two shader-backed background layer types:
 * WebGL layers (effect picker, master intensity, and the per-effect
 * knobs from the effects registry) and Caret layers (preset, colour,
 * intensity — the effect that follows the text cursor). Split out of
 * style-modal-background.js for the 700-line cap.
 */
import { WEBGL_BG_EFFECTS, CARET_PRESETS, resolveEffectOptions } from "../background-layers/effects-registry.js";
import { escAttr, escHtml } from "./styles-panel-shared.js";

function knobHtml(s, v) {
  if (s.type === "range") {
    const min = s.min ?? 0;
    const max = s.max ?? 1;
    const step = s.step ?? 0.01;
    const display = step >= 1 ? `${v}` : `${Math.round(v * 100)}%`;
    return `<div class="style-editor-row">
      <label>${escHtml(s.label)}</label>
      <div class="style-slider-group">
        <input type="range" data-effect-opt="${escAttr(s.id)}" min="${min}" max="${max}" step="${step}" value="${v}" />
        <span class="style-slider-value">${escHtml(display)}</span>
      </div>
    </div>`;
  }
  if (s.type === "color") {
    return `<div class="style-editor-color-row">
      <label>${escHtml(s.label)}</label>
      <div class="style-color-group">
        <input type="color" data-effect-opt="${escAttr(s.id)}" value="${escAttr(v)}" />
      </div>
    </div>`;
  }
  return "";
}

export function renderWebglOptions(layer) {
  const effectId = layer.effectId || WEBGL_BG_EFFECTS[0].id;
  const reg = WEBGL_BG_EFFECTS.find(e => e.id === effectId) || WEBGL_BG_EFFECTS[0];
  const intensity = typeof layer.intensity === "number" ? layer.intensity : 0.5;
  const resolved = resolveEffectOptions(reg.id, layer.options);
  return `
    <div class="style-editor-row">
      <label>Effect</label>
      <select id="style-webgl-effect" class="style-native-select">
        ${WEBGL_BG_EFFECTS.map(e => `<option value="${escAttr(e.id)}"${e.id === reg.id ? " selected" : ""}>${escHtml(e.name)}</option>`).join("")}
      </select>
    </div>
    <div class="style-editor-row">
      <label>Master intensity</label>
      <div class="style-slider-group">
        <input type="range" id="style-webgl-intensity" min="0" max="1" step="0.01" value="${intensity}" />
        <span class="style-slider-value">${Math.round(intensity * 100)}%</span>
      </div>
    </div>
    ${(reg.settings || []).map(s => knobHtml(s, resolved[s.id])).join("")}`;
}

export function bindWebglOptions(container, layer, { onCommit, rerender }) {
  const effectEl = container.querySelector("#style-webgl-effect");
  if (effectEl) effectEl.addEventListener("change", () => {
    layer.effectId = effectEl.value;
    rerender(); // different effect → different knobs
    onCommit();
  });

  const intEl = container.querySelector("#style-webgl-intensity");
  if (intEl) intEl.addEventListener("input", () => {
    const v = parseFloat(intEl.value);
    layer.intensity = v;
    if (intEl.nextElementSibling) intEl.nextElementSibling.textContent = Math.round(v * 100) + "%";
    onCommit();
  });

  container.querySelectorAll("[data-effect-opt]").forEach((input) => {
    const optId = input.dataset.effectOpt;
    const handler = () => {
      layer.options = layer.options || {};
      if (input.type === "range") {
        const v = parseFloat(input.value);
        layer.options[optId] = v;
        const display = input.nextElementSibling;
        if (display) {
          const step = parseFloat(input.step);
          display.textContent = step >= 1 ? `${v}` : `${Math.round(v * 100)}%`;
        }
      } else {
        layer.options[optId] = input.value;
      }
      onCommit();
    };
    input.addEventListener("input", handler);
    if (input.type === "color") input.addEventListener("change", handler);
  });
}

// Per-preset knob bounds, shared by the renderer and the binder.
const UNDERLINE_HEIGHT = { min: 1, max: 12, step: 0.5, default: 3 };
const UNDERLINE_TRAIL = { min: 0.5, max: 8, step: 0.1, default: 3.5 };
const HUD_RINGS = { min: 1, max: 10, step: 1, default: 2 };
const BLOB_SIZE = { min: 0.5, max: 3, step: 0.05, default: 1 };
const BLOB_SPEED = { min: 0.1, max: 2.5, step: 0.05, default: 1 };

export function renderCaretOptions(layer) {
  const preset = layer.preset || "sparks";
  const matchCaret = !!layer.matchCaret;
  // `color` is what caret layers carried before light and dark could
  // diverge — it seeds both pickers so an existing layer opens on its
  // current colour rather than the stock blue.
  const lightColor = layer.lightColor || layer.color || "#9ecbff";
  const darkColor = layer.darkColor || layer.color || "#9ecbff";
  const intensity = typeof layer.intensity === "number" ? layer.intensity : 0.6;
  const height = typeof layer.height === "number" ? layer.height : UNDERLINE_HEIGHT.default;
  const trail = typeof layer.trailSeconds === "number" ? layer.trailSeconds : UNDERLINE_TRAIL.default;
  const rings = typeof layer.rings === "number" ? layer.rings : HUD_RINGS.default;
  const blobSize = typeof layer.blobSize === "number" ? layer.blobSize : BLOB_SIZE.default;
  const blobSpeed = typeof layer.blobSpeed === "number" ? layer.blobSpeed : BLOB_SPEED.default;
  const blobRows = preset !== "blob" ? "" : `
    <div class="style-editor-row">
      <label>Size</label>
      <div class="style-slider-group">
        <input type="range" id="style-caret-blobsize" min="${BLOB_SIZE.min}" max="${BLOB_SIZE.max}" step="${BLOB_SIZE.step}" value="${blobSize}" />
        <span class="style-slider-value">${blobSize.toFixed(2)}x</span>
      </div>
    </div>
    <div class="style-editor-row">
      <label>Flow speed</label>
      <div class="style-slider-group">
        <input type="range" id="style-caret-blobspeed" min="${BLOB_SPEED.min}" max="${BLOB_SPEED.max}" step="${BLOB_SPEED.step}" value="${blobSpeed}" />
        <span class="style-slider-value">${blobSpeed.toFixed(2)}x</span>
      </div>
    </div>
    <div class="style-editor-row">
      <label>Rainbow</label>
      <div class="style-checkbox-group">
        <input type="checkbox" id="style-caret-rainbow" ${layer.rainbow ? "checked" : ""} />
      </div>
    </div>`;
  const hudRows = preset !== "hud" ? "" : `
    <div class="style-editor-row">
      <label>Rings</label>
      <div class="style-slider-group">
        <input type="range" id="style-caret-rings" min="${HUD_RINGS.min}" max="${HUD_RINGS.max}" step="${HUD_RINGS.step}" value="${rings}" />
        <span class="style-slider-value">${rings}</span>
      </div>
    </div>`;
  const underlineRows = preset !== "underline" ? "" : `
    <div class="style-editor-row">
      <label>Height</label>
      <div class="style-slider-group">
        <input type="range" id="style-caret-height" min="${UNDERLINE_HEIGHT.min}" max="${UNDERLINE_HEIGHT.max}" step="${UNDERLINE_HEIGHT.step}" value="${height}" />
        <span class="style-slider-value">${height}px</span>
      </div>
    </div>
    <div class="style-editor-row">
      <label>Trail length</label>
      <div class="style-slider-group">
        <input type="range" id="style-caret-trail" min="${UNDERLINE_TRAIL.min}" max="${UNDERLINE_TRAIL.max}" step="${UNDERLINE_TRAIL.step}" value="${trail}" />
        <span class="style-slider-value">${trail.toFixed(1)}s</span>
      </div>
    </div>`;
  return `
    <div class="style-editor-row">
      <label>Preset</label>
      <select id="style-caret-preset" class="style-native-select">
        ${CARET_PRESETS.map(c => `<option value="${escAttr(c.id)}"${c.id === preset ? " selected" : ""}>${escHtml(c.name)}</option>`).join("")}
      </select>
    </div>
    <div class="style-editor-row">
      <label>Match caret color</label>
      <div class="style-checkbox-group">
        <input type="checkbox" id="style-caret-match" ${matchCaret ? "checked" : ""} />
      </div>
    </div>
    ${matchCaret ? "" : `
    <div class="style-editor-color-row">
      <label>Color (Light)</label>
      <div class="style-color-group">
        <input type="color" id="style-caret-color-light" value="${escAttr(lightColor)}" />
      </div>
    </div>
    <div class="style-editor-color-row">
      <label>Color (Dark)</label>
      <div class="style-color-group">
        <input type="color" id="style-caret-color-dark" value="${escAttr(darkColor)}" />
      </div>
    </div>`}
    <div class="style-editor-row">
      <label>Intensity</label>
      <div class="style-slider-group">
        <input type="range" id="style-caret-intensity" min="0" max="1" step="0.01" value="${intensity}" />
        <span class="style-slider-value">${Math.round(intensity * 100)}%</span>
      </div>
    </div>
    <div class="style-editor-row">
      <label>Anti-alias</label>
      <div class="style-checkbox-group">
        <input type="checkbox" id="style-caret-antialias" ${layer.antialias !== false ? "checked" : ""} />
      </div>
    </div>
    ${hudRows}
    ${blobRows}
    ${underlineRows}
    <p class="style-editor-hint">Follows the text cursor as you type.</p>`;
}

export function bindCaretOptions(container, layer, { onCommit, rerender }) {
  const presetEl = container.querySelector("#style-caret-preset");
  if (presetEl) presetEl.addEventListener("change", () => {
    layer.preset = presetEl.value;
    rerender(); // the row label carries the preset name, and the
                // underline knobs appear / disappear with it
    onCommit();
  });

  const matchEl = container.querySelector("#style-caret-match");
  if (matchEl) matchEl.addEventListener("change", () => {
    layer.matchCaret = matchEl.checked;
    rerender(); // showing / hiding the two colour pickers
    onCommit();
  });

  const bindColor = (sel, field) => {
    const el = container.querySelector(sel);
    if (!el) return;
    const handler = () => {
      layer[field] = el.value;
      // The single legacy `color` is ambiguous once the two diverge —
      // drop it so nothing downstream reads a stale shared value.
      delete layer.color;
      onCommit();
    };
    el.addEventListener("input", handler);
    el.addEventListener("change", handler);
  };
  bindColor("#style-caret-color-light", "lightColor");
  bindColor("#style-caret-color-dark", "darkColor");

  const bindRange = (sel, field, fmt) => {
    const el = container.querySelector(sel);
    if (!el) return;
    el.addEventListener("input", () => {
      const v = parseFloat(el.value);
      layer[field] = v;
      if (el.nextElementSibling) el.nextElementSibling.textContent = fmt(v);
      onCommit();
    });
  };
  bindRange("#style-caret-intensity", "intensity", (v) => Math.round(v * 100) + "%");
  bindRange("#style-caret-height", "height", (v) => v + "px");
  bindRange("#style-caret-trail", "trailSeconds", (v) => v.toFixed(1) + "s");
  bindRange("#style-caret-rings", "rings", (v) => String(v));
  bindRange("#style-caret-blobsize", "blobSize", (v) => v.toFixed(2) + "x");
  bindRange("#style-caret-blobspeed", "blobSpeed", (v) => v.toFixed(2) + "x");

  const aaEl = container.querySelector("#style-caret-antialias");
  if (aaEl) aaEl.addEventListener("change", () => {
    layer.antialias = aaEl.checked;
    onCommit();
  });

  const rainbowEl = container.querySelector("#style-caret-rainbow");
  if (rainbowEl) rainbowEl.addEventListener("change", () => {
    layer.rainbow = rainbowEl.checked;
    onCommit();
  });
}
