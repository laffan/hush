/**
 * Background section + JSON export row for the style editor.
 *
 * A style's `backgroundLayers` is an ordered array (index 0 = back) of
 * layer objects, each `{ id, type: "image" | "gradient" | "webgl" |
 * "caret", enabled, blend, ...type-specific }`:
 *   - image:    { src, fit, repeat, lightOpacity, darkOpacity,
 *                 lightInvert, darkInvert } — the old single
 *                 "Background Image" section, now one layer among many
 *   - gradient: { nodes: [{x, y, color}], animate, light/darkOpacity }
 *   - webgl:    { effectId, intensity, options }
 *   - caret:    { preset, light/darkColor, light/darkBlend,
 *                 light/darkOpacity } — follows the text cursor
 * `backgroundLayersEnabled === false` switches the whole stack off
 * without discarding it (the checkbox in the section header).
 *
 * The list chrome — rows, drag-reorder, eye, delete, add — is shared with
 * Post Processing and lives in style-layer-ui.js. Per-type option blocks
 * live in style-modal-gradient.js / style-modal-webgl.js (700-line cap).
 */
import { escAttr, escHtml } from "./styles-panel-shared.js";
import { WEBGL_BG_EFFECTS, CARET_PRESETS, defaultGradientNodes } from "../background-layers/effects-registry.js";
import { renderGradientOptions, bindGradientOptions } from "./style-modal-gradient.js";
import { renderWebglOptions, bindWebglOptions, renderCaretOptions, bindCaretOptions } from "./style-modal-webgl.js";
import {
  blendRowHtml, newLayerId, opt, renderLayerList, renderAddRow,
  renderOpacityRows, bindOpacityRows, bindLayerSection,
} from "./style-layer-ui.js";

// ── runtime preview plumbing ─────────────────────────────────────────────
let _bgModulePromise = null;
let _runtime = null;
function loadRuntime() {
  if (!_bgModulePromise) {
    _bgModulePromise = import("../background-layers/index.js").then(m => (_runtime = m));
  }
  return _bgModulePromise;
}

let _previewing = false;
function pushLayersPreview(draft, previewPane, appearance) {
  if (!previewPane) return;
  const layers = layersEnabled(draft)
    ? (draft.backgroundLayers || []).filter(l => l && l.enabled !== false)
    : [];
  loadRuntime().then(m => {
    m.setScopedPreviewLock(true);
    _previewing = true;
    m.applyBackgroundLayers({
      layers,
      appearance,
      container: previewPane,
      // The pane's own painted colour is what the blend modes composite
      // against — read live so a theme / colour edit re-bases them.
      backdropColor: getComputedStyle(previewPane).backgroundColor,
    });
  }).catch(() => {});
}

/** Tear down any modal-scoped layer preview and release the lock that
 *  kept editor-context applies at bay. Called from the modal's close();
 *  the caller re-runs applyActiveStyle afterwards, which re-mounts the
 *  active style's layers behind the editor. */
export function endBackgroundPreview() {
  if (!_bgModulePromise) return;
  if (_runtime) {
    _runtime.setScopedPreviewLock(false);
    if (_previewing) _runtime.unmountBackgroundLayers();
  } else {
    _bgModulePromise.then(m => {
      m.setScopedPreviewLock(false);
      m.unmountBackgroundLayers();
    }).catch(() => {});
  }
  _previewing = false;
}

// ── section rendering ────────────────────────────────────────────────────
let _selectedLayerId = null;

function ensureLayers(draft) {
  if (!Array.isArray(draft.backgroundLayers)) draft.backgroundLayers = [];
  return draft.backgroundLayers;
}

/** Absent = on, so styles saved before the switch existed keep theirs. */
function layersEnabled(draft) {
  return draft.backgroundLayersEnabled !== false;
}

function selectedLayer(draft) {
  return ensureLayers(draft).find(l => l.id === _selectedLayerId) || null;
}

function layerTitle(layer) {
  if (layer.type === "image") return "Image";
  if (layer.type === "gradient") return "Gradient";
  if (layer.type === "caret") {
    const p = CARET_PRESETS.find(c => c.id === layer.preset);
    return "Caret" + (p ? ` — ${p.name}` : "");
  }
  if (layer.type === "webgl") {
    const reg = WEBGL_BG_EFFECTS.find(e => e.id === layer.effectId);
    return "WebGL" + (reg ? ` — ${reg.name}` : "");
  }
  return "Layer";
}

function describe(layer) {
  return {
    title: layerTitle(layer),
    // Caret layers blend per appearance, so there's no single mode to
    // badge them with.
    badge: layer.type !== "caret" && layer.blend && layer.blend !== "normal" ? layer.blend : "",
    thumb: layer.type === "image" && layer.src ? layer.src : "",
  };
}

