/**
 * The layer-stack UI shared by the style editor's two stacked sections —
 * Background and Post Processing.
 *
 * Both sections are the same interaction: an ordered list of layers
 * (index 0 = back, painted first), rendered front-most-at-top like
 * Photoshop, each row with a drag grip, a visibility eye, and a delete
 * button; selecting a row reveals that layer's options underneath; a row
 * of "+ Type" buttons appends new layers to the front of the stack.
 *
 * Only the per-type option blocks differ, so everything above lives here
 * and each section supplies:
 *   - `describe(layer)` → `{ title, badge?, thumb? }` for the row
 *   - `makeLayer(type)` → a fresh layer object
 *   - its own options markup + bindings
 *
 * This module is markup + events only; it never touches a runtime.
 */
import { escAttr, escHtml } from "./styles-panel-shared.js";

export const BLEND_MODES = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color-dodge", "color-burn", "hard-light", "soft-light",
  "difference", "exclusion", "hue", "saturation", "color", "luminosity",
];

export function opt(value, label, selected) {
  return `<option value="${escAttr(value)}"${value === selected ? " selected" : ""}>${escHtml(label)}</option>`;
}

export function cap(s) {
  return String(s).replace(/(^|[-\s])(\w)/g, (_, p, c) => (p === "-" ? " " : p) + c.toUpperCase());
}

