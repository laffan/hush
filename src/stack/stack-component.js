/**
 * StackComponent — side-scrolling column layout for docs, notebooks,
 * PDFs, and nested stacks. Each column has a 50px spine on its left
 * edge and a resizable content area.
 *
 * Resize: each spine's resize handle resizes the item to its LEFT.
 * A trailing resize zone after the last column handles the final item.
 *
 * Reorder: pressing the drag handle collapses all items to spine-only,
 * shows a ghost spine at the cursor, and lets the user drop between
 * spines. On release, all items restore to their prior open/closed state.
 */

import { createSpine } from "./stack-spine.js";
import { mountItemContent, unmountItemContent, snapshotItemContent } from "./stack-item-mount.js";

const SPINE_WIDTH = 50;
const DEFAULT_COLUMN_WIDTH = 800;
const BUFFER_COLUMNS = 1;
const MIN_COLUMN_WIDTH = 200;

export class StackComponent {
  constructor(container, data, state) {
    this._container = container;
    this._state = state;
    this._items = data.items || [];
    this._scrollX = data.scrollX || 0;
    this._liveColumns = new Map();
    this._destroyed = false;

    this._buildDOM();
    this._render();
    this._scrollArea.scrollLeft = this._scrollX;
    this._startVirtualization();
  }

  _buildDOM() {
    this._el = document.createElement("div");
    this._el.className = "stack-root";

    this._scrollArea = document.createElement("div");
    this._scrollArea.className = "stack-scroll-area";
    this._el.appendChild(this._scrollArea);

    this._columnsEl = document.createElement("div");
    this._columnsEl.className = "stack-columns";
    this._scrollArea.appendChild(this._columnsEl);

    this._addBtn = document.createElement("button");
    this._addBtn.className = "stack-add-btn";
    this._addBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    this._addBtn.addEventListener("click", () => this._openAddPicker());
    this._el.appendChild(this._addBtn);

    // Trailing resize zone for the last item
    this._trailResize = document.createElement("div");
    this._trailResize.className = "stack-trail-resize";
    this._trailResize.addEventListener("pointerdown", (e) => {
      if (this._items.length === 0) return;
      this._startResize(this._items[this._items.length - 1].id, e);
    });
    this._columnsEl.appendChild(this._trailResize);

    this._scrollArea.addEventListener("scroll", () => {
      this._scrollX = this._scrollArea.scrollLeft;
      this._updateVisibility();
    });

    this._container.appendChild(this._el);
  }

  _render() {
    // Remove all columns but keep trailing resize
    while (this._columnsEl.firstChild && this._columnsEl.firstChild !== this._trailResize) {
      this._columnsEl.removeChild(this._columnsEl.firstChild);
    }
    for (const item of this._items) {
      const col = this._createColumn(item);
      this._columnsEl.insertBefore(col, this._trailResize);
    }
    this._updateEmptyState();
    this._updateVisibility();
  }

  _updateEmptyState() {
    if (this._emptyEl) { this._emptyEl.remove(); this._emptyEl = null; }
    if (this._items.length === 0) {
      this._emptyEl = document.createElement("div");
      this._emptyEl.className = "stack-empty-state";
      this._emptyEl.innerHTML = `<div class="stack-empty-icon"><svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="12" y1="6" x2="12" y2="42"/><line x1="24" y1="6" x2="24" y2="42"/><line x1="36" y1="6" x2="36" y2="42"/></svg></div><div class="stack-empty-label">Empty stack</div><div class="stack-empty-hint">Drag files here or click + to add</div>`;
      this._scrollArea.appendChild(this._emptyEl);
    }
  }

