/* ============================================================
 * script.js (stamped) — entry module for the canvas-stamp renderer.
 *
 * Wires identical modules to pure-svg (selection, history, gestures)
 * but points the stroke engine at three <canvas> layers instead of an
 * SVG done/live pair. The UI model here is different: three brush
 * slots in the toolbar, each holding a full pen config. Clicking a
 * slot activates it and toggles a shared flyout panel that edits that
 * slot's Size/Stream/Smooth/Spacing/Brush/Color.
 * ============================================================ */

import { createStrokeEngine } from './stroke.js';
import { createSelectionEngine } from './selection.js';
import { createUI } from './ui.js';
import { createHistory } from './history.js';
import { createGestures } from './gestures.js';
import { createLayersUI } from './layers.js';

// ---------- DOM lookups ----------
const svg = document.getElementById('canvas');
const doneCanvas = document.getElementById('done');
const previewCanvas = document.getElementById('preview');
const liveCanvas = document.getElementById('live');
const eraserCursor = document.getElementById('eraserCursor');
const selectionLayer = document.getElementById('selectionLayer');
const longPressHint = document.getElementById('longPressHint');

const sizeInput = document.getElementById('size');
const sizeVal = document.getElementById('sizeVal');
const streamInput = document.getElementById('stream');
const streamVal = document.getElementById('streamVal');
const smoothInput = document.getElementById('smooth');
const smoothVal = document.getElementById('smoothVal');
const spacingInput = document.getElementById('spacing');
const spacingVal = document.getElementById('spacingVal');
const clearBtn = document.getElementById('clear');
const brushGrid = document.getElementById('brushGrid');
const flyoutPanel = document.getElementById('brushPanel');
const eraserPanel = document.getElementById('eraserPanel');
const layersPanel = document.getElementById('layersPanel');
const layerList = document.getElementById('layerList');
const layersAddBtn = document.getElementById('layersAdd');
const layersBtn = document.getElementById('layersBtn');
const eraserSizeInput = document.getElementById('eraserSize');
const eraserSizeVal = document.getElementById('eraserSizeVal');
const toolButtons = document.querySelectorAll('.tool[data-tool]');
const slotButtons = document.querySelectorAll('.brush-slot');
const swatches = document.querySelectorAll('.swatch');
const modeToggle = document.getElementById('highlighterToggle');

// ---------- shared: cached canvas rect ----------
let cachedRect = { left: 0, top: 0, width: 0, height: 0 };
function sizeCanvas() {
  const r = svg.getBoundingClientRect();
  cachedRect = { left: r.left, top: r.top, width: r.width, height: r.height };
  svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
  strokeEngine && strokeEngine.resize(r.width, r.height);
}
window.addEventListener('resize', sizeCanvas);
window.addEventListener('scroll', sizeCanvas, { passive: true });
const getRect = () => cachedRect;

// ---------- tool state ----------
let currentTool = 'draw';
let transientSelect = false;
let returnToolAfterTransient = 'draw';

function leaveTransientSelect() {
  if (!transientSelect) return;
  const back = returnToolAfterTransient;
  transientSelect = false;
  setTool(back);
}

// ---------- "Select" confirmation bubble ----------
let selectHintTimer = 0;
function flashSelectBubble(p) {
  clearTimeout(selectHintTimer);
  longPressHint.textContent = 'Select';
  longPressHint.style.left = `${p.x}px`;
  longPressHint.style.top = `${p.y}px`;
  longPressHint.classList.add('visible');
  selectHintTimer = setTimeout(() => {
    longPressHint.classList.remove('visible');
  }, 900);
}

// ---------- brush slots ----------
// Three independent pen configs. The flyout edits the active slot in
// place; the stroke engine is always reflecting the active slot.
const slots = [
  { brushId: 'brush-1', color: '#111111', size: 4,  streamline: 0.35, smoothing: 1, spacing: 0.12, mode: 'normal' },
  { brushId: 'brush-2', color: '#2563eb', size: 8,  streamline: 0.35, smoothing: 1, spacing: 0.12, mode: 'normal' },
  { brushId: 'brush-3', color: '#e11d48', size: 6,  streamline: 0.35, smoothing: 1, spacing: 0.12, mode: 'normal' },
  { brushId: 'brush-highlighter', color: '#fde047', size: 20, streamline: 0.35, smoothing: 1, spacing: 0.1, mode: 'highlighter' },
];
let activeSlot = 0;

