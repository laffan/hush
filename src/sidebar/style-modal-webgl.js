/**
 * WebGL-layer options for the Background Layers section — effect picker,
 * master intensity, the per-effect knobs from the effects registry, and
 * the Caret Effects block (presets that feed the caret position into
 * the shader: sparks / bubbles / ripples). Split out of
 * style-modal-background.js for the 700-line cap.
 */
import { WEBGL_BG_EFFECTS, CARET_EFFECTS, resolveEffectOptions } from "../background-layers/effects-registry.js";
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
  const caretEffect = layer.caretEffect || "none";
  const caretActive = caretEffect !== "none";
  const caretColor = layer.caretColor || "#9ecbff";
  const caretIntensity = typeof layer.caretIntensity === "number" ? layer.caretIntensity : 0.6;
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
    ${(reg.settings || []).map(s => knobHtml(s, resolved[s.id])).join("")}
    <h4 class="style-modal-subsection-title">Caret Effects</h4>
    <div class="style-editor-row">
      <label>Preset</label>
      <select id="style-caret-effect" class="style-native-select">
        ${CARET_EFFECTS.map(c => `<option value="${escAttr(c.id)}"${c.id === caretEffect ? " selected" : ""}>${escHtml(c.name)}</option>`).join("")}
      </select>
    </div>
    <div class="style-caret-knobs${caretActive ? "" : " style-row-hidden"}">
      <div class="style-editor-color-row">
        <label>Color</label>
        <div class="style-color-group">
          <input type="color" id="style-caret-color" value="${escAttr(caretColor)}" />
        </div>
      </div>
      <div class="style-editor-row">
        <label>Intensity</label>
        <div class="style-slider-group">
          <input type="range" id="style-caret-intensity" min="0" max="1" step="0.01" value="${caretIntensity}" />
          <span class="style-slider-value">${Math.round(caretIntensity * 100)}%</span>
        </div>
      </div>
    </div>`;
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

  const caretEl = container.querySelector("#style-caret-effect");
  if (caretEl) caretEl.addEventListener("change", () => {
    layer.caretEffect = caretEl.value;
    container.querySelector(".style-caret-knobs")?.classList.toggle("style-row-hidden", caretEl.value === "none");
    onCommit();
  });

  const caretColorEl = container.querySelector("#style-caret-color");
  if (caretColorEl) {
    const handler = () => { layer.caretColor = caretColorEl.value; onCommit(); };
    caretColorEl.addEventListener("input", handler);
    caretColorEl.addEventListener("change", handler);
  }

  const caretIntEl = container.querySelector("#style-caret-intensity");
  if (caretIntEl) caretIntEl.addEventListener("input", () => {
    const v = parseFloat(caretIntEl.value);
    layer.caretIntensity = v;
    if (caretIntEl.nextElementSibling) caretIntEl.nextElementSibling.textContent = Math.round(v * 100) + "%";
    onCommit();
  });
}