function imageOptionsHtml(layer) {
  const fit = layer.fit || "cover";
  const repeat = layer.repeat || "no-repeat";
  const hasSrc = !!layer.src;
  return `
    <div class="style-editor-row">
      <label>Image</label>
      <div class="style-bg-image-group">
        <button type="button" class="style-bg-choose">${hasSrc ? "Replace…" : "Choose…"}</button>
        ${hasSrc ? `<button type="button" class="style-bg-clear" title="Remove">&times;</button>` : ""}
        <input type="file" id="style-bg-file" accept="image/*" style="display:none" />
      </div>
    </div>
    ${hasSrc ? `<div class="style-bg-preview"><img src="${escAttr(layer.src)}" alt="" /></div>` : ""}
    <div class="style-editor-row">
      <label>Display</label>
      <select id="style-bg-fit">${opt("cover", "Cover", fit)}${opt("contain", "Contain", fit)}${opt("100% 100%", "Stretch", fit)}${opt("auto", "Original", fit)}</select>
    </div>
    <div class="style-editor-row">
      <label>Repeat</label>
      <select id="style-bg-repeat">${opt("no-repeat", "No repeat", repeat)}${opt("repeat", "Tile", repeat)}${opt("repeat-x", "Tile X", repeat)}${opt("repeat-y", "Tile Y", repeat)}</select>
    </div>
    <div class="style-editor-row">
      <label>Invert (Light)</label>
      <div class="style-checkbox-group">
        <input type="checkbox" id="style-bg-invert-light" ${layer.lightInvert ? "checked" : ""} />
      </div>
    </div>
    <div class="style-editor-row">
      <label>Invert (Dark)</label>
      <div class="style-checkbox-group">
        <input type="checkbox" id="style-bg-invert-dark" ${layer.darkInvert ? "checked" : ""} />
      </div>
    </div>`;
}

const ADD_KINDS = [
  { type: "image", label: "Image" },
  { type: "gradient", label: "Gradient" },
  { type: "webgl", label: "WebGL" },
  { type: "caret", label: "Caret" },
];

function sectionInnerHtml(draft) {
  const layers = ensureLayers(draft);
  const on = layersEnabled(draft);
  if (_selectedLayerId && !layers.some(l => l.id === _selectedLayerId)) _selectedLayerId = null;
  if (!_selectedLayerId && layers.length) _selectedLayerId = layers[layers.length - 1].id;
  const sel = selectedLayer(draft);

  let options = "";
  if (sel) {
    // Caret layers carry their blend per appearance (inside their own
    // Color block), so they skip the shared single-blend row.
    const blend = sel.type === "caret" ? "" : blendRowHtml("style-layer-blend", sel.blend);
    const body = sel.type === "image" ? imageOptionsHtml(sel) + renderOpacityRows(sel)
      : sel.type === "gradient" ? renderGradientOptions(sel) + renderOpacityRows(sel)
      : sel.type === "webgl" ? renderWebglOptions(sel)
      : sel.type === "caret" ? renderCaretOptions(sel)
      : "";
    options = `<div class="style-layer-options" data-layer-id="${escAttr(sel.id)}">${blend}${body}</div>`;
  }

  return `
    <div class="style-modal-section-header">
      <h3 class="style-modal-section-title">Background</h3>
      <input type="checkbox" id="style-bg-layers-enable" aria-label="Enable background layers" ${on ? "checked" : ""} />
    </div>
    <div class="style-bg-layers-body${on ? "" : " style-row-hidden"}">
      ${renderLayerList(layers, _selectedLayerId, describe)}
      ${renderAddRow(ADD_KINDS)}
      ${options}
    </div>`;
}

/** Background section HTML + the footer action row — Export and (when
 *  the caller allows deleting this style) Delete side by side. The
 *  Delete button's click handler lives with the modal, which owns the
 *  confirm flow and the onDelete callback. */
export function renderStyleExtras(draft, showDelete) {
  return `
    <div class="style-modal-section" id="style-bg-layers-section">${sectionInnerHtml(draft)}</div>
    <div class="style-modal-section style-modal-footer-actions">
      <button type="button" class="style-modal-export">Export Style</button>
      ${showDelete ? `<button type="button" class="style-modal-delete">Delete Style</button>` : ""}
    </div>`;
}

function defaultLayer(type) {
  const base = { id: newLayerId(), type, enabled: true };
  if (type === "image") {
    return { ...base, blend: "normal", fit: "cover", repeat: "no-repeat", lightOpacity: 1, darkOpacity: 1 };
  }
  if (type === "gradient") {
    return { ...base, blend: "normal", nodes: defaultGradientNodes(), animate: false, lightOpacity: 1, darkOpacity: 1 };
  }
  if (type === "caret") {
    return {
      ...base, preset: "sparks",
      // Screen is the only blend that reads on a dark ground and the
      // only one that *can't* read on a light one, so the two halves
      // start from opposite defaults.
      darkBlend: "screen", lightBlend: "multiply",
      // Off by default: the pickers below are the point of the Color
      // block, and matching the caret hides them.
      matchCaret: false, lightColor: "#3b82f6", darkColor: "#9ecbff",
      height: 3, sparkHeight: 12, trailSeconds: 3.5, offsetY: 0,
      antialias: true, lightOpacity: 1, darkOpacity: 1,
    };
  }
  return {
    ...base, blend: "screen", effectId: WEBGL_BG_EFFECTS[0].id,
    intensity: 0.5, options: {},
  };
}

