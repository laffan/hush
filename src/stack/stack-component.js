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

import { createSpine, resolveItemName } from "./stack-spine.js";
import { mountItemContent, unmountItemContent, snapshotItemContent } from "./stack-item-mount.js";
import { typeIcons } from "../sidebar/files-panel-shared.js";

const SPINE_WIDTH = 50;
const SPINE_HEIGHT = 40;
const DEFAULT_COLUMN_WIDTH = 800;
const DEFAULT_COLUMN_HEIGHT = 600;
const BUFFER_COLUMNS = 1;
const MIN_COLUMN_WIDTH = 200;
const MIN_COLUMN_HEIGHT = 150;
const maxItemWidth = () => Math.max(MIN_COLUMN_WIDTH, window.innerWidth - 100);
const maxItemHeight = () => Math.max(MIN_COLUMN_HEIGHT, window.innerHeight - 100);

let _measureCtx = null;
const PILL_FONT = "600 11px system-ui, -apple-system, sans-serif";
const PILL_FONT_SIZE = 11;
const PILL_GAP = 10;

function _trimPillText(text, maxDim, vertical) {
  if (maxDim <= 0) return "";
  if (!_measureCtx) {
    _measureCtx = document.createElement("canvas").getContext("2d");
  }
  _measureCtx.font = PILL_FONT;

  if (vertical) {
    const charH = PILL_FONT_SIZE * 1.25;
    const fullH = text.length * charH;
    if (fullH <= maxDim) return text;
    const avail = maxDim - charH;
    if (avail <= 0) return "…";
    const maxChars = Math.floor(avail / charH);
    return maxChars > 0 ? text.slice(0, maxChars) + "…" : "…";
  }

  if (_measureCtx.measureText(text).width <= maxDim) return text;
  const ellW = _measureCtx.measureText("…").width;
  const avail = maxDim - ellW;
  if (avail <= 0) return "…";
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (_measureCtx.measureText(text.slice(0, mid)).width <= avail) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + "…" : "…";
}

export class StackComponent {
  constructor(container, data, state) {
    this._container = container;
    this._state = state;
    this._items = data.items || [];
    this._scrollX = data.scrollX || 0;
    this._scrollY = data.scrollY || 0;
    this._scrollDirection = data.scrollDirection || "horizontal";
    this._liveColumns = new Map();
    this._destroyed = false;
    this._activeItemId = null;

    this._state.stackScrollDirection = this._scrollDirection;

    this._buildDOM();
    this._render();
    requestAnimationFrame(() => {
      if (this._isVertical) {
        this._scrollArea.scrollTop = this._scrollY;
      } else {
        this._scrollArea.scrollLeft = this._scrollX;
      }
    });
    this._startVirtualization();
  }

  get _isVertical() { return this._scrollDirection === "vertical"; }

