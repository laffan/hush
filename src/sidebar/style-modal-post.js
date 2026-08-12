/**
 * Post Processing section of the style editor — the same layer-stack UI
 * as Background (see style-layer-ui.js), over the post-processing effect
 * registry instead of the background layer types.
 *
 * A style's `postLayers` is an ordered array (index 0 = back) of
 * `{ id, type, enabled, blend, ...knobs }`, where `type` is a
 * POST_EFFECTS id (vignette / glow / scanlines / opacity / tint /
 * grayscale / sepia) and the knobs live flat on the layer, keyed by the
 * registry's setting ids. `postProcessingEnabled === false` switches the
 * whole stack off without discarding it.
 *
 * Live edits push a scoped preview into the modal's preview pane; the
 * runtime is `import()`ed on first use so opening the modal doesn't drag
 * the effect code in.
 */
import { escAttr, escHtml } from "./styles-panel-shared.js";
import { POST_EFFECTS, findPostEffect, resolvePostOptions, defaultPostLayer } from "../post-layers/registry.js";
import {
  blendRowHtml, newLayerId, renderLayerList, renderAddRow, bindLayerSection,
} from "./style-layer-ui.js";

// ── runtime preview plumbing ─────────────────────────────────────────────
let _modulePromise = null;
let _runtime = null;
function loadRuntime() {
  if (!_modulePromise) {
    _modulePromise = import("../post-layers/index.js").then(m => (_runtime = m));
  }
  return _modulePromise;
}

let _previewing = false;
function pushPreview(draft, previewPane) {
  if (!previewPane) return;
  const layers = sectionEnabled(draft)
    ? (draft.postLayers || []).filter(l => l && l.enabled !== false)
    : [];
  loadRuntime().then(m => {
    m.setScopedPreviewLock(true);
    _previewing = true;
    m.applyPostLayers({ layers, container: previewPane });
  }).catch(() => {});
}

/** Tear down any modal-scoped post preview and release the lock that
 *  kept editor-context applies at bay, then let the caller re-apply the
 *  active style so its own stack takes the window back. */
export function endPostPreview(applyActiveStyle, state) {
  if (_modulePromise) {
    if (_runtime) {
      _runtime.setScopedPreviewLock(false);
      if (_previewing) _runtime.unmountPostLayers();
    } else {
      _modulePromise.then(m => {
        m.setScopedPreviewLock(false);
        m.unmountPostLayers();
      }).catch(() => {});
    }
    _previewing = false;
  }
  if (applyActiveStyle && state) applyActiveStyle(state);
}

// ── section rendering ────────────────────────────────────────────────────
let _selectedLayerId = null;

function ensureLayers(draft) {
  if (!Array.isArray(draft.postLayers)) draft.postLayers = [];
  return draft.postLayers;
}

/** Absent = on for a stack the user built; a style that has never had a
 *  post layer starts empty anyway, so the switch only matters once. */
function sectionEnabled(draft) {
  return draft.postProcessingEnabled !== false;
}

function describe(layer) {
  const reg = findPostEffect(layer.type);
  return {
    title: reg ? reg.name : "Effect",
    badge: reg && reg.blendable && layer.blend && layer.blend !== "normal" ? layer.blend : "",
  };
}

/** One input row per registry setting. Range steps of 1 or more read as
 *  plain numbers (with the setting's unit); anything finer reads as a
 *  percentage. */
function knobHtml(s, v) {
  if (s.type === "range") {
    const step = s.step ?? 0.01;
    const display = step >= 1 ? `${v}${s.unit || ""}` : `${Math.round(v * 100)}%`;
    return `<div class="style-editor-row">
      <label>${escHtml(s.label)}</label>
      <div class="style-slider-group">
        <input type="range" data-post-opt="${escAttr(s.id)}"
               min="${s.min ?? 0}" max="${s.max ?? 1}" step="${step}" value="${v}" />
        <span class="style-slider-value">${escHtml(display)}</span>
      </div>
    </div>`;
  }
  if (s.type === "color") {
    return `<div class="style-editor-color-row">
      <label>${escHtml(s.label)}</label>
      <div class="style-color-group">
        <input type="color" data-post-opt="${escAttr(s.id)}" value="${escAttr(v)}" />
      </div>
    </div>`;
  }
  return "";
}