export function newLayerId() {
  return "layer_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

/** A blend-mode `<select>` row. `id` is the element id the caller binds. */
export function blendRowHtml(id, value, label = "Blend") {
  return `
    <div class="style-editor-row">
      <label>${escHtml(label)}</label>
      <select id="${escAttr(id)}">${BLEND_MODES.map(b => opt(b, cap(b), value || "normal")).join("")}</select>
    </div>`;
}

const EYE_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>`;
const EYE_OFF_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><line x1="2.5" y1="13.5" x2="13.5" y2="2.5"/></svg>`;
const GRIP_SVG = `<svg viewBox="0 0 16 16" fill="currentColor" stroke="none"><circle cx="6" cy="4" r="1.15"/><circle cx="10" cy="4" r="1.15"/><circle cx="6" cy="8" r="1.15"/><circle cx="10" cy="8" r="1.15"/><circle cx="6" cy="12" r="1.15"/><circle cx="10" cy="12" r="1.15"/></svg>`;
const TRASH_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 4 4 4 14 4"/><path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M12 4v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4"/></svg>`;

function rowHtml(layer, info, selected) {
  const off = layer.enabled === false;
  const thumb = info.thumb
    ? `<span class="style-layer-thumb" style="background-image:url('${escAttr(info.thumb)}')"></span>`
    : "";
  return `
    <div class="style-layer-row${selected ? " selected" : ""}${off ? " layer-off" : ""}" data-layer-id="${escAttr(layer.id)}">
      <button type="button" class="style-layer-grip" data-layer-grip="${escAttr(layer.id)}" title="Drag to reorder" aria-label="Drag to reorder">${GRIP_SVG}</button>
      <button type="button" class="style-layer-eye" data-layer-eye="${escAttr(layer.id)}" title="${off ? "Show layer" : "Hide layer"}">${off ? EYE_OFF_SVG : EYE_SVG}</button>
      ${thumb}
      <span class="style-layer-label">${escHtml(info.title)}</span>
      ${info.badge ? `<span class="style-layer-badge">${escHtml(info.badge)}</span>` : ""}
      <button type="button" class="style-layer-trash" data-layer-trash="${escAttr(layer.id)}" title="Delete layer" aria-label="Delete layer">${TRASH_SVG}</button>
    </div>`;
}

/** The stack, front-most (highest index) at the top of the list. */
export function renderLayerList(layers, selectedId, describe) {
  if (!layers.length) return `<div class="style-layer-empty">No layers — add one below.</div>`;
  const rows = layers.slice().reverse()
    .map(l => rowHtml(l, describe(l) || { title: "Layer" }, l.id === selectedId))
    .join("");
  return `<div class="style-layer-list">${rows}</div>`;
}

/** `kinds`: `[{ type, label }]`. */
export function renderAddRow(kinds) {
  const buttons = kinds
    .map(k => `<button type="button" data-add-layer="${escAttr(k.type)}">+ ${escHtml(k.label)}</button>`)
    .join("");
  return `<div class="style-layer-add">${buttons}</div>`;
}

/** The per-appearance opacity pair carried by every layer type that
 *  composites as an element (image / gradient / caret). `opacity` is the
 *  pre-split single value and seeds both halves. */
export function renderOpacityRows(layer) {
  const legacy = layer.opacity != null ? layer.opacity : 1;
  const light = layer.lightOpacity != null ? layer.lightOpacity : legacy;
  const dark = layer.darkOpacity != null ? layer.darkOpacity : legacy;
  const row = (id, label, v) => `
    <div class="style-editor-row">
      <label>${label}</label>
      <div class="style-slider-group">
        <input type="range" id="${id}" min="0" max="1" step="0.05" value="${v}" />
        <span class="style-slider-value">${Math.round(v * 100)}%</span>
      </div>
    </div>`;
  return row("style-layer-opacity-light", "Opacity (Light)", light)
    + row("style-layer-opacity-dark", "Opacity (Dark)", dark);
}

export function bindOpacityRows(root, layer, onCommit) {
  const bind = (sel, field) => {
    const el = root.querySelector(sel);
    if (!el) return;
    el.addEventListener("input", () => {
      const v = parseFloat(el.value);
      layer[field] = v;
      if (el.nextElementSibling) el.nextElementSibling.textContent = Math.round(v * 100) + "%";
      onCommit();
    });
  };
  bind("#style-layer-opacity-light", "lightOpacity");
  bind("#style-layer-opacity-dark", "darkOpacity");
}

/**
 * Wire the list chrome: row selection, eye, delete, drag-reorder, and the
 * add buttons. `layers` is mutated in place.
 *
 * Callbacks:
 *   - `setSelected(id)` — record the selection (no re-render)
 *   - `rerender()`      — repaint the section and re-bind
 *   - `commit()`        — push a live preview + schedule the save
 *   - `makeLayer(type)` — build a fresh layer for an add button
 *   - `onAdd()`         — optional, called before the add re-renders
 */
export function bindLayerSection(sectionEl, layers, { setSelected, rerender, commit, makeLayer, onAdd }) {
  sectionEl.querySelectorAll(".style-layer-row").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-layer-eye],[data-layer-trash],[data-layer-grip]")) return;
      setSelected(row.dataset.layerId);
      rerender();
    });
  });

  sectionEl.querySelectorAll("[data-layer-eye]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const layer = layers.find(l => l.id === btn.dataset.layerEye);
      if (!layer) return;
      layer.enabled = layer.enabled === false;
      rerender();
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
      setSelected(neighbor ? neighbor.id : null);
      rerender();
      commit();
    });
  });

  bindRowDrag(sectionEl, layers, (orderedIds) => {
    // The list paints front-most first, so the DOM order is the reverse
    // of the array's back-to-front paint order.
    const byId = new Map(layers.map(l => [l.id, l]));
    const next = orderedIds.map(id => byId.get(id)).filter(Boolean).reverse();
    if (next.length === layers.length) layers.splice(0, layers.length, ...next);
    rerender();
    commit();
  });

  sectionEl.querySelectorAll("[data-add-layer]").forEach(btn => {
    btn.addEventListener("click", () => {
      const layer = makeLayer(btn.dataset.addLayer);
      if (!layer) return;
      layers.push(layer); // top of the stack (front-most)
      setSelected(layer.id);
      if (typeof onAdd === "function") onAdd();
      rerender();
      commit();
    });
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
function bindRowDrag(sectionEl, layers, onDrop) {
  const list = sectionEl.querySelector(".style-layer-list");
  if (!list) return;

  sectionEl.querySelectorAll("[data-layer-grip]").forEach(grip => {
    grip.addEventListener("pointerdown", (e) => {
      if (layers.length < 2) return;
      e.preventDefault();
      e.stopPropagation();
      const row = grip.closest(".style-layer-row");
      if (!row) return;
      row.classList.add("dragging");
      list.classList.add("dragging-active");
      let moved = false;

      const onMove = (me) => {
        moved = true;
        const siblings = [...list.querySelectorAll(".style-layer-row")].filter(r => r !== row);
        for (const other of siblings) {
          const r = other.getBoundingClientRect();
          if (me.clientY < r.top || me.clientY > r.bottom) continue;
          const before = me.clientY < r.top + r.height / 2;
          // Only actually move when the row would land somewhere new, so
          // hovering the same gap doesn't thrash the DOM.
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
        onDrop([...list.querySelectorAll(".style-layer-row")].map(r => r.dataset.layerId));
      };
      document.addEventListener("pointermove", onMove, true);
      document.addEventListener("pointerup", onUp, true);
      document.addEventListener("pointercancel", onUp, true);
    });
  });
}
