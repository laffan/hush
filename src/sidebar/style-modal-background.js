/**
 * Background Layers section + JSON export row for the style editor.
 *
 * A style's `backgroundLayers` is an ordered array (index 0 = back) of
 * layer objects, each `{ id, type: "image" | "gradient" | "webgl" |
 * "caret", enabled, blend, ...type-specific }`:
 *   - image:    { src, fit, repeat, lightOpacity, darkOpacity,
 *                 lightInvert, darkInvert } — the old single
 *                 "Background Image" section, now one layer among many
 *   - gradient: { nodes: [{x, y, color}], animate, light/darkOpacity }
 *   - webgl:    { effectId, intensity, options }
 *   - caret:    { preset, color, intensity } — follows the text cursor
 * `backgroundLayersEnabled === false` switches the whole stack off
 * without discarding it (the checkbox in the section header).
 *
 * The list renders front-most layer at the top (Photoshop order) and
 * rows drag to reorder by their grip. Selecting a row shows that
 * layer's options underneath. Live edits push a scoped preview into the
 * modal's preview pane through the background-layers runtime.
 *
 * Per-type option blocks live in style-modal-gradient.js /
 * style-modal-webgl.js (700-line cap).
 */
import { escAttr, escHtml } from "./styles-panel-shared.js";
import { WEBGL_BG_EFFECTS, CARET_PRESETS, defaultGradientNodes } from "../background-layers/effects-registry.js";
import { renderGradientOptions, bindGradientOptions } from "./style-modal-gradient.js";
import { renderWebglOptions, bindWebglOptions, renderCaretOptions, bindCaretOptions } from "./style-modal-webgl.js";

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
const EYE_OFF_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><line x1="2.5" y1="13.5" x2="13.5" y2="2.5"/></svg>`;
const GRIP_SVG = `<svg viewBox="0 0 16 16" fill="currentColor" stroke="none"><circle cx="6" cy="4" r="1.15"/><circle cx="10" cy="4" r="1.15"/><circle cx="6" cy="8" r="1.15"/><circle cx="10" cy="8" r="1.15"/><circle cx="6" cy="12" r="1.15"/><circle cx="10" cy="12" r="1.15"/></svg>`;
const TRASH_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 4 4 4 14 4"/><path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M12 4v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4"/></svg>`;

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