function optionsHtml(layer) {
  const reg = findPostEffect(layer.type);
  if (!reg) return "";
  const resolved = resolvePostOptions(layer);
  return `
    <div class="style-layer-options" data-layer-id="${escAttr(layer.id)}">
      ${reg.blendable ? blendRowHtml("style-post-blend", layer.blend) : ""}
      ${reg.settings.map(s => knobHtml(s, resolved[s.id])).join("")}
      ${reg.hint ? `<p class="style-editor-hint">${escHtml(reg.hint)}</p>` : ""}
    </div>`;
}

function sectionInnerHtml(draft) {
  const layers = ensureLayers(draft);
  const on = sectionEnabled(draft);
  if (_selectedLayerId && !layers.some(l => l.id === _selectedLayerId)) _selectedLayerId = null;
  if (!_selectedLayerId && layers.length) _selectedLayerId = layers[layers.length - 1].id;
  const sel = layers.find(l => l.id === _selectedLayerId) || null;

  return `
    <div class="style-modal-section-header">
      <h3 class="style-modal-section-title">Post Processing</h3>
      <input type="checkbox" id="style-post-enable" aria-label="Enable post processing" ${on ? "checked" : ""} />
    </div>
    <div class="style-post-layers-body${on ? "" : " style-row-hidden"}">
      ${renderLayerList(layers, _selectedLayerId, describe)}
      ${renderAddRow(POST_EFFECTS.map(e => ({ type: e.id, label: e.name })))}
      ${sel ? optionsHtml(sel) : ""}
    </div>`;
}

export function renderPostSection(draft) {
  return `<div class="style-modal-section" id="style-post-section">${sectionInnerHtml(draft)}</div>`;
}

export function bindPostSection(backdrop, draft, scheduleSave) {
  const sectionEl = backdrop.querySelector("#style-post-section");
  const previewPane = backdrop.querySelector("#style-preview-pane");
  if (!sectionEl) return;

  const preview = () => pushPreview(draft, previewPane);
  const commit = () => { preview(); scheduleSave(); };

  function rerender() {
    sectionEl.innerHTML = sectionInnerHtml(draft);
    bindSection();
  }

  function bindSection() {
    const layers = ensureLayers(draft);

    const enableEl = sectionEl.querySelector("#style-post-enable");
    if (enableEl) enableEl.addEventListener("change", () => {
      draft.postProcessingEnabled = enableEl.checked;
      rerender();
      commit();
    });

    bindLayerSection(sectionEl, layers, {
      setSelected: (id) => { _selectedLayerId = id; },
      rerender,
      commit,
      makeLayer: (type) => defaultPostLayer(type, newLayerId()),
      // Adding an effect while the section is switched off would file it
      // somewhere invisible — turn the section back on instead.
      onAdd: () => { draft.postProcessingEnabled = true; },
    });

    const sel = layers.find(l => l.id === _selectedLayerId);
    if (!sel) return;

    const blendEl = sectionEl.querySelector("#style-post-blend");
    if (blendEl) blendEl.addEventListener("change", () => {
      sel.blend = blendEl.value;
      rerender(); // the row badge carries the blend too
      commit();
    });

    sectionEl.querySelectorAll("[data-post-opt]").forEach(input => {
      const key = input.dataset.postOpt;
      const handler = () => {
        if (input.type === "range") {
          const v = parseFloat(input.value);
          sel[key] = v;
          const display = input.nextElementSibling;
          if (display) {
            const step = parseFloat(input.step);
            const unit = findPostEffect(sel.type)?.settings.find(s => s.id === key)?.unit || "";
            display.textContent = step >= 1 ? `${v}${unit}` : `${Math.round(v * 100)}%`;
          }
        } else {
          sel[key] = input.value;
        }
        commit();
      };
      input.addEventListener("input", handler);
      // Colour inputs also fire change for the final commit.
      if (input.type === "color") input.addEventListener("change", handler);
    });
  }

  bindSection();

  // Seed the preview unconditionally, even for a draft with no post
  // layers at all. Unlike the background stack — which lives inside the
  // editor element, hidden behind the modal anyway — post layers cover
  // the whole window: leaving the *active* style's stack mounted would
  // paint a grayscale or a half-faded window over the editor you came
  // here to tune. Pushing an empty set takes the scoped-preview lock and
  // tears that stack down.
  preview();
}