function applySlotToEngine(i) {
  const s = slots[i];
  strokeEngine.setBrush(s.brushId);
  strokeEngine.setColor(s.color);
  strokeEngine.setSize(s.size);
  strokeEngine.setStreamline(s.streamline);
  strokeEngine.setSmoothing(s.smoothing);
  strokeEngine.setSpacing(s.spacing);
  strokeEngine.setMode(s.mode || 'normal');
}

function activateSlot(i) {
  activeSlot = i;
  applySlotToEngine(i);
  ui.setActiveSlot(i);
  ui.setFlyoutValues(slots[i]);
  redrawSlotThumbs();
  redrawBrushGrid();
  if (currentTool !== 'draw') setTool('draw');
}

// ---------- retroactive-style session (selection retroact) ----------
let styleSession = null;

function snapshotStyles(ids) {
  const map = new Map();
  for (const s of strokeEngine.getStrokes()) {
    if (ids.has(s.id)) {
      map.set(s.id, { color: s.color, size: s.size, brushId: s.brush, mode: s.mode || 'normal' });
    }
  }
  return map;
}

function beginStyleSession(ids) {
  styleSession = { before: snapshotStyles(ids) };
}

function commitStyleSession() {
  if (!styleSession) return;
  const { before } = styleSession;
  styleSession = null;
  const after = snapshotStyles(new Set(before.keys()));
  let changed = false;
  for (const [id, b] of before) {
    const a = after.get(id);
    if (!a) continue;
    if (a.color !== b.color || a.size !== b.size || a.brushId !== b.brushId || a.mode !== b.mode) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  history.push({
    undo: () => strokeEngine.setStrokesStyleMap(before),
    redo: () => strokeEngine.setStrokesStyleMap(after),
  });
}

function applyStyleAtomic(patch) {
  const ids = selectionEngine.getSelectedIds();
  beginStyleSession(ids);
  strokeEngine.setStrokesStyle(ids, patch);
  commitStyleSession();
  // Size/brush changes may have altered visible extent; refresh the
  // bounding box so handles track the new geometry.
  selectionEngine.refreshBBox();
}

// ---------- engines ----------
const history = createHistory();

const strokeEngine = createStrokeEngine({
  svg,
  doneCanvas,
  previewCanvas,
  liveCanvas,
  eraserCursor,
  getRect,
  onLongPress: ({ pointerId, point }) => {
    if (currentTool !== 'draw' && currentTool !== 'erase') return;
    returnToolAfterTransient = currentTool;
    transientSelect = true;
    setTool('select');
    selectionEngine.startLassoAtPointer(pointerId, point);
    flashSelectBubble(point);
  },
  onStrokeAdded: (stroke, index) => {
    if (history.isReplaying()) return;
    history.push({
      undo: () => strokeEngine.removeStrokes([stroke.id]),
      redo: () => strokeEngine.insertStrokeAt(stroke, index),
    });
  },
  onStrokesRemoved: (removed) => {
    if (history.isReplaying()) return;
    const entries = removed.map((r) => ({ stroke: r.stroke, index: r.index }));
    history.push({
      undo: () => {
        for (const r of entries) strokeEngine.insertStrokeAt(r.stroke, r.index);
      },
      redo: () => {
        strokeEngine.removeStrokes(entries.map((r) => r.stroke.id));
      },
    });
  },
  onStrokesTransformed: (entries) => {
    if (history.isReplaying()) return;
    history.push({
      undo: () => {
        for (const e of entries) strokeEngine.setStrokePoints(e.id, e.before);
      },
      redo: () => {
        for (const e of entries) strokeEngine.setStrokePoints(e.id, e.after);
      },
    });
  },
  onStrokesSliced: ({ removed, added }) => {
    if (history.isReplaying()) return;
    // removed: [{stroke, originalIndex}] asc; added: [{stroke, finalIndex}] asc.
    // Undo: pull added back out, then re-insert removed at their original
    // positions. Redo: opposite.
    const removedRefs = removed.map((r) => ({ stroke: r.stroke, index: r.originalIndex }));
    const addedRefs = added.map((a) => ({ stroke: a.stroke, index: a.finalIndex }));
    history.push({
      undo: () => {
        if (addedRefs.length) strokeEngine.removeStrokes(addedRefs.map((a) => a.stroke.id));
        for (const r of removedRefs) strokeEngine.insertStrokeAt(r.stroke, r.index);
      },
      redo: () => {
        if (removedRefs.length) strokeEngine.removeStrokes(removedRefs.map((r) => r.stroke.id));
        for (const a of addedRefs) strokeEngine.insertStrokeAt(a.stroke, a.index);
      },
    });
  },
  onBrushAtlasLoaded: () => {
    // PNG landed for one brush slot. Cheap to redo both the slot
    // thumbnails and the flyout's brush grid.
    redrawSlotThumbs();
    redrawBrushGrid();
  },
  onLayersChanged: () => {
    if (layersUI) renderLayers();
  },
});

const selectionEngine = createSelectionEngine({
  svg,
  layer: selectionLayer,
  getRect,
  strokeEngine,
  isSelectable: (s) => {
    const L = strokeEngine.getLayerById(s.layerId);
    return !!L && !L.locked && !L.hidden;
  },
  onExit: () => {
    if (transientSelect) leaveTransientSelect();
    else setTool('draw');
  },
  onLassoComplete: ({ selected }) => {
    if (transientSelect && !selected) leaveTransientSelect();
  },
  onSelectionDeleted: () => {
    if (transientSelect) leaveTransientSelect();
  },
});

const ui = createUI({
  toolButtons,
  slotButtons,
  clearBtn,
  layersBtn,
  flyoutPanel,
  eraserPanel,
  layersPanel,
  eraserSizeInput,
  eraserSizeVal,
  sizeInput, sizeVal,
  streamInput, streamVal,
  smoothInput, smoothVal,
  spacingInput, spacingVal,
  brushGrid,
  brushes: strokeEngine.getBrushList(),
  swatches,
  modeToggle,
  onToolChange: (t) => {
    transientSelect = false;
    ui.closeFlyout();
    ui.closeEraserPanel();
    setTool(t);
  },
  onToolReclick: (t) => {
    // Re-tap on erase or slice while that tool is active opens the
    // shared thickness flyout (both tools share state.eraserSize).
    if (t === 'erase' || t === 'slice') ui.toggleEraserPanel();
  },
  onEraserSizeChange: (n) => strokeEngine.setEraserSize(n),
  onSlotClick: (i) => {
    // With a selection held, a slot click retroacts the slot's brush,
    // color, size, and mode onto the selected strokes — one history entry
    // — without changing the active slot or toggling the flyout.
    if (selectionEngine.hasSelection()) {
      const cfg = slots[i];
      applyStyleAtomic({ brushId: cfg.brushId, color: cfg.color, size: cfg.size, mode: cfg.mode || 'normal' });
      return;
    }
    // Click a slot: if inactive, activate + open flyout. If active, toggle
    // the flyout's open state. Either way, commit to draw mode.
    if (activeSlot !== i) {
      activateSlot(i);
      ui.openFlyout();
      return;
    }
    ui.toggleFlyout();
  },
  onClear: () => {
    strokeEngine.clear();
    if (currentTool === 'select') {
      selectionEngine.deactivate();
      selectionEngine.activate();
    }
  },
  onColorChange: (c) => {
    // With a selection, the color click retroacts on the selected strokes
    // and leaves both the active slot and the current tool alone. Reset
    // the swatch highlight afterwards so the flyout still reflects the
    // slot's persistent color. Without a selection, update the active slot
    // and refresh its thumbnail.
    if (selectionEngine.hasSelection()) {
      applyStyleAtomic({ color: c });
      ui.setColorSwatch(slots[activeSlot].color);
      return;
    }
    slots[activeSlot].color = c;
    strokeEngine.setColor(c);
    redrawSlotThumb(activeSlot);
    redrawBrushGrid();
  },
  onSizeChange: (n) => {
    // Selection retroact live during drag (one history entry on release).
    // No selection → update the active slot's size.
    if (selectionEngine.hasSelection()) {
      if (!styleSession) beginStyleSession(selectionEngine.getSelectedIds());
      strokeEngine.setStrokesStyle(selectionEngine.getSelectedIds(), { size: n });
      selectionEngine.refreshBBox();
    } else {
      slots[activeSlot].size = n;
      strokeEngine.setSize(n);
    }
  },
  onSizeCommit: () => {
    if (styleSession) commitStyleSession();
  },
  onStreamChange: (v) => {
    slots[activeSlot].streamline = v;
    strokeEngine.setStreamline(v);
  },
  onSmoothChange: (v) => {
    slots[activeSlot].smoothing = v;
    strokeEngine.setSmoothing(v);
  },
  onSpacingChange: (v) => {
    // Slider is in percent (5..50); engine wants fraction.
    const frac = v / 100;
    slots[activeSlot].spacing = frac;
    strokeEngine.setSpacing(frac);
  },
  onBrushChange: (id) => {
    slots[activeSlot].brushId = id;
    strokeEngine.setBrush(id);
    redrawSlotThumb(activeSlot);
  },
  onModeChange: (mode) => {
    // Mirror the color handler: retroact on a selection, otherwise update
    // the active slot. The mode toggle reflects the active slot's state;
    // reset it when a retroact consumed the click so the flyout keeps
    // showing the slot's persistent mode.
    if (selectionEngine.hasSelection()) {
      applyStyleAtomic({ mode });
      ui.setModeToggle(slots[activeSlot].mode || 'normal');
      return;
    }
    slots[activeSlot].mode = mode;
    strokeEngine.setMode(mode);
    redrawSlotThumb(activeSlot);
    redrawBrushGrid();
  },
  onLayersToggle: () => {
    ui.toggleLayersPanel();
  },
});

// ---------- layers ----------
// Any layer mutation that touches existing strokes or the selection set
// invalidates the bounding box; easiest to blow the selection away.
function clearSelectionForLayerChange() {
  if (currentTool === 'select') {
    selectionEngine.deactivate();
    selectionEngine.activate();
  }
}

const layersUI = createLayersUI({
  panel: layersPanel,
  list: layerList,
  addBtn: layersAddBtn,
  callbacks: {
    onSelect: (id) => {
      if (strokeEngine.getActiveLayerId() === id) return;
      strokeEngine.setActiveLayer(id);
    },
    onAdd: () => {
      // Remember the layer id we want for redo so it can be deterministically
      // recreated. The engine allocates a fresh id on the first call; redo
      // pins to that same id so history-dependent stroke layerIds still match.
      let captured = null;
      const doCreate = () => {
        const res = captured
          ? strokeEngine.createLayer({ idHint: captured.id, name: captured.name, atIndex: captured.atIndex })
          : strokeEngine.createLayer();
        if (!captured) captured = { id: res.layer.id, name: res.layer.name, atIndex: res.index };
        return res;
      };
      const res = doCreate();
      history.push({
        undo: () => { strokeEngine.deleteLayer(captured.id); },
        redo: () => { doCreate(); },
      });
      // Creation doesn't touch existing strokes, but active-layer changes
      // after delete/undo could so keep the selection fresh.
      void res;
    },
    onDelete: (id) => {
      const snap = strokeEngine.deleteLayer(id);
      if (!snap) return;
      clearSelectionForLayerChange();
      history.push({
        undo: () => { strokeEngine.restoreLayerSnapshot(snap); clearSelectionForLayerChange(); },
        redo: () => { strokeEngine.deleteLayer(id); clearSelectionForLayerChange(); },
      });
    },
    onRename: (id, name) => {
      const before = strokeEngine.getLayerById(id);
      if (!before || before.name === name) return;
      strokeEngine.renameLayer(id, name);
      history.push({
        undo: () => strokeEngine.renameLayer(id, before.name),
        redo: () => strokeEngine.renameLayer(id, name),
      });
    },
    onToggleLocked: (id) => {
      const before = strokeEngine.getLayerById(id);
      if (!before) return;
      const next = !before.locked;
      strokeEngine.setLayerLocked(id, next);
      clearSelectionForLayerChange();
      history.push({
        undo: () => { strokeEngine.setLayerLocked(id, !next); clearSelectionForLayerChange(); },
        redo: () => { strokeEngine.setLayerLocked(id, next); clearSelectionForLayerChange(); },
      });
    },
    onToggleHidden: (id) => {
      const before = strokeEngine.getLayerById(id);
      if (!before) return;
      const next = !before.hidden;
      strokeEngine.setLayerHidden(id, next);
      clearSelectionForLayerChange();
      history.push({
        undo: () => { strokeEngine.setLayerHidden(id, !next); clearSelectionForLayerChange(); },
        redo: () => { strokeEngine.setLayerHidden(id, next); clearSelectionForLayerChange(); },
      });
    },
    onReorder: (fromIdx, toIdx) => {
      if (!strokeEngine.moveLayer(fromIdx, toIdx)) return;
      history.push({
        undo: () => strokeEngine.moveLayer(toIdx, fromIdx),
        redo: () => strokeEngine.moveLayer(fromIdx, toIdx),
      });
    },
  },
});

function renderLayers() {
  layersUI.render({
    layers: strokeEngine.getLayers(),
    activeLayerId: strokeEngine.getActiveLayerId(),
  });
}

// ---------- thumbnail rendering ----------
// Each slot button has a <canvas class="brush-thumb"> inside it. We redraw
// it when the slot's brush or color changes, or when a brush PNG finishes
// decoding (the engine fires onBrushAtlasLoaded).
const thumbCtxs = Array.from(slotButtons).map((btn) => {
  const c = btn.querySelector('canvas.brush-thumb');
  return { canvas: c, ctx: c.getContext('2d') };
});

function redrawSlotThumb(i) {
  const t = thumbCtxs[i];
  if (!t) return;
  const { canvas, ctx } = t;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const cfg = slots[i];
  strokeEngine.renderBrushSwatch(cfg.brushId, cfg.color, ctx, w / 2, h / 2, Math.min(w, h), cfg.mode);
}
function redrawSlotThumbs() {
  for (let i = 0; i < slots.length; i++) redrawSlotThumb(i);
}

// Paint the flyout's brush grid in the active slot's color so the tile
// previews reflect "what this brush would look like with your current
// colour". Called when the active slot changes, when its colour changes,
// and when a brush PNG finishes decoding.
function redrawBrushGrid() {
  const cfg = slots[activeSlot];
  for (const b of strokeEngine.getBrushList()) {
    const canvas = ui.getBrushCanvas(b.id);
    if (!canvas) continue;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    strokeEngine.renderBrushSwatch(b.id, cfg.color, ctx, w / 2, h / 2, Math.min(w, h), cfg.mode);
  }
}

// ---------- gestures ----------
function refreshSelectionAfterHistory() {
  if (currentTool !== 'select') return;
  selectionEngine.deactivate();
  selectionEngine.activate();
}

createGestures({
  getRect,
  strokeEngine,
  selectionEngine,
  onUndo: () => { if (history.undo()) refreshSelectionAfterHistory(); },
  onRedo: () => { if (history.redo()) refreshSelectionAfterHistory(); },
});

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  if (e.key === 'z' || e.key === 'Z') {
    e.preventDefault();
    if (e.shiftKey) {
      if (history.redo()) refreshSelectionAfterHistory();
    } else {
      if (history.undo()) refreshSelectionAfterHistory();
    }
  } else if (e.key === 'y' || e.key === 'Y') {
    e.preventDefault();
    if (history.redo()) refreshSelectionAfterHistory();
  }
});

// ---------- tool switching ----------
function setTool(tool) {
  if (tool === currentTool) return;
  if (currentTool === 'select' && tool !== 'select') {
    transientSelect = false;
  }
  currentTool = tool;
  ui.setTool(tool);
  strokeEngine.setTool(tool);
  if (tool === 'select') {
    selectionEngine.activate();
    svg.classList.add('selecting');
  } else {
    selectionEngine.deactivate();
    svg.classList.remove('selecting');
  }
}

// ---------- initial state ----------
// Push slot 0's config into the engine + flyout, then size the canvases.
applySlotToEngine(activeSlot);
ui.setActiveSlot(activeSlot);
ui.setFlyoutValues(slots[activeSlot]);
ui.setEraserSize(strokeEngine.getEraserSize());
sizeCanvas();
// Draw initial thumbs (uses procedural fallback until PNGs load).
redrawSlotThumbs();
redrawBrushGrid();
renderLayers();

// ---------- iOS Safari gesture suppression ----------
svg.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
svg.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
