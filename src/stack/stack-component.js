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
const maxItemWidth = () => Math.max(MIN_COLUMN_WIDTH, window.innerWidth - 100);

export class StackComponent {
  constructor(container, data, state) {
    this._container = container;
    this._state = state;
    this._items = data.items || [];
    this._scrollX = data.scrollX || 0;
    this._liveColumns = new Map();
    this._destroyed = false;
    this._activeItemId = null;

    this._buildDOM();
    this._render();
    // Defer scroll restoration so the browser has reflowed column widths
    requestAnimationFrame(() => {
      this._scrollArea.scrollLeft = this._scrollX;
    });
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

    // Bottom-right button group: list view + add
    const btnGroup = document.createElement("div");
    btnGroup.className = "stack-btn-group";

    this._listBtn = document.createElement("button");
    this._listBtn.className = "stack-floating-btn stack-list-btn";
    this._listBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="7" x2="19" y2="7"/><line x1="5" y1="12" x2="19" y2="12"/><line x1="5" y1="17" x2="19" y2="17"/></svg>`;
    this._listBtn.addEventListener("click", async () => {
      if (!this._listView) {
        const { createStackListView } = await import("./stack-list-view.js");
        this._listView = createStackListView(this, this._state);
      }
      this._listView.toggle();
    });
    btnGroup.appendChild(this._listBtn);

    this._addBtn = document.createElement("button");
    this._addBtn.className = "stack-floating-btn stack-add-btn";
    this._addBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    this._addBtn.addEventListener("click", () => this._openAddPicker());
    btnGroup.appendChild(this._addBtn);

    this._el.appendChild(btnGroup);

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
      onToggleAll: () => this._closeAll(),
      onOpenAll: () => this._openAll(),
      onClose: () => this.removeItem(item.id),
      onColorChange: (color) => this._setSpineColor(item.id, color),
      onDragStart: (e) => this._startReorder(item.id, e),
      onResizeStart: (e) => this._startResizeLeft(item.id, e),
      onPopOut: (it) => this._popOutAsPane(it),
      onDuplicate: (it) => this._duplicateItem(it),
    });
    col.appendChild(spine);

    const content = document.createElement("div");
    content.className = "stack-column-content";
    content.style.display = item.open ? "block" : "none";
    col.appendChild(content);

    // Click anywhere in the column to make it "active"
    col.addEventListener("pointerdown", () => this._setActiveItem(item.id), true);

    // Auto-widen/narrow when shelf/sidebar panels open/close.
    // Only watch direct children of content (not deep subtree) to avoid
    // infinite loops with PDF re-renders.
    let trackedShelfW = 0;
    let shelfDebounce = null;
    const userBaseW = item.width || DEFAULT_COLUMN_WIDTH;
    function syncShelfWidth() {
      if (!item.open) return;
      let total = 0;
      for (const p of content.children) {
        const cl = p.className || "";
        if (cl.includes("notebook-shelf") || cl.includes("pdf-annotation-shelf") || cl.includes("longview")) {
          if (p.offsetWidth > 0) total += p.offsetWidth;
        }
      }
      if (total !== trackedShelfW) {
        trackedShelfW = total;
        item.width = userBaseW + total;
        col.style.width = (SPINE_WIDTH + item.width) + "px";
      }
    }
    const mo = new MutationObserver(() => {
      clearTimeout(shelfDebounce);
      shelfDebounce = setTimeout(syncShelfWidth, 100);
    });
    mo.observe(content, { childList: true });
    col._shelfObs = mo;

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

  _closeAll() {
    for (const it of this._items) { if (it.open) this._toggleItem(it.id); }
  }

  _openAll() {
    for (const it of this._items) { if (!it.open) this._toggleItem(it.id); }
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
      const newWidth = Math.min(maxItemWidth(), Math.max(MIN_COLUMN_WIDTH, startWidth + dx));
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
    const dragCol = this._columnsEl.querySelector(`[data-item-id="${itemId}"]`);
    if (!dragCol) return;

    // Save open/closed states
    const savedStates = this._items.map((it) => ({ id: it.id, open: it.open }));

    // Compute scroll offset so collapsed spines center around the dragged one
    const dragRect = dragCol.getBoundingClientRect();
    const scrollRect = this._scrollArea.getBoundingClientRect();
    const dragCenterInScroll = dragRect.left - scrollRect.left + this._scrollArea.scrollLeft + dragRect.width / 2;

    this._columnsEl.classList.add("stack-reordering");

    // Collapse all columns; hide the dragged one completely
    for (const it of this._items) {
      const col = this._columnsEl.querySelector(`[data-item-id="${it.id}"]`);
      if (!col) continue;
      if (it.id === itemId) {
        col.style.display = "none";
      } else {
        col.classList.add("stack-column-closed");
        col.style.width = SPINE_WIDTH + "px";
        const contentEl = col.querySelector(".stack-column-content");
        if (contentEl) contentEl.style.display = "none";
      }
    }

    // Insert a spacer before the first column so the collapsed group
    // centers around where the dragged spine was on screen.
    const spacer = document.createElement("div");
    spacer.className = "stack-reorder-spacer";
    const viewportCenter = dragRect.left - scrollRect.left + dragRect.width / 2;
    // The dragged item was at position `idx` among items (0-indexed).
    // After removing it, the items to its left occupy idx positions.
    const leftSpinesWidth = idx * SPINE_WIDTH;
    const spacerWidth = Math.max(0, viewportCenter - leftSpinesWidth - SPINE_WIDTH / 2);
    spacer.style.width = spacerWidth + "px";
    spacer.style.flexShrink = "0";
    this._columnsEl.insertBefore(spacer, this._columnsEl.firstChild);
    this._scrollArea.scrollLeft = 0;

    // Create ghost spine
    const ghost = document.createElement("div");
    ghost.className = "stack-reorder-ghost";
    const spineEl = dragCol.querySelector(".stack-spine");
    if (spineEl) ghost.innerHTML = spineEl.innerHTML;
    ghost.style.height = this._scrollArea.clientHeight + "px";
    document.body.appendChild(ghost);
    ghost.style.left = (e.clientX - SPINE_WIDTH / 2) + "px";
    ghost.style.top = scrollRect.top + "px";

    let insertIdx = idx;

    const onMove = (ev) => {
      ghost.style.left = (ev.clientX - SPINE_WIDTH / 2) + "px";

      const allCols = Array.from(this._columnsEl.querySelectorAll(".stack-column"));
      const otherCols = allCols.filter((c) => c !== dragCol);
      let newIdx = otherCols.length;
      for (let i = 0; i < otherCols.length; i++) {
        const rect = otherCols[i].getBoundingClientRect();
        if (ev.clientX < rect.left + rect.width / 2) { newIdx = i; break; }
      }
      if (newIdx !== insertIdx) {
        insertIdx = newIdx;
        this._columnsEl.querySelectorAll(".stack-drop-indicator").forEach((el) => el.remove());
        const indicator = document.createElement("div");
        indicator.className = "stack-drop-indicator";
        const refCol = otherCols[insertIdx] || this._trailResize;
        this._columnsEl.insertBefore(indicator, refCol);
      }
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      ghost.remove();
      spacer.remove();
      this._columnsEl.querySelectorAll(".stack-drop-indicator").forEach((el) => el.remove());

      this._columnsEl.classList.remove("stack-reordering");
      dragCol.style.display = "";
      dragCol.style.minWidth = SPINE_WIDTH + "px";

      // Reorder: insertIdx is relative to items EXCLUDING the dragged one
      const currentIdx = this._items.findIndex((i) => i.id === itemId);
      this._items.splice(currentIdx, 1);
      this._items.splice(insertIdx, 0, item);
      const otherCols = Array.from(this._columnsEl.querySelectorAll(".stack-column")).filter((c) => c !== dragCol);
      const refNode = otherCols[insertIdx] || this._trailResize;
      this._columnsEl.insertBefore(dragCol, refNode);

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

  // --- Active item ---

  _setActiveItem(id) {
    if (this._activeItemId === id) return;
    // Remove old active border
    if (this._activeItemId) {
      const old = this._columnsEl.querySelector(`[data-item-id="${this._activeItemId}"]`);
      if (old) old.classList.remove("stack-column-active");
    }
    this._activeItemId = id;
    const col = this._columnsEl.querySelector(`[data-item-id="${id}"]`);
    if (col) col.classList.add("stack-column-active");
  }

  getActiveItem() {
    if (!this._activeItemId) return null;
    return this._items.find((i) => i.id === this._activeItemId) || null;
  }

  // --- Public API ---

  insertItemNear(fileId, fileType, name, screenX) {
    if (fileType === "stack" || fileType === "folder") return null;
    const item = {
      id: crypto.randomUUID(), fileId, fileType, name,
      width: DEFAULT_COLUMN_WIDTH, open: true,
      scrollY: 0, cameraState: null, pdfZoom: null, spineColor: null,
    };
    // Find the column division closest to screenX
    const colEls = Array.from(this._columnsEl.querySelectorAll(".stack-column"));
    let insertIdx = this._items.length;
    for (let i = 0; i < colEls.length; i++) {
      const rect = colEls[i].getBoundingClientRect();
      const colCenter = rect.left + rect.width / 2;
      if (screenX < colCenter) { insertIdx = i; break; }
    }
    this._items.splice(insertIdx, 0, item);
    this._updateEmptyState();
    const col = this._createColumn(item);
    const refNode = colEls[insertIdx] || this._trailResize;
    this._columnsEl.insertBefore(col, refNode);
    this._updateVisibility();
    requestAnimationFrame(() => {
      col.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      col.classList.add("stack-column-highlight");
      setTimeout(() => col.classList.remove("stack-column-highlight"), 1200);
    });
    return item;
  }

  addItem(fileId, fileType, name) {
    if (fileType === "stack") return null;
    if (fileType === "folder") return null;
    const item = {
      id: crypto.randomUUID(), fileId, fileType, name,
      width: DEFAULT_COLUMN_WIDTH, open: true,
      scrollY: 0, cameraState: null, pdfZoom: null, spineColor: null,
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
        if (s.scrollY != null) item.scrollY = s.scrollY;
        if (s.cameraState != null) item.cameraState = s.cameraState;
        if (s.pdfZoom != null) item.pdfZoom = s.pdfZoom;
      }
    }
    return { items: this._items, scrollX: this._scrollX };
  }

  async _popOutAsPane(item) {
    const { createPane } = await import("../pane/pane-manager.js");
    const x = window.innerWidth / 2;
    const y = window.innerHeight / 2;
    await createPane(item.fileId, item.name || "Untitled", item.fileType, x, y);
    this.removeItem(item.id);
  }

  _duplicateItem(item) {
    const idx = this._items.findIndex((i) => i.id === item.id);
    if (idx < 0) return;
    const newItem = {
      id: crypto.randomUUID(),
      fileId: item.fileId,
      fileType: item.fileType,
      name: item.name,
      width: item.width || DEFAULT_COLUMN_WIDTH,
      open: true,
      scrollY: 0,
      cameraState: null,
      pdfZoom: null,
      spineColor: item.spineColor,
    };
    this._items.splice(idx + 1, 0, newItem);
    this._updateEmptyState();
    const col = this._createColumn(newItem);
    const existingCol = this._columnsEl.querySelector(`[data-item-id="${item.id}"]`);
    const refNode = existingCol?.nextElementSibling || this._trailResize;
    this._columnsEl.insertBefore(col, refNode);
    this._updateVisibility();
    requestAnimationFrame(() => {
      col.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      col.classList.add("stack-column-highlight");
      setTimeout(() => col.classList.remove("stack-column-highlight"), 1200);
    });
  }

  async _openAddPicker() {
    const { openStackFilePicker } = await import("./stack-picker.js");
    openStackFilePicker(this._state, (fileId, fileType, name) => {
      this.addItem(fileId, fileType, name);
    });
  }

  handleFileDrop(fileId, fileType, name) {
    const newItem = this.addItem(fileId, fileType, name);
    // Scroll to the new item and briefly highlight its spine
    requestAnimationFrame(() => {
      this._scrollArea.scrollLeft = this._scrollArea.scrollWidth;
      const col = this._columnsEl.querySelector(`[data-item-id="${newItem.id}"]`);
      if (col) {
        col.classList.add("stack-column-highlight");
        setTimeout(() => col.classList.remove("stack-column-highlight"), 1200);
      }
    });
  }

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