  _createColumn(item) {
    const col = document.createElement("div");
    col.className = "stack-column";
    col.dataset.itemId = item.id;
    if (!item.open) col.classList.add("stack-column-closed");

    const width = item.open ? (item.width || DEFAULT_COLUMN_WIDTH) : 0;
    col.style.width = (SPINE_WIDTH + width) + "px";
    col.style.minWidth = SPINE_WIDTH + "px";
    col.style.flexShrink = "0";

    const spine = createSpine(item, {
      onToggle: () => this._toggleItem(item.id),
      onColorChange: (color) => this._setSpineColor(item.id, color),
      onDragStart: (e) => this._startReorder(item.id, e),
      onResizeStart: (e) => this._startResizeLeft(item.id, e),
    });
    col.appendChild(spine);

    const content = document.createElement("div");
    content.className = "stack-column-content";
    content.style.display = item.open ? "block" : "none";
    col.appendChild(content);

    // Auto-widen when internal panels open
    const ro = new ResizeObserver(() => {
      if (!item.open) return;
      const sw = content.scrollWidth;
      const cw = content.clientWidth;
      if (sw > cw + 4) {
        item.width = (item.width || DEFAULT_COLUMN_WIDTH) + (sw - cw);
        col.style.width = (SPINE_WIDTH + item.width) + "px";
      }
    });
    ro.observe(content);
    col._resizeObs = ro;

    return col;
  }

  _toggleItem(itemId) {
    const item = this._items.find((i) => i.id === itemId);
    if (!item) return;
    item.open = !item.open;
    const col = this._columnsEl.querySelector(`[data-item-id="${itemId}"]`);
    if (!col) return;

    if (item.open) {
      col.classList.remove("stack-column-closed");
      col.style.width = (SPINE_WIDTH + (item.width || DEFAULT_COLUMN_WIDTH)) + "px";
      const contentEl = col.querySelector(".stack-column-content");
      if (contentEl) contentEl.style.display = "block";
    } else {
      if (this._liveColumns.has(itemId)) {
        snapshotItemContent(col.querySelector(".stack-column-content"), item, this._liveColumns);
        unmountItemContent(col.querySelector(".stack-column-content"), item, this._liveColumns);
        this._liveColumns.delete(itemId);
      }
      col.classList.add("stack-column-closed");
      col.style.width = SPINE_WIDTH + "px";
      const contentEl = col.querySelector(".stack-column-content");
      if (contentEl) contentEl.style.display = "none";
    }
    this._updateVisibility();
  }

  _setSpineColor(itemId, color) {
    const item = this._items.find((i) => i.id === itemId);
    if (item) item.spineColor = color;
    const col = this._columnsEl.querySelector(`[data-item-id="${itemId}"]`);
    const spine = col?.querySelector(".stack-spine");
    if (spine) spine.style.backgroundColor = color || "";
  }

  // --- Resize: handle resizes the item to its LEFT ---

  _startResizeLeft(itemId, e) {
    e.preventDefault();
    const idx = this._items.findIndex((i) => i.id === itemId);
    // Resize the item to the left of this spine
    const targetIdx = idx - 1;
    if (targetIdx < 0) return; // first spine has nothing to its left
    this._startResize(this._items[targetIdx].id, e);
  }