  _buildDOM() {
    this._el = document.createElement("div");
    this._el.className = "stack-root";
    if (this._isVertical) this._el.classList.add("stack-vertical");

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
      if (this._isVertical) {
        this._scrollY = this._scrollArea.scrollTop;
      } else {
        this._scrollX = this._scrollArea.scrollLeft;
      }
      this._updateVisibility();
    });

    this._pillContainer = document.createElement("div");
    this._pillContainer.className = "stack-scrollbar-pills";
    this._el.appendChild(this._pillContainer);

    this._pillResizeObs = new ResizeObserver(() => this._updateScrollbarPills());
    this._pillResizeObs.observe(this._scrollArea);

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

    if (this._isVertical) {
      const height = item.open ? (item.height || DEFAULT_COLUMN_HEIGHT) : 0;
      col.style.height = (SPINE_HEIGHT + height) + "px";
      col.style.minHeight = SPINE_HEIGHT + "px";
    } else {
      const width = item.open ? (item.width || DEFAULT_COLUMN_WIDTH) : 0;
      col.style.width = (SPINE_WIDTH + width) + "px";
      col.style.minWidth = SPINE_WIDTH + "px";
    }
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
    const self = this;
    function syncShelfWidth() {
      if (!item.open || self._isVertical) return;
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
      if (this._isVertical) {
        col.style.height = (SPINE_HEIGHT + (item.height || DEFAULT_COLUMN_HEIGHT)) + "px";
      } else {
        col.style.width = (SPINE_WIDTH + (item.width || DEFAULT_COLUMN_WIDTH)) + "px";
      }
      const contentEl = col.querySelector(".stack-column-content");
      if (contentEl) contentEl.style.display = "block";
    } else {
      if (this._liveColumns.has(itemId)) {
        snapshotItemContent(col.querySelector(".stack-column-content"), item, this._liveColumns);
        unmountItemContent(col.querySelector(".stack-column-content"), item, this._liveColumns);
        this._liveColumns.delete(itemId);
      }
      col.classList.add("stack-column-closed");
      if (this._isVertical) {
        col.style.height = SPINE_HEIGHT + "px";
      } else {
        col.style.width = SPINE_WIDTH + "px";
      }
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
    this._updateScrollbarPills();
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

    document.body.classList.add("stack-resizing");

    if (this._isVertical) {
      const startY = e.clientY;
      const startHeight = item.height || DEFAULT_COLUMN_HEIGHT;
      const onMove = (ev) => {
        const dy = ev.clientY - startY;
        const newHeight = Math.min(maxItemHeight(), Math.max(MIN_COLUMN_HEIGHT, startHeight + dy));
        item.height = newHeight;
        col.style.height = (SPINE_HEIGHT + newHeight) + "px";
        this._updateScrollbarPills();
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.body.classList.remove("stack-resizing");
        this._updateVisibility();
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    } else {
      const startX = e.clientX;
      const startWidth = item.width || DEFAULT_COLUMN_WIDTH;
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const newWidth = Math.min(maxItemWidth(), Math.max(MIN_COLUMN_WIDTH, startWidth + dx));
        item.width = newWidth;
        col.style.width = (SPINE_WIDTH + newWidth) + "px";
        this._updateScrollbarPills();
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
  }

  // --- Reorder: collapse-all, ghost spine, drop-zone ---

  _startReorder(itemId, e) {
    e.preventDefault();
    const idx = this._items.findIndex((i) => i.id === itemId);
    if (idx < 0) return;
    const item = this._items[idx];
    const dragCol = this._columnsEl.querySelector(`[data-item-id="${itemId}"]`);
    if (!dragCol) return;

    const savedStates = this._items.map((it) => ({ id: it.id, open: it.open }));
    const dragRect = dragCol.getBoundingClientRect();
    const scrollRect = this._scrollArea.getBoundingClientRect();
    const isVert = this._isVertical;

    this._columnsEl.classList.add("stack-reordering");

    for (const it of this._items) {
      const col = this._columnsEl.querySelector(`[data-item-id="${it.id}"]`);
      if (!col) continue;
      if (it.id === itemId) {
        col.style.display = "none";
      } else {
        col.classList.add("stack-column-closed");
        if (isVert) {
          col.style.height = SPINE_HEIGHT + "px";
        } else {
          col.style.width = SPINE_WIDTH + "px";
        }
        const contentEl = col.querySelector(".stack-column-content");
        if (contentEl) contentEl.style.display = "none";
      }
    }

    const spacer = document.createElement("div");
    spacer.className = "stack-reorder-spacer";
    if (isVert) {
      const viewportCenter = dragRect.top - scrollRect.top + dragRect.height / 2;
      const aboveSpinesHeight = idx * SPINE_HEIGHT;
      const spacerHeight = Math.max(0, viewportCenter - aboveSpinesHeight - SPINE_HEIGHT / 2);
      spacer.style.height = spacerHeight + "px";
    } else {
      const viewportCenter = dragRect.left - scrollRect.left + dragRect.width / 2;
      const leftSpinesWidth = idx * SPINE_WIDTH;
      const spacerWidth = Math.max(0, viewportCenter - leftSpinesWidth - SPINE_WIDTH / 2);
      spacer.style.width = spacerWidth + "px";
    }
    spacer.style.flexShrink = "0";
    this._columnsEl.insertBefore(spacer, this._columnsEl.firstChild);
    if (isVert) { this._scrollArea.scrollTop = 0; } else { this._scrollArea.scrollLeft = 0; }

    const ghost = document.createElement("div");
    ghost.className = "stack-reorder-ghost";
    if (isVert) ghost.classList.add("stack-reorder-ghost-vertical");
    const spineEl = dragCol.querySelector(".stack-spine");
    if (spineEl) ghost.innerHTML = spineEl.innerHTML;
    if (isVert) {
      ghost.style.width = this._scrollArea.clientWidth + "px";
      ghost.style.height = SPINE_HEIGHT + "px";
      ghost.style.left = scrollRect.left + "px";
      ghost.style.top = (e.clientY - SPINE_HEIGHT / 2) + "px";
    } else {
      ghost.style.height = this._scrollArea.clientHeight + "px";
      ghost.style.left = (e.clientX - SPINE_WIDTH / 2) + "px";
      ghost.style.top = scrollRect.top + "px";
    }
    document.body.appendChild(ghost);

    let insertIdx = idx;

    const onMove = (ev) => {
      if (isVert) {
        ghost.style.top = (ev.clientY - SPINE_HEIGHT / 2) + "px";
      } else {
        ghost.style.left = (ev.clientX - SPINE_WIDTH / 2) + "px";
      }

      const allCols = Array.from(this._columnsEl.querySelectorAll(".stack-column"));
      const otherCols = allCols.filter((c) => c !== dragCol);
      let newIdx = otherCols.length;
      for (let i = 0; i < otherCols.length; i++) {
        const rect = otherCols[i].getBoundingClientRect();
        if (isVert) {
          if (ev.clientY < rect.top + rect.height / 2) { newIdx = i; break; }
        } else {
          if (ev.clientX < rect.left + rect.width / 2) { newIdx = i; break; }
        }
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
      if (isVert) {
        dragCol.style.minHeight = SPINE_HEIGHT + "px";
      } else {
        dragCol.style.minWidth = SPINE_WIDTH + "px";
      }

      const currentIdx = this._items.findIndex((i) => i.id === itemId);
      this._items.splice(currentIdx, 1);
      this._items.splice(insertIdx, 0, item);
      const otherCols = Array.from(this._columnsEl.querySelectorAll(".stack-column")).filter((c) => c !== dragCol);
      const refNode = otherCols[insertIdx] || this._trailResize;
      this._columnsEl.insertBefore(dragCol, refNode);

      for (const saved of savedStates) {
        const it = this._items.find((i) => i.id === saved.id);
        if (!it) continue;
        it.open = saved.open;
        const col = this._columnsEl.querySelector(`[data-item-id="${saved.id}"]`);
        if (!col) continue;
        if (it.open) {
          col.classList.remove("stack-column-closed");
          if (isVert) {
            col.style.height = (SPINE_HEIGHT + (it.height || DEFAULT_COLUMN_HEIGHT)) + "px";
          } else {
            col.style.width = (SPINE_WIDTH + (it.width || DEFAULT_COLUMN_WIDTH)) + "px";
          }
          const contentEl = col.querySelector(".stack-column-content");
          if (contentEl) contentEl.style.display = "block";
        } else {
          col.classList.add("stack-column-closed");
          if (isVert) {
            col.style.height = SPINE_HEIGHT + "px";
          } else {
            col.style.width = SPINE_WIDTH + "px";
          }
        }
      }
      this._updateVisibility();
    };
    if (!isVert) ghost.style.top = this._scrollArea.getBoundingClientRect().top + "px";

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

    if (this._isVertical) {
      const scrollTop = this._scrollArea.scrollTop;
      const viewHeight = this._scrollArea.clientHeight;
      const viewBottom = scrollTop + viewHeight;
      let accY = 0;
      for (const item of this._items) {
        const colHeight = item.open ? SPINE_HEIGHT + (item.height || DEFAULT_COLUMN_HEIGHT) : SPINE_HEIGHT;
        const colTop = accY;
        const colBottom = accY + colHeight;
        accY = colBottom;
        if (!item.open) continue;
        const col = this._columnsEl.querySelector(`[data-item-id="${item.id}"]`);
        if (!col) continue;
        const contentEl = col.querySelector(".stack-column-content");
        if (!contentEl) continue;
        const bufferPx = (DEFAULT_COLUMN_HEIGHT + SPINE_HEIGHT) * BUFFER_COLUMNS;
        const isVisible = colBottom >= (scrollTop - bufferPx) && colTop <= (viewBottom + bufferPx);
        if (isVisible && !this._liveColumns.has(item.id)) {
          mountItemContent(contentEl, item, this._state, this._liveColumns);
        } else if (!isVisible && this._liveColumns.has(item.id)) {
          snapshotItemContent(contentEl, item, this._liveColumns);
          unmountItemContent(contentEl, item, this._liveColumns);
        }
      }
    } else {
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
    this._updateScrollbarPills();
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
      width: DEFAULT_COLUMN_WIDTH, height: DEFAULT_COLUMN_HEIGHT, open: true,
      scrollY: 0, cameraState: null, pdfZoom: null, spineColor: null,
    };
    const colEls = Array.from(this._columnsEl.querySelectorAll(".stack-column"));
    let insertIdx = this._items.length;
    for (let i = 0; i < colEls.length; i++) {
      const rect = colEls[i].getBoundingClientRect();
      if (this._isVertical) {
        const colCenter = rect.top + rect.height / 2;
        if (screenX < colCenter) { insertIdx = i; break; }
      } else {
        const colCenter = rect.left + rect.width / 2;
        if (screenX < colCenter) { insertIdx = i; break; }
      }
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
      width: DEFAULT_COLUMN_WIDTH, height: DEFAULT_COLUMN_HEIGHT, open: true,
      scrollY: 0, cameraState: null, pdfZoom: null, spineColor: null,
    };
    this._items.push(item);
    this._updateEmptyState();
    const col = this._createColumn(item);
    this._columnsEl.insertBefore(col, this._trailResize);
    this._updateVisibility();
    requestAnimationFrame(() => {
      if (this._isVertical) {
        this._scrollArea.scrollTop = this._scrollArea.scrollHeight;
      } else {
        this._scrollArea.scrollLeft = this._scrollArea.scrollWidth;
      }
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
    for (const [itemId, liveData] of this._liveColumns) {
      const item = this._items.find((i) => i.id === itemId);
      if (item && liveData.getScrollState) {
        const s = liveData.getScrollState();
        if (s.scrollY != null) item.scrollY = s.scrollY;
        if (s.cameraState != null) item.cameraState = s.cameraState;
        if (s.pdfZoom != null) item.pdfZoom = s.pdfZoom;
      }
    }
    return {
      items: this._items,
      scrollX: this._scrollX,
      scrollY: this._scrollY,
      scrollDirection: this._scrollDirection,
    };
  }

  setScrollDirection(dir) {
    if (dir === this._scrollDirection) return;
    this._scrollDirection = dir;
    this._state.stackScrollDirection = dir;
    const isVertical = dir === "vertical";

    this._el.classList.toggle("stack-vertical", isVertical);

    for (const item of this._items) {
      const col = this._columnsEl.querySelector(`[data-item-id="${item.id}"]`);
      if (!col) continue;

      col.style.width = "";
      col.style.minWidth = "";
      col.style.height = "";
      col.style.minHeight = "";

      if (isVertical) {
        const h = item.open ? (item.height || DEFAULT_COLUMN_HEIGHT) : 0;
        col.style.height = (SPINE_HEIGHT + h) + "px";
        col.style.minHeight = SPINE_HEIGHT + "px";
      } else {
        const w = item.open ? (item.width || DEFAULT_COLUMN_WIDTH) : 0;
        col.style.width = (SPINE_WIDTH + w) + "px";
        col.style.minWidth = SPINE_WIDTH + "px";
      }
    }

    if (isVertical) {
      this._scrollArea.scrollLeft = 0;
      this._scrollArea.scrollTop = this._scrollY || 0;
    } else {
      this._scrollArea.scrollTop = 0;
      this._scrollArea.scrollLeft = this._scrollX || 0;
    }

    this._updateVisibility();
  }

  async _popOutAsPane(item) {
    const { createPane } = await import("../pane/pane-manager.js");
    const x = window.innerWidth / 2;
    const y = window.innerHeight / 2;
    await createPane(item.fileId, resolveItemName(item), item.fileType, x, y);
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
      height: item.height || DEFAULT_COLUMN_HEIGHT,
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
    requestAnimationFrame(() => {
      if (this._isVertical) {
        this._scrollArea.scrollTop = this._scrollArea.scrollHeight;
      } else {
        this._scrollArea.scrollLeft = this._scrollArea.scrollWidth;
      }
      const col = this._columnsEl.querySelector(`[data-item-id="${newItem.id}"]`);
      if (col) {
        col.classList.add("stack-column-highlight");
        setTimeout(() => col.classList.remove("stack-column-highlight"), 1200);
      }
    });
  }

  _updateScrollbarPills() {
    if (this._destroyed) return;
    this._pillContainer.innerHTML = "";

    const isVert = this._isVertical;
    const scrollSize = isVert ? this._scrollArea.scrollHeight : this._scrollArea.scrollWidth;
    const viewSize = isVert ? this._scrollArea.clientHeight : this._scrollArea.clientWidth;

    if (scrollSize <= viewSize || viewSize <= 0) {
      this._pillContainer.style.display = "none";
      return;
    }
    this._pillContainer.style.display = "";

    let acc = 0;
    for (const item of this._items) {
      const spineSize = isVert ? SPINE_HEIGHT : SPINE_WIDTH;
      const contentSize = item.open
        ? (isVert ? (item.height || DEFAULT_COLUMN_HEIGHT) : (item.width || DEFAULT_COLUMN_WIDTH))
        : 0;
      const colSize = spineSize + contentSize;

      if (item.spineColor) {
        const pill = document.createElement("div");
        pill.className = "stack-scrollbar-pill";
        if (isVert) pill.classList.add("stack-scrollbar-pill-vertical");
        pill.style.backgroundColor = item.spineColor;

        const pos = (acc / scrollSize) * viewSize;
        const rawSize = Math.max(20, (colSize / scrollSize) * viewSize);

        if (!item.open) {
          const circleSize = isVert
            ? 30   // pill container is 40px wide, inset 5px each side = 30px
            : 30;  // pill container is 40px tall, inset 5px each side = 30px
          const center = pos + rawSize / 2;
          if (isVert) {
            pill.style.top = (center - circleSize / 2) + "px";
            pill.style.height = circleSize + "px";
            pill.style.left = "5px";
            pill.style.right = "5px";
          } else {
            pill.style.left = (center - circleSize / 2) + "px";
            pill.style.width = circleSize + "px";
          }
          pill.style.borderRadius = "50%";
          pill.style.padding = "0";

          const iconEl = document.createElement("span");
          iconEl.className = "stack-scrollbar-pill-icon";
          iconEl.innerHTML = typeIcons[item.fileType] || typeIcons.document;
          pill.appendChild(iconEl);
        } else {
          const pillSize = Math.max(20, rawSize - PILL_GAP);
          if (isVert) {
            pill.style.top = (pos + PILL_GAP / 2) + "px";
            pill.style.height = pillSize + "px";
          } else {
            pill.style.left = (pos + PILL_GAP / 2) + "px";
            pill.style.width = pillSize + "px";
          }

          const textEl = document.createElement("span");
          textEl.className = "stack-scrollbar-pill-text";
          const title = resolveItemName(item);
          const textPad = isVert ? 8 : 16;
          textEl.textContent = _trimPillText(title, pillSize - textPad, isVert);
          pill.appendChild(textEl);
        }

        const colCenter = acc + colSize / 2;
        pill.addEventListener("click", () => {
          if (isVert) {
            this._scrollArea.scrollTo({ top: colCenter - viewSize / 2, behavior: "smooth" });
          } else {
            this._scrollArea.scrollTo({ left: colCenter - viewSize / 2, behavior: "smooth" });
          }
        });

        this._pillContainer.appendChild(pill);
      }

      acc += colSize;
    }
  }

  destroy() {
    this._destroyed = true;
    if (this._visRaf) cancelAnimationFrame(this._visRaf);
    if (this._pillResizeObs) this._pillResizeObs.disconnect();
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
