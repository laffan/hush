/* ============================================================
 * layers.js — layers-panel DOM wiring (stamped).
 *
 * Owns the DOM inside #layerList but not the layer data itself:
 * render(snapshot) receives { layers, activeLayerId } and rebuilds the
 * list. User interactions fire callbacks the glue wires into the engine
 * (and into history). Drag-reorder is pointer-based so it works on iPad.
 * ============================================================ */

const SVG = 'http://www.w3.org/2000/svg';
const ROW_GAP = 4;

function svgNode(d, w = 16) {
  const el = document.createElementNS(SVG, 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', String(w / 8));
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  el.appendChild(path);
  return el;
}

// Compact icon paths — single-path outlines, rendered at 16px.
const ICONS = {
  drag: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 9a3 3 0 100 6 3 3 0 000-6z',
  eyeOff: 'M3 3l18 18 M10.6 6.1A10.7 10.7 0 0112 6c6.5 0 10 6 10 6a15.8 15.8 0 01-3.8 4.4 M6.1 6.6A15.7 15.7 0 002 12s3.5 6 10 6a10.7 10.7 0 004.2-.8 M9.9 9.9a3 3 0 104.2 4.2',
  lock: 'M6 10V7a6 6 0 0112 0v3 M5 10h14v11H5z',
  unlock: 'M6 10V7a6 6 0 0112 0 M5 10h14v11H5z',
  pencil: 'M4 20h4L20 8l-4-4L4 16v4z',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6',
};

function iconButton(cls, title, pathD) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `layer-icon ${cls}`;
  btn.setAttribute('aria-label', title);
  btn.title = title;
  btn.appendChild(svgNode(pathD));
  return btn;
}

export function createLayersUI({
  panel,
  list,
  addBtn,
  callbacks,
}) {
  const cb = callbacks || {};
  let snapshot = { layers: [], activeLayerId: null };

  if (addBtn) {
    addBtn.addEventListener('click', () => {
      if (cb.onAdd) cb.onAdd();
    });
  }

  function render(next) {
    snapshot = next;
    list.innerHTML = '';
    const canDelete = snapshot.layers.length > 1;
    snapshot.layers.forEach((layer, idx) => {
      list.appendChild(buildRow(layer, idx, canDelete));
    });
  }

  function buildRow(layer, idx, canDelete) {
    const row = document.createElement('div');
    row.className = 'layer-row';
    row.setAttribute('role', 'listitem');
    row.dataset.layerId = String(layer.id);
    row.dataset.index = String(idx);
    if (layer.id === snapshot.activeLayerId) row.dataset.active = 'true';
    if (layer.hidden) row.dataset.hidden = 'true';

    // Drag handle
    const drag = document.createElement('button');
    drag.type = 'button';
    drag.className = 'layer-drag';
    drag.setAttribute('aria-label', 'Reorder layer');
    drag.title = 'Drag to reorder';
    drag.appendChild(svgNode(ICONS.drag));
    attachDrag(drag, row);
    row.appendChild(drag);

    // Name (click to activate; pencil icon starts rename)
    const name = document.createElement('div');
    name.className = 'layer-name';
    name.textContent = layer.name;
    name.addEventListener('click', (e) => {
      e.stopPropagation();
      if (cb.onSelect) cb.onSelect(layer.id);
    });
    row.appendChild(name);

    // Hide toggle
    const hideBtn = iconButton('layer-hide', layer.hidden ? 'Show layer' : 'Hide layer',
      layer.hidden ? ICONS.eyeOff : ICONS.eye);
    if (layer.hidden) hideBtn.dataset.on = 'true';
    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (cb.onToggleHidden) cb.onToggleHidden(layer.id);
    });
    row.appendChild(hideBtn);

    // Lock toggle
    const lockBtn = iconButton('layer-lock', layer.locked ? 'Unlock layer' : 'Lock layer',
      layer.locked ? ICONS.lock : ICONS.unlock);
    if (layer.locked) lockBtn.dataset.on = 'true';
    lockBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (cb.onToggleLocked) cb.onToggleLocked(layer.id);
    });
    row.appendChild(lockBtn);

    // Rename
    const renameBtn = iconButton('layer-rename', 'Rename layer', ICONS.pencil);
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(row, name, layer);
    });
    row.appendChild(renameBtn);

    // Delete
    const delBtn = iconButton('layer-delete', 'Delete layer', ICONS.trash);
    if (!canDelete) delBtn.disabled = true;
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!canDelete) return;
      if (cb.onDelete) cb.onDelete(layer.id);
    });
    row.appendChild(delBtn);

    return row;
  }

  function startRename(row, nameEl, layer) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'layer-name-input';
    input.value = layer.name;
    row.replaceChild(input, nameEl);
    input.focus();
    input.select();
    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const v = input.value.trim();
      if (v && v !== layer.name && cb.onRename) {
        cb.onRename(layer.id, v);
      } else {
        render(snapshot);
      }
    };
    const cancel = () => {
      if (committed) return;
      committed = true;
      render(snapshot);
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
  }

  // ---------- drag-reorder ----------
  function attachDrag(handle, row) {
    let active = false;
    let startY = 0;
    let startIdx = 0;
    let curIdx = 0;
    let rowHeight = 0;
    let listTop = 0;
    let rowCount = 0;

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      try { handle.setPointerCapture(e.pointerId); } catch {}
      active = true;
      startY = e.clientY;
      startIdx = +row.dataset.index;
      curIdx = startIdx;
      const rect = row.getBoundingClientRect();
      rowHeight = rect.height + ROW_GAP;
      listTop = list.getBoundingClientRect().top;
      rowCount = snapshot.layers.length;
      row.classList.add('dragging');
    });

    handle.addEventListener('pointermove', (e) => {
      if (!active) return;
      const dy = e.clientY - startY;
      row.style.transform = `translateY(${dy}px)`;
      const pointerRel = e.clientY - listTop;
      let target = Math.floor(pointerRel / rowHeight);
      if (target < 0) target = 0;
      if (target > rowCount - 1) target = rowCount - 1;
      curIdx = target;
    });

    const end = (e) => {
      if (!active) return;
      active = false;
      row.style.transform = '';
      row.classList.remove('dragging');
      try { handle.releasePointerCapture(e.pointerId); } catch {}
      if (curIdx !== startIdx && cb.onReorder) {
        cb.onReorder(startIdx, curIdx);
      }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  return {
    render,
    panel,
  };
}
