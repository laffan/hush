/**
 * Background Layers section + JSON export row for the style editor.
 *
 * A style's `backgroundLayers` is an ordered array (index 0 = back) of
 * layer objects, each `{ id, type: "image" | "gradient" | "webgl",
 * enabled, blend, ...type-specific }`:
 *   - image:    { src, fit, repeat, lightOpacity, darkOpacity,
 *                 lightInvert, darkInvert } — the old single
 *                 "Background Image" section, now one layer among many
 *   - gradient: { nodes: [{x, y, color}], animate, light/darkOpacity }
 *   - webgl:    { effectId, intensity, options, caretEffect,
 *                 caretColor, caretIntensity }
 *
 * The list renders front-most layer at the top (Photoshop order);
 * selecting a row shows that layer's options underneath, ending in
 * Move / Delete Layer controls. Live edits push a scoped preview into
 * the modal's preview pane through the background-layers runtime.
 *
 * Gradient and WebGL option blocks live in style-modal-gradient.js /
 * style-modal-webgl.js (700-line cap).
 */
import { escAttr, escHtml } from "./styles-panel-shared.js";
import { WEBGL_BG_EFFECTS, defaultGradientNodes } from "../background-layers/effects-registry.js";
import { renderGradientOptions, bindGradientOptions } from "./style-modal-gradient.js";
import { renderWebglOptions, bindWebglOptions } from "./style-modal-webgl.js";

export const BLEND_MODES = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color-dodge", "color-burn", "hard-light", "soft-light",
  "difference", "exclusion", "hue", "saturation", "color", "luminosity",
];

function opt(value, label, selected) {
  return `<option value="${escAttr(value)}"${value === selected ? " selected" : ""}>${escHtml(label)}</option>`;
}

function cap(s) { return s.replace(/(^|[-\s])(\w)/g, (_, p, c) => (p === "-" ? " " : p) + c.toUpperCase()); }

const EYE_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>`;

// ── runtime preview plumbing ─────────────────────────────────────────────
let _bgModulePromise = null;
let _runtime = null;
function loadRuntime() {
  if (!_bgModulePromise) {
    _bgModulePromise = import("../background-layers/index.js").then(m => (_runtime = m));
  }
  return _bgModulePromise;
}

function resolvePreviewAppearance(state) {
  let a = state?.settings?.appearance || "dark";
  if (a === "auto") a = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  if (a === "sepia") a = "light";
  return a;
}

let _previewing = false;
function pushLayersPreview(draft, previewPane, state) {
  if (!previewPane) return;
  const layers = (draft.backgroundLayers || []).filter(l => l && l.enabled !== false);
  loadRuntime().then(m => {
    m.setScopedPreviewLock(true);
    _previewing = true;
    m.applyBackgroundLayers({
      layers,
      appearance: resolvePreviewAppearance(state),
      container: previewPane,
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

function newLayerId() {
  return "layer_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

function selectedLayer(draft) {
  const layers = ensureLayers(draft);
  return layers.find(l => l.id === _selectedLayerId) || null;
}

function layerTitle(layer) {
  if (layer.type === "image") return "Image";
  if (layer.type === "gradient") return "Gradient";
  if (layer.type === "webgl") {
    const reg = WEBGL_BG_EFFECTS.find(e => e.id === layer.effectId);
    return "WebGL" + (reg ? ` — ${reg.name}` : "");
  }
  return "Layer";
}

function layerRowHtml(layer, selected) {
  const off = layer.enabled === false;
  const thumb = layer.type === "image" && layer.src
    ? `<span class="style-bg-layer-thumb" style="background-image:url('${escAttr(layer.src)}')"></span>`
    : "";
  return `
    <div class="style-bg-layer-row${selected ? " selected" : ""}${off ? " layer-off" : ""}" data-layer-id="${escAttr(layer.id)}">
      <button type="button" class="style-bg-layer-eye" data-layer-eye="${escAttr(layer.id)}" title="${off ? "Show layer" : "Hide layer"}">${EYE_SVG}</button>
      ${thumb}
      <span class="style-bg-layer-label">${escHtml(layerTitle(layer))}</span>
      <span class="style-bg-layer-blend">${escHtml(layer.blend || "normal")}</span>
    </div>`;
}

function imageOptionsHtml(layer) {
  const fit = layer.fit || "cover";
  const repeat = layer.repeat || "no-repeat";
  const hasSrc = !!layer.src;
  const lightInvert = !!layer.lightInvert;
  const darkInvert = !!layer.darkInvert;
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
        <input type="checkbox" id="style-bg-invert-light" ${lightInvert ? "checked" : ""} />
      </div>
    </div>
    <div class="style-editor-row">
      <label>Invert (Dark)</label>
      <div class="style-checkbox-group">
        <input type="checkbox" id="style-bg-invert-dark" ${darkInvert ? "checked" : ""} />
      </div>
    </div>`;
}

