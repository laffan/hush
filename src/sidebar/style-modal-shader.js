/**
 * Shader-layer modal block — extracted from style-modal.js to keep that
 * file under the 700-line limit. Owns the section markup plus its three
 * event handlers (enable checkbox, layer dropdown, intensity slider).
 *
 * SHADER_LAYERS is statically imported from src/shader-layer/index.js so
 * the modal can render the dropdown without first loading any layer
 * code — index.js itself has no side effects on import; the layer
 * modules under ./layers/ stay lazy until a style mounts one.
 */
import { SHADER_LAYERS } from "../shader-layer/index.js";
import { escAttr, escHtml } from "./styles-panel-shared.js";

export function renderShaderSection(draft) {
  const cfg = draft.shaderLayer || {};
  const enabled = !!cfg.enabled;
  const selectedId = cfg.layerId || SHADER_LAYERS[0].id;
  const intensity = typeof cfg.intensity === "number" ? cfg.intensity : 0.5;
  const optionsHtml = SHADER_LAYERS.map(l =>
    `<option value="${escAttr(l.id)}"${l.id === selectedId ? " selected" : ""}>${escHtml(l.name)}</option>`
  ).join("");
  return `
    <div class="style-modal-section">
      <h3 class="style-modal-section-title">Shader Layer</h3>
      <div class="style-editor-row">
        <label>Enable</label>
        <div class="style-checkbox-group">
          <input type="checkbox" id="style-shader-enabled" ${enabled ? "checked" : ""} />
        </div>
      </div>
      <div class="style-editor-row${enabled ? "" : " style-row-hidden"}" id="shader-layer-row">
        <label>Layer</label>
        <select id="style-shader-layer">${optionsHtml}</select>
      </div>
      <div class="style-editor-row${enabled ? "" : " style-row-hidden"}" id="shader-intensity-row">
        <label>Intensity</label>
        <div class="style-slider-group">
          <input type="range" id="style-shader-intensity" min="0" max="1" step="0.01" value="${intensity}" />
          <span class="style-slider-value">${Math.round(intensity * 100)}%</span>
        </div>
      </div>
    </div>`;
}

export function bindShaderSection(backdrop, draft, scheduleSave) {
  const enabledEl = backdrop.querySelector("#style-shader-enabled");
  if (enabledEl) enabledEl.addEventListener("change", () => {
    if (!draft.shaderLayer) draft.shaderLayer = { layerId: SHADER_LAYERS[0].id, intensity: 0.5 };
    draft.shaderLayer.enabled = enabledEl.checked;
    backdrop.querySelector("#shader-layer-row")?.classList.toggle("style-row-hidden", !enabledEl.checked);
    backdrop.querySelector("#shader-intensity-row")?.classList.toggle("style-row-hidden", !enabledEl.checked);
    scheduleSave();
  });
  const layerEl = backdrop.querySelector("#style-shader-layer");
  if (layerEl) layerEl.addEventListener("change", () => {
    if (!draft.shaderLayer) draft.shaderLayer = { enabled: true, intensity: 0.5 };
    draft.shaderLayer.layerId = layerEl.value;
    scheduleSave();
  });
  const intEl = backdrop.querySelector("#style-shader-intensity");
  if (intEl) intEl.addEventListener("input", () => {
    const v = parseFloat(intEl.value);
    intEl.nextElementSibling.textContent = Math.round(v * 100) + "%";
    if (!draft.shaderLayer) draft.shaderLayer = { enabled: true, layerId: SHADER_LAYERS[0].id };
    draft.shaderLayer.intensity = v;
    scheduleSave();
  });
}
