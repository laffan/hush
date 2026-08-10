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

export function renderCaretOptions(layer) {
  const preset = layer.preset || "sparks";
  const color = layer.color || "#9ecbff";
  const intensity = typeof layer.intensity === "number" ? layer.intensity : 0.6;
  return `
    <div class="style-editor-row">
      <label>Preset</label>
      <select id="style-caret-preset" class="style-native-select">
        ${CARET_PRESETS.map(c => `<option value="${escAttr(c.id)}"${c.id === preset ? " selected" : ""}>${escHtml(c.name)}</option>`).join("")}
      </select>
    </div>
    <div class="style-editor-color-row">
      <label>Color</label>
      <div class="style-color-group">
        <input type="color" id="style-caret-color" value="${escAttr(color)}" />
      </div>
    </div>
    <div class="style-editor-row">
      <label>Intensity</label>
      <div class="style-slider-group">
        <input type="range" id="style-caret-intensity" min="0" max="1" step="0.01" value="${intensity}" />
        <span class="style-slider-value">${Math.round(intensity * 100)}%</span>
      </div>
    </div>
    <p class="style-editor-hint">Follows the text cursor as you type.</p>`;
}

export function bindCaretOptions(container, layer, { onCommit, rerender }) {
  const presetEl = container.querySelector("#style-caret-preset");
  if (presetEl) presetEl.addEventListener("change", () => {
    layer.preset = presetEl.value;
    rerender(); // the row label carries the preset name
    onCommit();
  });

  const colorEl = container.querySelector("#style-caret-color");
  if (colorEl) {
    const handler = () => { layer.color = colorEl.value; onCommit(); };
    colorEl.addEventListener("input", handler);
    colorEl.addEventListener("change", handler);
  }

  const intEl = container.querySelector("#style-caret-intensity");
  if (intEl) intEl.addEventListener("input", () => {
    const v = parseFloat(intEl.value);
    layer.intensity = v;
    if (intEl.nextElementSibling) intEl.nextElementSibling.textContent = Math.round(v * 100) + "%";
    onCommit();
  });
}