function opacityRowsHtml(layer) {
  const legacy = layer.opacity != null ? layer.opacity : 1;
  const lightOpacity = layer.lightOpacity != null ? layer.lightOpacity : legacy;
  const darkOpacity = layer.darkOpacity != null ? layer.darkOpacity : legacy;
  return `
    <div class="style-editor-row">
      <label>Opacity (Light)</label>
      <div class="style-slider-group">
        <input type="range" id="style-layer-opacity-light" min="0" max="1" step="0.05" value="${lightOpacity}" />
        <span class="style-slider-value">${Math.round(lightOpacity * 100)}%</span>
      </div>
    </div>
    <div class="style-editor-row">
      <label>Opacity (Dark)</label>
      <div class="style-slider-group">
        <input type="range" id="style-layer-opacity-dark" min="0" max="1" step="0.05" value="${darkOpacity}" />
        <span class="style-slider-value">${Math.round(darkOpacity * 100)}%</span>
      </div>
    </div>`;
}

function sectionInnerHtml(draft) {
  const layers = ensureLayers(draft);
  if (_selectedLayerId && !layers.some(l => l.id === _selectedLayerId)) _selectedLayerId = null;
  if (!_selectedLayerId && layers.length) _selectedLayerId = layers[layers.length - 1].id;
  const sel = selectedLayer(draft);

  // Front-most layer (highest index) renders at the top of the list.
  const rows = layers.slice().reverse().map(l => layerRowHtml(l, sel && l.id === sel.id)).join("");
  const listHtml = layers.length
    ? `<div class="style-bg-layer-list">${rows}</div>`
    : `<div class="style-bg-layer-empty">No layers — add one below.</div>`;

  let optionsHtml = "";
  if (sel) {
    const idx = layers.indexOf(sel);
    const canForward = idx < layers.length - 1;
    const canBack = idx > 0;
    optionsHtml = `
      <div class="style-bg-layer-options" data-layer-id="${escAttr(sel.id)}">
        <div class="style-editor-row">
          <label>Blend</label>
          <select id="style-layer-blend">${BLEND_MODES.map(b => opt(b, cap(b), sel.blend || "normal")).join("")}</select>
        </div>
        ${sel.type === "image" ? imageOptionsHtml(sel) + opacityRowsHtml(sel) : ""}
        ${sel.type === "gradient" ? renderGradientOptions(sel) + opacityRowsHtml(sel) : ""}
        ${sel.type === "webgl" ? renderWebglOptions(sel) : ""}
        <div class="style-bg-layer-actions">
          <button type="button" id="style-layer-up" ${canForward ? "" : "disabled"} title="Bring forward">Move Up</button>
          <button type="button" id="style-layer-down" ${canBack ? "" : "disabled"} title="Send backward">Move Down</button>
        </div>
        <button type="button" class="style-bg-layer-delete">Delete Layer</button>
      </div>`;
  }

  return `
    <h3 class="style-modal-section-title">Background Layers</h3>
    ${listHtml}
    <div class="style-bg-layer-add">
      <button type="button" data-add-layer="image">+ Image</button>
      <button type="button" data-add-layer="gradient">+ Gradient</button>
      <button type="button" data-add-layer="webgl">+ WebGL</button>
    </div>
    ${optionsHtml}`;
}

