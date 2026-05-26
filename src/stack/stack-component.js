/**
 * StackComponent — side-scrolling column layout for docs, notebooks,
 * PDFs, and nested stacks. Each column has a 50px spine on its left
 * edge and a resizable content area.
 *
 * Memory strategy: only columns within the visible viewport (plus one
 * buffer column on each side) are live-mounted. Off-screen columns are
 * represented by lightweight placeholder divs. PDFs always use snapshot
 * + activate (matching the pane pattern). Docs and notebooks are live
 * when visible and unmounted when scrolled away.
 */

import { createSpine } from "./stack-spine.js";
import { mountItemContent, unmountItemContent, snapshotItemContent } from "./stack-item-mount.js";

const SPINE_WIDTH = 50;
const DEFAULT_COLUMN_WIDTH = 500;
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

    // Floating add button (bottom-right)
    this._addBtn = document.createElement("button");
    this._addBtn.className = "stack-add-btn";
    this._addBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    this._addBtn.addEventListener("click", () => this._openAddPicker());
    this._el.appendChild(this._addBtn);

    this._scrollArea.addEventListener("scroll", () => {
      this._scrollX = this._scrollArea.scrollLeft;
      this._updateVisibility();
    });

    this._container.appendChild(this._el);
  }

  _render() {
    this._columnsEl.innerHTML = "";
    for (const item of this._items) {
      const col = this._createColumn(item);
      this._columnsEl.appendChild(col);
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
    });
    col.appendChild(spine);

    const content = document.createElement("div");
    content.className = "stack-column-content";
    content.style.display = item.open ? "block" : "none";
    col.appendChild(content);

    // Resize handle on the right edge of each column
    const resizer = document.createElement("div");
    resizer.className = "stack-column-resizer";
    resizer.addEventListener("pointerdown", (e) => this._startResize(item.id, e));
    col.appendChild(resizer);

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
      // Snapshot before closing
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

  _startResize(itemId, e) {
    e.preventDefault();
    const item = this._items.find((i) => i.id === itemId);
    if (!item || !item.open) return;

    const col = this._columnsEl.querySelector(`[data-item-id="${itemId}"]`);
    if (!col) return;

    const startX = e.clientX;
    const startWidth = item.width || DEFAULT_COLUMN_WIDTH;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const newWidth = Math.max(MIN_COLUMN_WIDTH, startWidth + dx);
      item.width = newWidth;
      col.style.width = (SPINE_WIDTH + newWidth) + "px";
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      this._updateVisibility();
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  _startReorder(itemId, e) {
    e.preventDefault();
    const idx = this._items.findIndex((i) => i.id === itemId);
    if (idx < 0) return;

    const col = this._columnsEl.querySelector(`[data-item-id="${itemId}"]`);
    if (!col) return;

    col.classList.add("stack-column-dragging");
    const startX = e.clientX;
    const colRect = col.getBoundingClientRect();
    let insertIdx = idx;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      col.style.transform = `translateX(${dx}px)`;
      col.style.zIndex = "100";

      // Determine insertion point
      const cols = Array.from(this._columnsEl.children);
      for (let i = 0; i < cols.length; i++) {
        if (cols[i] === col) continue;
        const rect = cols[i].getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        if (ev.clientX < mid) {
          insertIdx = i;
          return;
        }
        insertIdx = i + 1;
      }
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      col.classList.remove("stack-column-dragging");
      col.style.transform = "";
      col.style.zIndex = "";

      if (insertIdx !== idx) {
        const [moved] = this._items.splice(idx, 1);
        const targetIdx = insertIdx > idx ? insertIdx - 1 : insertIdx;
        this._items.splice(targetIdx, 0, moved);
        // Move DOM node instead of re-rendering (preserves live editors/canvases)
        const refNode = this._columnsEl.children[targetIdx] || null;
        this._columnsEl.insertBefore(col, refNode);
      }
    };

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
    const viewLeft = scrollLeft;
    const viewRight = scrollLeft + viewWidth;

    let accX = 0;
    for (const item of this._items) {
      const colWidth = item.open
        ? SPINE_WIDTH + (item.width || DEFAULT_COLUMN_WIDTH)
        : SPINE_WIDTH;
      const colLeft = accX;
      const colRight = accX + colWidth;
      accX = colRight;

      if (!item.open) continue;

      const col = this._columnsEl.querySelector(`[data-item-id="${item.id}"]`);
      if (!col) continue;
      const contentEl = col.querySelector(".stack-column-content");
      if (!contentEl) continue;

      // Buffer: mount one extra column on each side
      const bufferPx = (DEFAULT_COLUMN_WIDTH + SPINE_WIDTH) * BUFFER_COLUMNS;
      const isVisible = colRight >= (viewLeft - bufferPx) && colLeft <= (viewRight + bufferPx);

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
      id: crypto.randomUUID(),
      fileId,
      fileType,
      name,
      width: DEFAULT_COLUMN_WIDTH,
      open: true,
      scrollY: 0,
      cameraState: null,
      spineColor: null,
    };
    this._items.push(item);
    this._updateEmptyState();
    const col = this._createColumn(item);
    this._columnsEl.appendChild(col);
    this._updateVisibility();

    // Scroll to the new column
    requestAnimationFrame(() => {
      this._scrollArea.scrollLeft = this._scrollArea.scrollWidth;
    });
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
    // Capture scroll positions from live columns before serializing
    for (const [itemId, liveData] of this._liveColumns) {
      const item = this._items.find((i) => i.id === itemId);
      if (item && liveData.getScrollState) {
        const scrollState = liveData.getScrollState();
        item.scrollY = scrollState.scrollY ?? item.scrollY;
        item.cameraState = scrollState.cameraState ?? item.cameraState;
      }
    }
    return {
      items: this._items,
      scrollX: this._scrollX,
    };
  }

  async _openAddPicker() {
    const { openStackFilePicker } = await import("./stack-picker.js");
    openStackFilePicker(this._state, (fileId, fileType, name) => {
      this.addItem(fileId, fileType, name);
    });
  }

  /** Accept a file drop from the sidebar. */
  handleFileDrop(fileId, fileType, name) {
    this.addItem(fileId, fileType, name);
  }

  destroy() {
    this._destroyed = true;
    if (this._visRaf) cancelAnimationFrame(this._visRaf);
    // Unmount all live columns
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