function layerRowHtml(layer, selected) {
  const off = layer.enabled === false;
  const thumb = layer.type === "image" && layer.src
    ? `<span class="style-bg-layer-thumb" style="background-image:url('${escAttr(layer.src)}')"></span>`
    : "";
  const blend = layer.blend || "normal";
  return `
    <div class="style-bg-layer-row${selected ? " selected" : ""}${off ? " layer-off" : ""}" data-layer-id="${escAttr(layer.id)}">
      <button type="button" class="style-bg-layer-grip" data-layer-grip="${escAttr(layer.id)}" title="Drag to reorder" aria-label="Drag to reorder">${GRIP_SVG}</button>
      <button type="button" class="style-bg-layer-eye" data-layer-eye="${escAttr(layer.id)}" title="${off ? "Show layer" : "Hide layer"}">${off ? EYE_OFF_SVG : EYE_SVG}</button>
      ${thumb}
      <span class="style-bg-layer-label">${escHtml(layerTitle(layer))}</span>
      ${blend !== "normal" ? `<span class="style-bg-layer-blend">${escHtml(blend)}</span>` : ""}
      <button type="button" class="style-bg-layer-trash" data-layer-trash="${escAttr(layer.id)}" title="Delete layer" aria-label="Delete layer">${TRASH_SVG}</button>
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
  const on = layersEnabled(draft);
  if (_selectedLayerId && !layers.some(l => l.id === _selectedLayerId)) _selectedLayerId = null;
  if (!_selectedLayerId && layers.length) _selectedLayerId = layers[layers.length - 1].id;
  const sel = selectedLayer(draft);

  const header = `
    <div class="style-modal-section-header">
      <h3 class="style-modal-section-title">Background Layers</h3>
      <input type="checkbox" id="style-bg-layers-enable" aria-label="Enable background layers" ${on ? "checked" : ""} />
    </div>`;

  // Front-most layer (highest index) renders at the top of the list.
  const rows = layers.slice().reverse().map(l => layerRowHtml(l, sel && l.id === sel.id)).join("");
  const listHtml = layers.length
    ? `<div class="style-bg-layer-list">${rows}</div>`
    : `<div class="style-bg-layer-empty">No layers — add one below.</div>`;

  let optionsHtml = "";
  if (sel) {
    optionsHtml = `
      <div class="style-bg-layer-options" data-layer-id="${escAttr(sel.id)}">
        <div class="style-editor-row">
          <label>Blend</label>
          <select id="style-layer-blend">${BLEND_MODES.map(b => opt(b, cap(b), sel.blend || "normal")).join("")}</select>
        </div>
        ${sel.type === "image" ? imageOptionsHtml(sel) + opacityRowsHtml(sel) : ""}
        ${sel.type === "gradient" ? renderGradientOptions(sel) + opacityRowsHtml(sel) : ""}
        ${sel.type === "webgl" ? renderWebglOptions(sel) : ""}
        ${sel.type === "caret" ? renderCaretOptions(sel) : ""}
      </div>`;
  }

  return `${header}
    <div class="style-bg-layers-body${on ? "" : " style-row-hidden"}">
      ${listHtml}
      <div class="style-bg-layer-add">
        <button type="button" data-add-layer="image">+ Image</button>
        <button type="button" data-add-layer="gradient">+ Gradient</button>
        <button type="button" data-add-layer="webgl">+ WebGL</button>
        <button type="button" data-add-layer="caret">+ Caret</button>
      </div>
      ${optionsHtml}
    </div>`;
}

/** Background Layers section HTML + the footer action row — Export and
 *  (when the caller allows deleting this style) Delete side by side.
 *  The Delete button's click handler lives with the modal, which owns
 *  the confirm flow and the onDelete callback. */
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
    return { ...base, blend: "screen", preset: "sparks", color: "#9ecbff", intensity: 0.6 };
  }
  return {
    ...base, blend: "screen", effectId: WEBGL_BG_EFFECTS[0].id,
    intensity: 0.5, options: {},
  };
}

/** Wire the Background Layers section + Export button. `flushSave`
 *  (optional) commits any pending debounced edit before exporting so the
 *  download captures the latest draft. `appearance` is "light" | "dark"
 *  — whichever half the preview's own switch is showing. */
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

    // Row select + eye / trash buttons
    sectionEl.querySelectorAll(".style-bg-layer-row").forEach(row => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-layer-eye],[data-layer-trash],[data-layer-grip]")) return;
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
    sectionEl.querySelectorAll("[data-layer-trash]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = layers.findIndex(l => l.id === btn.dataset.layerTrash);
        if (idx < 0) return;
        layers.splice(idx, 1);
        const neighbor = layers[Math.min(idx, layers.length - 1)];
        _selectedLayerId = neighbor ? neighbor.id : null;
        rerenderSection();
        commit();
      });
    });

    bindRowDrag(sectionEl, layers, {
      onDrop: (orderedIds) => {
        // The list paints front-most first, so the DOM order is the
        // reverse of the array's back-to-front paint order.
        const byId = new Map(layers.map(l => [l.id, l]));
        const next = orderedIds.map(id => byId.get(id)).filter(Boolean).reverse();
        if (next.length === layers.length) layers.splice(0, layers.length, ...next);
        rerenderSection();
        commit();
      },
    });

    // Add-layer buttons
    sectionEl.querySelectorAll("[data-add-layer]").forEach(btn => {
      btn.addEventListener("click", () => {
        const layer = defaultLayer(btn.dataset.addLayer);
        layers.push(layer); // top of the stack (front-most)
        _selectedLayerId = layer.id;
        // Adding a layer while the section is switched off would file it
        // somewhere invisible — turn the section back on instead.
        draft.backgroundLayersEnabled = true;
        rerenderSection();
        commit();
      });
    });

    const sel = selectedLayer(draft);
    if (!sel) return;

    const blendEl = sectionEl.querySelector("#style-layer-blend");
    if (blendEl) blendEl.addEventListener("change", () => {
      sel.blend = blendEl.value;
      rerenderSection(); // the row badge shows the blend too
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

/**
 * Drag-to-reorder for the layer rows. The dragged row moves among its
 * siblings live, so the drop position is just the DOM order at pointer
 * release — no index arithmetic during the drag, and the visual and the
 * committed result can't disagree.
 *
 * The move listeners live on `document`, deliberately not on the grip
 * under a `setPointerCapture`: relocating the row mid-drag counts as a
 * remove-and-reinsert, which drops the capture, and the pointerup that
 * commits the reorder would never arrive.
 */
function bindRowDrag(sectionEl, layers, { onDrop }) {
  const list = sectionEl.querySelector(".style-bg-layer-list");
  if (!list) return;

  sectionEl.querySelectorAll("[data-layer-grip]").forEach(grip => {
    grip.addEventListener("pointerdown", (e) => {
      if (layers.length < 2) return;
      e.preventDefault();
      e.stopPropagation();
      const row = grip.closest(".style-bg-layer-row");
      if (!row) return;
      row.classList.add("dragging");
      list.classList.add("dragging-active");
      let moved = false;

      const onMove = (me) => {
        moved = true;
        const siblings = [...list.querySelectorAll(".style-bg-layer-row")].filter(r => r !== row);
        for (const other of siblings) {
          const r = other.getBoundingClientRect();
          if (me.clientY < r.top || me.clientY > r.bottom) continue;
          const before = me.clientY < r.top + r.height / 2;
          // Only actually move when the row would land somewhere new,
          // so hovering the same gap doesn't thrash the DOM.
          if (before && other.previousElementSibling !== row) list.insertBefore(row, other);
          else if (!before && other.nextElementSibling !== row) list.insertBefore(row, other.nextSibling);
          break;
        }
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove, true);
        document.removeEventListener("pointerup", onUp, true);
        document.removeEventListener("pointercancel", onUp, true);
        row.classList.remove("dragging");
        list.classList.remove("dragging-active");
        if (!moved) return;
        onDrop([...list.querySelectorAll(".style-bg-layer-row")].map(r => r.dataset.layerId));
      };
      document.addEventListener("pointermove", onMove, true);
      document.addEventListener("pointerup", onUp, true);
      document.addEventListener("pointercancel", onUp, true);
    });
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