/** Background Layers section HTML + a trailing Export row. */
export function renderStyleExtras(draft) {
  return `
    <div class="style-modal-section" id="style-bg-layers-section">${sectionInnerHtml(draft)}</div>
    <div class="style-modal-section">
      <button type="button" class="style-modal-export">Export style as JSON</button>
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
  return {
    ...base, blend: "screen", effectId: WEBGL_BG_EFFECTS[0].id,
    intensity: 0.5, options: {}, caretEffect: "none",
    caretColor: "#9ecbff", caretIntensity: 0.6,
  };
}

/** Wire the Background Layers section + Export button. `flushSave`
 *  (optional) commits any pending debounced edit before exporting so the
 *  download captures the latest draft. `state` feeds the live preview
 *  (appearance resolution). */
export function bindStyleExtras(backdrop, draft, scheduleSave, render, flushSave, state) {
  const sectionEl = backdrop.querySelector("#style-bg-layers-section");
  const previewPane = backdrop.querySelector("#style-preview-pane");

  const preview = () => pushLayersPreview(draft, previewPane, state);
  const commit = () => { preview(); scheduleSave(); };

  function rerenderSection() {
    if (!sectionEl) return;
    sectionEl.innerHTML = sectionInnerHtml(draft);
    bindSection();
  }

  function bindSection() {
    if (!sectionEl) return;
    const layers = ensureLayers(draft);

    // Row select + eye toggles
    sectionEl.querySelectorAll(".style-bg-layer-row").forEach(row => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-layer-eye]")) return;
        _selectedLayerId = row.dataset.layerId;
        rerenderSection();
      });
    });
    sectionEl.querySelectorAll("[data-layer-eye]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const layer = layers.find(l => l.id === btn.dataset.layerEye);
        if (!layer) return;
        layer.enabled = layer.enabled === false;
        rerenderSection();
        commit();
      });
    });

    // Add-layer buttons
    sectionEl.querySelectorAll("[data-add-layer]").forEach(btn => {
      btn.addEventListener("click", () => {
        const layer = defaultLayer(btn.dataset.addLayer);
        layers.push(layer); // top of the stack (front-most)
        _selectedLayerId = layer.id;
        rerenderSection();
        commit();
      });
    });

    const sel = selectedLayer(draft);
    if (!sel) return;

    const blendEl = sectionEl.querySelector("#style-layer-blend");
    if (blendEl) blendEl.addEventListener("change", () => {
      sel.blend = blendEl.value;
      rerenderSection(); // blend shows on the row label too
      commit();
    });

    const bindOpacity = (elSel, field) => {
      const el = sectionEl.querySelector(elSel);
      if (!el) return;
      el.addEventListener("input", () => {
        const v = parseFloat(el.value);
        sel[field] = v;
        if (el.nextElementSibling) el.nextElementSibling.textContent = Math.round(v * 100) + "%";
        commit();
      });
    };
    bindOpacity("#style-layer-opacity-light", "lightOpacity");
    bindOpacity("#style-layer-opacity-dark", "darkOpacity");

    if (sel.type === "image") bindImageOptions(sel);
    if (sel.type === "gradient") {
      bindGradientOptions(sectionEl, sel, { onPreview: preview, onCommit: commit, rerender: rerenderSection });
    }
    if (sel.type === "webgl") {
      bindWebglOptions(sectionEl, sel, { onCommit: commit, rerender: rerenderSection });
    }

    const upBtn = sectionEl.querySelector("#style-layer-up");
    const downBtn = sectionEl.querySelector("#style-layer-down");
    const move = (delta) => {
      const idx = layers.indexOf(sel);
      const next = idx + delta;
      if (idx < 0 || next < 0 || next >= layers.length) return;
      layers.splice(idx, 1);
      layers.splice(next, 0, sel);
      rerenderSection();
      commit();
    };
    if (upBtn) upBtn.addEventListener("click", () => move(1));    // toward the front
    if (downBtn) downBtn.addEventListener("click", () => move(-1)); // toward the back

    const deleteBtn = sectionEl.querySelector(".style-bg-layer-delete");
    if (deleteBtn) deleteBtn.addEventListener("click", () => {
      const idx = layers.indexOf(sel);
      if (idx < 0) return;
      layers.splice(idx, 1);
      const neighbor = layers[Math.min(idx, layers.length - 1)];
      _selectedLayerId = neighbor ? neighbor.id : null;
      rerenderSection();
      commit();
    });
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