  _startResize(itemId, e) {
    e.preventDefault();
    const item = this._items.find((i) => i.id === itemId);
    if (!item || !item.open) return;
    const col = this._columnsEl.querySelector(`[data-item-id="${itemId}"]`);
    if (!col) return;

    const startX = e.clientX;
    const startWidth = item.width || DEFAULT_COLUMN_WIDTH;
    document.body.classList.add("stack-resizing");

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const newWidth = Math.max(MIN_COLUMN_WIDTH, startWidth + dx);
      item.width = newWidth;
      col.style.width = (SPINE_WIDTH + newWidth) + "px";
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.classList.remove("stack-resizing");
      this._updateVisibility();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  // --- Reorder: collapse-all, ghost spine, drop-zone ---

  _startReorder(itemId, e) {
    e.preventDefault();
    const idx = this._items.findIndex((i) => i.id === itemId);
    if (idx < 0) return;
    const item = this._items[idx];

    // Save open/closed states and collapse all columns
    const savedStates = this._items.map((it) => ({ id: it.id, open: it.open }));
    for (const it of this._items) {
      const col = this._columnsEl.querySelector(`[data-item-id="${it.id}"]`);
      if (!col) continue;
      col.classList.add("stack-column-closed");
      col.style.width = SPINE_WIDTH + "px";
      const contentEl = col.querySelector(".stack-column-content");
      if (contentEl) contentEl.style.display = "none";
    }

    // Create ghost spine
    const ghost = document.createElement("div");
    ghost.className = "stack-reorder-ghost";
    const spine = this._columnsEl.querySelector(`[data-item-id="${itemId}"] .stack-spine`);
    if (spine) ghost.innerHTML = spine.innerHTML;
    ghost.style.height = this._scrollArea.clientHeight + "px";
    document.body.appendChild(ghost);

    // Hide the dragged column's spine visually
    const dragCol = this._columnsEl.querySelector(`[data-item-id="${itemId}"]`);
    if (dragCol) dragCol.classList.add("stack-column-reorder-source");

    // Create drop zone indicators
    const dropZones = [];
    const cols = Array.from(this._columnsEl.querySelectorAll(".stack-column"));
    for (let i = 0; i <= cols.length; i++) {
      const dz = document.createElement("div");
      dz.className = "stack-drop-zone";
      dropZones.push(dz);
    }

    let insertIdx = idx;
    const startX = e.clientX;

    const onMove = (ev) => {
      ghost.style.left = (ev.clientX - SPINE_WIDTH / 2) + "px";
      ghost.style.top = this._scrollArea.getBoundingClientRect().top + "px";

      // Determine insertion index from cursor position among collapsed spines
      const activeCols = Array.from(this._columnsEl.querySelectorAll(".stack-column"));
      let newIdx = activeCols.length;
      for (let i = 0; i < activeCols.length; i++) {
        const rect = activeCols[i].getBoundingClientRect();
        if (ev.clientX < rect.left + rect.width / 2) {
          newIdx = i;
          break;
        }
      }
      if (newIdx !== insertIdx) {
        insertIdx = newIdx;
        // Move drop indicator
        this._columnsEl.querySelectorAll(".stack-drop-indicator").forEach((el) => el.remove());
        const indicator = document.createElement("div");
        indicator.className = "stack-drop-indicator";
        const refCol = activeCols[insertIdx] || null;
        this._columnsEl.insertBefore(indicator, refCol);
      }
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      ghost.remove();
      this._columnsEl.querySelectorAll(".stack-drop-indicator").forEach((el) => el.remove());
      if (dragCol) dragCol.classList.remove("stack-column-reorder-source");

      // Perform the reorder
      const currentIdx = this._items.findIndex((i) => i.id === itemId);
      if (insertIdx !== currentIdx) {
        const [moved] = this._items.splice(currentIdx, 1);
        const targetIdx = insertIdx > currentIdx ? insertIdx - 1 : insertIdx;
        this._items.splice(targetIdx, 0, moved);
        const refNode = this._columnsEl.querySelectorAll(".stack-column")[targetIdx] || this._trailResize;
        this._columnsEl.insertBefore(dragCol, refNode);
      }

      // Restore open/closed states
      for (const saved of savedStates) {
        const it = this._items.find((i) => i.id === saved.id);
        if (!it) continue;
        it.open = saved.open;
        const col = this._columnsEl.querySelector(`[data-item-id="${saved.id}"]`);
        if (!col) continue;
        if (it.open) {
          col.classList.remove("stack-column-closed");
          col.style.width = (SPINE_WIDTH + (it.width || DEFAULT_COLUMN_WIDTH)) + "px";
          const contentEl = col.querySelector(".stack-column-content");
          if (contentEl) contentEl.style.display = "block";
        } else {
          col.classList.add("stack-column-closed");
          col.style.width = SPINE_WIDTH + "px";
        }
      }
      this._updateVisibility();
    };

    // Position ghost initially
    ghost.style.left = (e.clientX - SPINE_WIDTH / 2) + "px";
    ghost.style.top = this._scrollArea.getBoundingClientRect().top + "px";

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  // --- Virtualization ---

  _startVirtualization() {
    this._visRaf = null;
    this._updateVisibility();
  }

  _updateVisibility() {
    if (this._visRaf) return;
    this._visRaf = requestAnimationFrame(() => {
      this._visRaf = null;
      this._doUpdateVisibility();
    });
  }

  _doUpdateVisibility() {
    if (this._destroyed) return;
    const scrollLeft = this._scrollArea.scrollLeft;
    const viewWidth = this._scrollArea.clientWidth;
    const viewRight = scrollLeft + viewWidth;
    let accX = 0;
    for (const item of this._items) {
      const colWidth = item.open ? SPINE_WIDTH + (item.width || DEFAULT_COLUMN_WIDTH) : SPINE_WIDTH;
      const colLeft = accX;
      const colRight = accX + colWidth;
      accX = colRight;
      if (!item.open) continue;
      const col = this._columnsEl.querySelector(`[data-item-id="${item.id}"]`);
      if (!col) continue;
      const contentEl = col.querySelector(".stack-column-content");
      if (!contentEl) continue;
      const bufferPx = (DEFAULT_COLUMN_WIDTH + SPINE_WIDTH) * BUFFER_COLUMNS;
      const isVisible = colRight >= (scrollLeft - bufferPx) && colLeft <= (viewRight + bufferPx);
      if (isVisible && !this._liveColumns.has(item.id)) {
        mountItemContent(contentEl, item, this._state, this._liveColumns);
      } else if (!isVisible && this._liveColumns.has(item.id)) {
        snapshotItemContent(contentEl, item, this._liveColumns);
        unmountItemContent(contentEl, item, this._liveColumns);
      }
    }
  }

  // --- Public API ---

  addItem(fileId, fileType, name) {
    const item = {
      id: crypto.randomUUID(), fileId, fileType, name,
      width: DEFAULT_COLUMN_WIDTH, open: true,
      scrollY: 0, cameraState: null, spineColor: null,
    };
    this._items.push(item);
    this._updateEmptyState();
    const col = this._createColumn(item);
    this._columnsEl.insertBefore(col, this._trailResize);
    this._updateVisibility();
    requestAnimationFrame(() => { this._scrollArea.scrollLeft = this._scrollArea.scrollWidth; });
    return item;
  }

  removeItem(itemId) {
    const idx = this._items.findIndex((i) => i.id === itemId);
    if (idx < 0) return;
    if (this._liveColumns.has(itemId)) {
      const col = this._columnsEl.querySelector(`[data-item-id="${itemId}"]`);
      const contentEl = col?.querySelector(".stack-column-content");
      if (contentEl) unmountItemContent(contentEl, this._items[idx], this._liveColumns);
    }
    this._items.splice(idx, 1);
    const col = this._columnsEl.querySelector(`[data-item-id="${itemId}"]`);
    if (col) col.remove();
    this._updateEmptyState();
  }

  serialize() {
    for (const [itemId, liveData] of this._liveColumns) {
      const item = this._items.find((i) => i.id === itemId);
      if (item && liveData.getScrollState) {
        const s = liveData.getScrollState();
        item.scrollY = s.scrollY ?? item.scrollY;
        item.cameraState = s.cameraState ?? item.cameraState;
      }
    }
    return { items: this._items, scrollX: this._scrollX };
  }

  async _openAddPicker() {
    const { openStackFilePicker } = await import("./stack-picker.js");
    openStackFilePicker(this._state, (fileId, fileType, name) => {
      this.addItem(fileId, fileType, name);
    });
  }

  handleFileDrop(fileId, fileType, name) { this.addItem(fileId, fileType, name); }

  destroy() {
    this._destroyed = true;
    if (this._visRaf) cancelAnimationFrame(this._visRaf);
    for (const [itemId] of this._liveColumns) {
      const item = this._items.find((i) => i.id === itemId);
      const col = this._columnsEl.querySelector(`[data-item-id="${itemId}"]`);
      const contentEl = col?.querySelector(".stack-column-content");
      if (contentEl && item) unmountItemContent(contentEl, item, this._liveColumns);
    }
    this._liveColumns.clear();
    this._el.remove();
  }
}
