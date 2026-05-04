/**
 * Post-processing modal block — extracted from style-modal.js to keep
 * that file under the 700-line limit. Owns the section markup plus its
 * event handlers AND the live-preview plumbing.
 *
 * Per-layer knobs come from each layer's `settings` schema in the
 * SHADER_LAYERS registry. The modal renders inputs for each schema
 * entry and writes user values into draft.shaderLayer.options. The
 * registry's `resolveLayerOptions` overlays defaults at apply time so a
 * fresh draft always has sensible values.
 */
import { SHADER_LAYERS, applyShaderLayer, unmountShaderLayer, resolveLayerOptions } from "../shader-layer/index.js";
import { escAttr, escHtml } from "./styles-panel-shared.js";
import { bindCustomDropdown } from "./custom-dropdown.js";

let _previewing = false;

function pushPreview(cfg, container) {
  if (!cfg || !cfg.enabled || !cfg.layerId) {
    if (_previewing) { unmountShaderLayer(); _previewing = false; }
    return;
  }
  applyShaderLayer({
    layerId: cfg.layerId,
    intensity: cfg.intensity ?? 0.5,
    options: cfg.options || {},
    container: container || null,
  });
  _previewing = true;
}

export function endShaderPreview(applyActiveStyle, state) {
  if (_previewing) {
    unmountShaderLayer();
    _previewing = false;
  }
  if (applyActiveStyle && state) applyActiveStyle(state);
}

/** Render the inputs for one layer's settings schema. */
function renderLayerOptions(layerId, userOptions) {
  const reg = SHADER_LAYERS.find(l => l.id === layerId);
  if (!reg || !reg.settings || reg.settings.length === 0) return "";
  const resolved = resolveLayerOptions(layerId, userOptions);
  return reg.settings.map(s => {
    const v = resolved[s.id];
    if (s.type === "range") {
      const min = s.min ?? 0;
      const max = s.max ?? 1;
      const step = s.step ?? 0.01;
      const display = step >= 1 ? `${v}` : `${Math.round(v * 100)}%`;
      return `<div class="style-editor-row">
        <label>${escHtml(s.label)}</label>
        <div class="style-slider-group">
          <input type="range" data-shader-opt="${escAttr(s.id)}"
                 min="${min}" max="${max}" step="${step}" value="${v}" />
          <span class="style-slider-value">${escHtml(display)}</span>
        </div>
      </div>`;
    }
    if (s.type === "color") {
      return `<div class="style-editor-color-row">
        <label>${escHtml(s.label)}</label>
        <div class="style-color-group">
          <input type="color" data-shader-opt="${escAttr(s.id)}" value="${escAttr(v)}" />
        </div>
      </div>`;
    }
    return "";
  }).join("");
}

export function renderShaderSection(draft) {
  const cfg = draft.shaderLayer || {};
  const enabled = !!cfg.enabled;
  const selectedId = cfg.layerId || SHADER_LAYERS[0].id;
  const selectedLayer = SHADER_LAYERS.find(l => l.id === selectedId) || SHADER_LAYERS[0];
  const intensity = typeof cfg.intensity === "number" ? cfg.intensity : 0.5;

  const optionsHtml = SHADER_LAYERS.map(l =>
    `<div class="custom-dropdown-option${l.id === selectedId ? " selected" : ""}" data-value="${escAttr(l.id)}">${escHtml(l.name)}</div>`
  ).join("");

  const knobsHtml = renderLayerOptions(selectedId, cfg.options);

  return `
    <div class="style-modal-section">
      <h3 class="style-modal-section-title">Post Processing</h3>
      <div class="style-editor-row">
        <label>Enable</label>
        <div class="style-checkbox-group">
          <input type="checkbox" id="style-shader-enabled" ${enabled ? "checked" : ""} />
        </div>
      </div>
      <div class="style-editor-row${enabled ? "" : " style-row-hidden"}" id="shader-layer-row">
        <label>Layer</label>
        <div class="custom-dropdown" id="style-shader-dropdown" data-value="${escAttr(selectedId)}">
          <div class="custom-dropdown-selected">${escHtml(selectedLayer.name)}</div>
          <div class="custom-dropdown-options">${optionsHtml}</div>
        </div>
      </div>
      <div class="style-editor-row${enabled ? "" : " style-row-hidden"}" id="shader-intensity-row">
        <label>Master intensity</label>
        <div class="style-slider-group">
          <input type="range" id="style-shader-intensity" min="0" max="1" step="0.01" value="${intensity}" />
          <span class="style-slider-value">${Math.round(intensity * 100)}%</span>
        </div>
      </div>
      <div id="shader-knobs"${enabled ? "" : ` class="style-row-hidden"`}>${knobsHtml}</div>
    </div>`;
}