/** Wire the Background section + Export button. `flushSave` (optional)
 *  commits any pending debounced edit before exporting so the download
 *  captures the latest draft. `appearance` is "light" | "dark" —
 *  whichever half the preview's own switch is showing. */
export function bindStyleExtras(backdrop, draft, scheduleSave, render, flushSave, state, appearance) {
  const sectionEl = backdrop.querySelector("#style-bg-layers-section");
  const previewPane = backdrop.querySelector("#style-preview-pane");

  const preview = () => pushLayersPreview(draft, previewPane, appearance);
  const commit = () => { preview(); scheduleSave(); };

  function rerenderSection() {
    if (!sectionEl) return;
    sectionEl.innerHTML = sectionInnerHtml(draft);
    bindSection();
  }

  function bindSection() {
    if (!sectionEl) return;
    const layers = ensureLayers(draft);

    const enableEl = sectionEl.querySelector("#style-bg-layers-enable");
    if (enableEl) enableEl.addEventListener("change", () => {
      draft.backgroundLayersEnabled = enableEl.checked;
      rerenderSection();
      commit();
    });

    bindLayerSection(sectionEl, layers, {
      setSelected: (id) => { _selectedLayerId = id; },
      rerender: rerenderSection,
      commit,
      makeLayer: defaultLayer,
      // Adding a layer while the section is switched off would file it
      // somewhere invisible — turn the section back on instead.
      onAdd: () => { draft.backgroundLayersEnabled = true; },
    });

    const sel = selectedLayer(draft);
    if (!sel) return;

    const blendEl = sectionEl.querySelector("#style-layer-blend");
    if (blendEl) blendEl.addEventListener("change", () => {
      sel.blend = blendEl.value;
      rerenderSection(); // the row badge shows the blend too
      commit();
    });

    bindOpacityRows(sectionEl, sel, commit);

    if (sel.type === "image") bindImageOptions(sel);
    if (sel.type === "gradient") {
      bindGradientOptions(sectionEl, sel, { onPreview: preview, onCommit: commit, rerender: rerenderSection });
    }
    if (sel.type === "webgl") {
      bindWebglOptions(sectionEl, sel, { onCommit: commit, rerender: rerenderSection });
    }
    if (sel.type === "caret") {
      bindCaretOptions(sectionEl, sel, { onCommit: commit, rerender: rerenderSection });
    }
  }

  function bindImageOptions(layer) {
    const chooseBtn = sectionEl.querySelector(".style-bg-choose");
    const fileEl = sectionEl.querySelector("#style-bg-file");
    if (chooseBtn && fileEl) {
      chooseBtn.addEventListener("click", () => fileEl.click());
      fileEl.addEventListener("change", () => {
        const file = fileEl.files && fileEl.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          layer.src = String(reader.result || "");
          rerenderSection();
          commit();
        };
        reader.readAsDataURL(file);
      });
    }
    const clearBtn = sectionEl.querySelector(".style-bg-clear");
    if (clearBtn) clearBtn.addEventListener("click", () => {
      delete layer.src;
      rerenderSection();
      commit();
    });
    const fitEl = sectionEl.querySelector("#style-bg-fit");
    if (fitEl) fitEl.addEventListener("change", () => { layer.fit = fitEl.value; commit(); });
    const repeatEl = sectionEl.querySelector("#style-bg-repeat");
    if (repeatEl) repeatEl.addEventListener("change", () => { layer.repeat = repeatEl.value; commit(); });
    const bindInvert = (elSel, field) => {
      const el = sectionEl.querySelector(elSel);
      if (!el) return;
      el.addEventListener("change", () => { layer[field] = el.checked; commit(); });
    };
    bindInvert("#style-bg-invert-light", "lightInvert");
    bindInvert("#style-bg-invert-dark", "darkInvert");
  }

  bindSection();

  // Seed the preview with the draft's current layers so opening a style
  // that already has them shows the composite immediately. When this
  // draft has none but the runtime is already loaded, push the empty
  // set anyway — swapping styles in the Edit Styles shell must clear
  // the previous draft's preview (and stop its animation loops).
  if ((draft.backgroundLayers || []).some(l => l && l.enabled !== false)) preview();
  else if (_bgModulePromise) preview();

  const exportBtn = backdrop.querySelector(".style-modal-export");
  if (exportBtn) exportBtn.addEventListener("click", () => {
    // Commit any in-flight debounced edit first so the export reflects the
    // current draft (e.g. an image chosen a moment ago).
    if (typeof flushSave === "function") flushSave();
    downloadStyleJson(draft);
  });
}

/** Serialize a style draft to a JSON file download (drops the id so an
 *  import always lands as a fresh style). Deep-cloned so nested layer
 *  objects (with their data-URL `src`) are captured by value. */
export function downloadStyleJson(draft) {
  const style = JSON.parse(JSON.stringify(draft));
  delete style.id;
  delete style._migrated;
  const payload = { format: "hush-style", version: 1, style };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(draft.name || "style").replace(/[^\w.-]+/g, "-") || "style"}.hush-style.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
