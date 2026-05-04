/**
 * Shader-layer modal block — extracted from style-modal.js to keep that
 * file under the 700-line limit. Owns the section markup plus its event
 * handlers (enable checkbox, layer dropdown, intensity slider) AND the
 * live-preview plumbing.
 *
 * Why preview lives here, not in style-application.js: applyActiveStyle()
 * only fires the shader for the currently *active* style. The user is
 * usually editing a non-active style (or a brand-new one), so we apply
 * the shader directly during modal interactions and revert on close.
 */
import { SHADER_LAYERS, applyShaderLayer, unmountShaderLayer } from "../shader-layer/index.js";
import { escAttr, escHtml } from "./styles-panel-shared.js";
import { bindCustomDropdown } from "./custom-dropdown.js";

/** Tracks whether the section is currently driving the shader so we can
 *  revert without trampling another caller. */
let _previewing = false;

function pushPreview(cfg, container) {
  if (!cfg || !cfg.enabled || !cfg.layerId) {
    if (_previewing) { unmountShaderLayer(); _previewing = false; }
    return;
  }
  applyShaderLayer({
    layerId: cfg.layerId,
    intensity: cfg.intensity ?? 0.5,
    container: container || null,
  });
  _previewing = true;
}

/** Called by the modal on close so the global state restores itself.
 *  We just unmount; main.js's existing settings-changed / style-changed
 *  handlers re-run applyActiveStyle which will re-mount the active
 *  style's shader (if any). */
export function endShaderPreview(applyActiveStyle, state) {
  if (_previewing) {
    unmountShaderLayer();
    _previewing = false;
  }
  // Re-apply the active style's shader (or clear, if none) so we leave
  // the viewport reflecting the committed world.
  if (applyActiveStyle && state) applyActiveStyle(state);
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
        <div class="custom-dropdown" id="style-shader-dropdown" data-value="${escAttr(selectedId)}">
          <div class="custom-dropdown-selected">${escHtml(selectedLayer.name)}</div>
          <div class="custom-dropdown-options">${optionsHtml}</div>
        </div>
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
  if (!enabledEl) return; // Default-style render returned "", nothing to bind

  const dropdown = backdrop.querySelector("#style-shader-dropdown");
  const intEl = backdrop.querySelector("#style-shader-intensity");
  // Scope the preview to the modal's right-column preview pane so the
  // user sees the effect right where they expect it. Falls back to
  // fullscreen if for any reason the pane element isn't present.
  const previewPane = backdrop.querySelector("#style-preview-pane");

  function ensureCfg() {
    if (!draft.shaderLayer) {
      draft.shaderLayer = {
        enabled: false,
        layerId: SHADER_LAYERS[0].id,
        intensity: 0.5,
      };
    }
    return draft.shaderLayer;
  }

  function syncRowVisibility(enabled) {
    backdrop.querySelector("#shader-layer-row")?.classList.toggle("style-row-hidden", !enabled);
    backdrop.querySelector("#shader-intensity-row")?.classList.toggle("style-row-hidden", !enabled);
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
    pushPreview(cfg, previewPane);
    scheduleSave();
  }, {
    onHover: (val) => {
      // Hover preview — don't mutate the draft, just push a temporary
      // shader to the preview pane. Null val (cursor left the option
      // list) is handled by onClose below.
      if (!val) return;
      pushPreview({
        enabled: true,
        layerId: val,
        intensity: ensureCfg().intensity ?? 0.5,
      }, previewPane);
    },
    onClose: () => {
      // Dropdown collapsed without a selection — restore the committed
      // draft so the preview matches what's saved.
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

  // First-render: if the draft already has a shader on, mount it now so
  // the user lands on the modal with the saved effect already showing.
  if (draft.shaderLayer?.enabled && draft.shaderLayer?.layerId) {
    pushPreview(draft.shaderLayer, previewPane);
  }
}