export function bindShaderSection(backdrop, draft, scheduleSave) {
  const enabledEl = backdrop.querySelector("#style-shader-enabled");
  if (!enabledEl) return;

  const dropdown = backdrop.querySelector("#style-shader-dropdown");
  const intEl = backdrop.querySelector("#style-shader-intensity");
  const knobsContainer = backdrop.querySelector("#shader-knobs");
  const previewPane = backdrop.querySelector("#style-preview-pane");

  function ensureCfg() {
    if (!draft.shaderLayer) {
      draft.shaderLayer = {
        enabled: false,
        layerId: SHADER_LAYERS[0].id,
        intensity: 0.5,
        options: {},
      };
    }
    if (!draft.shaderLayer.options) draft.shaderLayer.options = {};
    return draft.shaderLayer;
  }

  function syncRowVisibility(enabled) {
    backdrop.querySelector("#shader-layer-row")?.classList.toggle("style-row-hidden", !enabled);
    backdrop.querySelector("#shader-intensity-row")?.classList.toggle("style-row-hidden", !enabled);
    knobsContainer?.classList.toggle("style-row-hidden", !enabled);
  }

  function rerenderKnobs() {
    const cfg = ensureCfg();
    if (knobsContainer) {
      knobsContainer.innerHTML = renderLayerOptions(cfg.layerId, cfg.options);
      bindKnobInputs();
    }
  }

  function bindKnobInputs() {
    if (!knobsContainer) return;
    knobsContainer.querySelectorAll('[data-shader-opt]').forEach(input => {
      const optId = input.dataset.shaderOpt;
      const handler = () => {
        const cfg = ensureCfg();
        cfg.options = cfg.options || {};
        if (input.type === "range") {
          const v = parseFloat(input.value);
          cfg.options[optId] = v;
          // Update the value display (next sibling span).
          const display = input.nextElementSibling;
          if (display) {
            const step = parseFloat(input.step);
            display.textContent = step >= 1 ? `${v}` : `${Math.round(v * 100)}%`;
          }
        } else {
          cfg.options[optId] = input.value;
        }
        pushPreview(cfg, previewPane);
        scheduleSave();
      };
      input.addEventListener("input", handler);
      // Color inputs also fire change for the final commit.
      if (input.type === "color") input.addEventListener("change", handler);
    });
  }

  enabledEl.addEventListener("change", () => {
    const cfg = ensureCfg();
    cfg.enabled = enabledEl.checked;
    syncRowVisibility(cfg.enabled);
    pushPreview(cfg, previewPane);
    scheduleSave();
  });

  bindCustomDropdown(dropdown, (val) => {
    const cfg = ensureCfg();
    cfg.layerId = val;
    cfg.enabled = true;
    enabledEl.checked = true;
    syncRowVisibility(true);
    rerenderKnobs(); // new layer → different knobs
    pushPreview(cfg, previewPane);
    scheduleSave();
  }, {
    onHover: (val) => {
      if (!val) return;
      pushPreview({
        enabled: true,
        layerId: val,
        intensity: ensureCfg().intensity ?? 0.5,
        options: ensureCfg().options || {},
      }, previewPane);
    },
    onClose: () => {
      pushPreview(ensureCfg(), previewPane);
    },
  });

  intEl.addEventListener("input", () => {
    const v = parseFloat(intEl.value);
    intEl.nextElementSibling.textContent = Math.round(v * 100) + "%";
    const cfg = ensureCfg();
    cfg.intensity = v;
    pushPreview(cfg, previewPane);
    scheduleSave();
  });

  bindKnobInputs();

  if (draft.shaderLayer?.enabled && draft.shaderLayer?.layerId) {
    pushPreview(draft.shaderLayer, previewPane);
  }
}
