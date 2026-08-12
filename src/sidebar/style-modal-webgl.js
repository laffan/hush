/**
 * Options blocks for the two shader-backed background layer types:
 * WebGL layers (effect picker, master intensity, and the per-effect
 * knobs from the effects registry) and Caret layers (the effect that
 * follows the text cursor). Split out of style-modal-background.js for
 * the 700-line cap.
 *
 * A caret layer leads with a Color block: its own colour *and* its own
 * blend mode, each split light / dark. Both halves need their own value
 * because the effects are drawn as light on a dark ground — screen is
 * the only blend that reads in dark mode and the only one that can't
 * read in light mode (screening onto white returns white), which is why
 * the colour pickers used to look inert in the light half.
 */
import { WEBGL_BG_EFFECTS, CARET_PRESETS, resolveEffectOptions } from "../background-layers/effects-registry.js";
import { escAttr, escHtml } from "./styles-panel-shared.js";
import { blendRowHtml, renderOpacityRows } from "./style-layer-ui.js";

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
// The offset is a nudge from the preset's own resting placement, so 0 is
// the default and the range straddles it.
const UNDERLINE_OFFSET = { min: -8, max: 12, step: 0.5, default: 0 };
// How far a spark hops off the baseline before it winks out.
const SPARK_HEIGHT = { min: 2, max: 40, step: 1, default: 12 };

/** Offset readout — the sign carries the meaning, so 0 shows as "0px"
 *  and anything above it keeps its "+". */
const signedPx = (v) => (v > 0 ? "+" : "") + v + "px";

const numOr = (v, fallback) => (typeof v === "number" ? v : fallback);

function sliderRow(id, label, bounds, value, fmt) {
  return `
    <div class="style-editor-row">
      <label>${escHtml(label)}</label>
      <div class="style-slider-group">
        <input type="range" id="${id}" min="${bounds.min}" max="${bounds.max}" step="${bounds.step}" value="${value}" />
        <span class="style-slider-value">${escHtml(fmt(value))}</span>
      </div>
    </div>`;
}

export function renderCaretOptions(layer) {
  const preset = layer.preset || "sparks";
  const matchCaret = !!layer.matchCaret;
  // `color` is what caret layers carried before light and dark could
  // diverge — it seeds both pickers so an existing layer opens on its
  // current colour rather than the stock blue.
  const lightColor = layer.lightColor || layer.color || "#3b82f6";
  const darkColor = layer.darkColor || layer.color || "#9ecbff";
  // The pre-split single `blend` seeds the dark side only; see the
  // module header for why light always starts at multiply.
  const lightBlend = layer.lightBlend || "multiply";
  const darkBlend = layer.darkBlend || layer.blend || "screen";

  const colorRow = (id, label, value) => `
    <div class="style-editor-color-row">
      <label>${label}</label>
      <div class="style-color-group">
        <input type="color" id="${id}" value="${escAttr(value)}" />
      </div>
    </div>`;

  const presetRows = preset === "sparks"
    ? sliderRow("style-caret-sparkheight", "Height", SPARK_HEIGHT,
        numOr(layer.sparkHeight, SPARK_HEIGHT.default), v => v + "px")
    : preset === "underline"
      ? sliderRow("style-caret-height", "Height", UNDERLINE_HEIGHT,
          numOr(layer.height, UNDERLINE_HEIGHT.default), v => v + "px")
        + sliderRow("style-caret-trail", "Trail length", UNDERLINE_TRAIL,
            numOr(layer.trailSeconds, UNDERLINE_TRAIL.default), v => v.toFixed(1) + "s")
        + sliderRow("style-caret-offsety", "Vertical offset", UNDERLINE_OFFSET,
            numOr(layer.offsetY, UNDERLINE_OFFSET.default), signedPx)
      : "";

  return `
    <div class="style-editor-row">
      <label>Preset</label>
      <select id="style-caret-preset" class="style-native-select">
        ${CARET_PRESETS.map(c => `<option value="${escAttr(c.id)}"${c.id === preset ? " selected" : ""}>${escHtml(c.name)}</option>`).join("")}
      </select>
    </div>

    <h4 class="style-modal-subsection-title">Color</h4>
    <div class="style-editor-row">
      <label>Match caret color</label>
      <div class="style-checkbox-group">
        <input type="checkbox" id="style-caret-match" ${matchCaret ? "checked" : ""} />
      </div>
    </div>
    ${matchCaret ? "" : colorRow("style-caret-color-light", "Color (Light)", lightColor)
      + colorRow("style-caret-color-dark", "Color (Dark)", darkColor)}
    ${blendRowHtml("style-caret-blend-light", lightBlend, "Blend (Light)")}
    ${blendRowHtml("style-caret-blend-dark", darkBlend, "Blend (Dark)")}
    ${renderOpacityRows(layer)}

    ${presetRows}
    <div class="style-editor-row">
      <label>Anti-alias</label>
      <div class="style-checkbox-group">
        <input type="checkbox" id="style-caret-antialias" ${layer.antialias !== false ? "checked" : ""} />
      </div>
    </div>
    <p class="style-editor-hint">Follows the text cursor as you type.</p>`;
}

export function bindCaretOptions(container, layer, { onCommit, rerender }) {
  const presetEl = container.querySelector("#style-caret-preset");
  if (presetEl) presetEl.addEventListener("change", () => {
    layer.preset = presetEl.value;
    rerender(); // the row label carries the preset name, and the
                // per-preset knobs appear / disappear with it
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

  const bindBlend = (sel, field) => {
    const el = container.querySelector(sel);
    if (!el) return;
    el.addEventListener("change", () => {
      layer[field] = el.value;
      // Same reasoning as the colours: the pre-split single value can
      // only disagree with the pair from here on.
      delete layer.blend;
      onCommit();
    });
  };
  bindBlend("#style-caret-blend-light", "lightBlend");
  bindBlend("#style-caret-blend-dark", "darkBlend");

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
  bindRange("#style-caret-height", "height", (v) => v + "px");
  bindRange("#style-caret-sparkheight", "sparkHeight", (v) => v + "px");
  bindRange("#style-caret-trail", "trailSeconds", (v) => v.toFixed(1) + "s");
  bindRange("#style-caret-offsety", "offsetY", signedPx);

  const aaEl = container.querySelector("#style-caret-antialias");
  if (aaEl) aaEl.addEventListener("change", () => {
    layer.antialias = aaEl.checked;
    onCommit();
  });
}
