/**
 * SortableList — main class, public API, state management
 * Adapted from https://github.com/laffan/ratchet-list-sort
 */

import { deepClone, getItemAtPath, escapeForAttribute, parsePath } from "./utils.js";
import { renderList } from "./rendering.js";
import { initDragHandlers } from "./drag-drop.js";
import { initKeyboardHandlers, abandonKeyboardMode } from "./keyboard-nav.js";

export class SortableList {
  constructor(container, options = {}) {
    this.container = container;

    this.config = {
      data: options.data || [],
      getId: options.getId || ((item) => item.id),
      getChildren: options.getChildren || ((item) => item.children || []),
      setChildren: options.setChildren || ((item, children) => { item.children = children; }),
      renderItem: options.renderItem || ((item) => String(item.label || item.id || "")),
      canNest: options.canNest || (() => true),
      canDrop: options.canDrop || (() => true),
      canDrag: options.canDrag || (() => true),
      hysteresisThreshold: options.hysteresisThreshold ?? 16,
      dropZoneBoundaryMin: options.dropZoneBoundaryMin ?? 12,
      dropZoneBoundaryFraction: options.dropZoneBoundaryFraction ?? 0.25,
      lineHeightMultiplier: options.lineHeightMultiplier ?? 1.5,
      dragStartDelay: options.dragStartDelay ?? 200,
      enableKeyboard: options.enableKeyboard ?? true,
      onChange: options.onChange || (() => {}),
      onDragStart: options.onDragStart || (() => {}),
      // Wrapped so the list can settle deferred setData calls (see
      // setData) before the host reacts to the drag ending.
      onDragEnd: (moved, didDrop) => {
        this._dragSettled(didDrop);
        (options.onDragEnd || (() => {}))(moved, didDrop);
      },
      onDragOutside: options.onDragOutside || null,
      // Called on drop when the release point is over an element outside
      // this list (e.g. a Local Sync folder row). Return true to claim the
      // drop — the list then snaps the source back instead of reordering.
      onDropExternal: options.onDropExternal || null,
      getDraggedSiblings: options.getDraggedSiblings || null,
      onClick: options.onClick || (() => {}),
      // Fired after any collapse/expand toggle with the full collapsed-id
      // array so the host can persist folder open/closed state.
      onCollapseChange: options.onCollapseChange || null,
    };

    this.state = {
      items: deepClone(this.config.data, this.config.getChildren, this.config.setChildren),
      selectedPath: null,
      isMoving: false,
      itemsBeforeMove: null,
      collapsedIds: new Set(),
      hoveredPath: null,
    };

    this.dragSession = null;
    this.pendingDrag = null;

    this.dropIndicator = document.createElement("li");
    this.dropIndicator.className = "sl-drop-indicator";

    // Initialize handlers from sub-modules
    initDragHandlers(this);
    initKeyboardHandlers(this);

    // Bind shared event handlers
    this._onFoldToggle = this._onFoldToggle.bind(this);
    this._onItemMouseEnter = this._onItemMouseEnter.bind(this);
    this._onItemMouseLeave = this._onItemMouseLeave.bind(this);

    this._attachEvents();
    this.render();
  }

  // ===== Public API =====

  setData(data) {
    // A live drag references the current row DOM — rebuilding the list
    // under it kills the drop silently. Cross-window `files-changed`
    // refreshes routinely land mid-drag (sibling windows saving), which
    // is how "drag a PDF onto a project" could visibly do nothing. Park
    // the data instead: a cancelled drag applies it on settle, a
    // completed drop discards it (the drop's own onChange makes the
    // host re-render from the committed tree, which is fresher).
    if (this.dragSession) {
      this._deferredData = data;
      return;
    }
    this._deferredData = null;
    this.state.items = deepClone(data, this.config.getChildren, this.config.setChildren);
    this.render();
  }

  /** Called (via the wrapped onDragEnd) when a drag ends. Applies data
   *  parked by setData during the drag — unless the drag dropped, in
   *  which case onChange already committed and the host's refresh
   *  supplies fresher data than the parked snapshot. */
  _dragSettled(didDrop) {
    if (!this._deferredData) return;
    const data = this._deferredData;
    this._deferredData = null;
    if (!didDrop) this.setData(data);
  }

  getData() {
    return deepClone(this.state.items, this.config.getChildren, this.config.setChildren);
  }

  destroy() {
    if (this.pendingDrag && this.pendingDrag.timeoutId) {
      clearTimeout(this.pendingDrag.timeoutId);
      this.pendingDrag = null;
    }
    this._detachEvents();
    this.container.innerHTML = "";
  }

  render() {
    this.container.innerHTML = "";
    renderList(this.state.items, this.container, [], {
      config: this.config,
      state: this.state,
      onFoldToggle: this._onFoldToggle,
      onItemMouseEnter: this._onItemMouseEnter,
      onItemMouseLeave: this._onItemMouseLeave,
    });
  }

  /** Toggle the collapsed state of an item by id. */
  toggle(itemId) {
    if (this.state.collapsedIds.has(itemId)) {
      this.state.collapsedIds.delete(itemId);
    } else {
      this.state.collapsedIds.add(itemId);
    }
    this.config.onCollapseChange?.([...this.state.collapsedIds]);
    this.render();
  }

  // ===== Internal: used by sub-modules =====

  _getItemAtPath(path) {
    return getItemAtPath(this.state.items, path, this.config.getChildren);
  }

  _escapeForAttribute(value) {
    return escapeForAttribute(value);
  }

  _abandonKeyboardMode(opts) {
    return abandonKeyboardMode(this, opts);
  }

  // ===== Private =====

  _attachEvents() {
    this.container.addEventListener("pointerdown", this._onPointerDown);
    if (this.config.enableKeyboard) {
      window.addEventListener("keydown", this._onKeyDown);
    }
  }

  _detachEvents() {
    this.container.removeEventListener("pointerdown", this._onPointerDown);
    window.removeEventListener("pointermove", this._onPointerMove);
    window.removeEventListener("pointerup", this._onPointerUp);
    if (this.config.enableKeyboard) {
      window.removeEventListener("keydown", this._onKeyDown);
    }
  }

  _onFoldToggle(event) {
    event.stopPropagation();
    event.preventDefault();
    const itemId = event.target.dataset.itemId;
    if (this.state.collapsedIds.has(itemId)) {
      this.state.collapsedIds.delete(itemId);
    } else {
      this.state.collapsedIds.add(itemId);
    }
    this.config.onCollapseChange?.([...this.state.collapsedIds]);
    this.render();
  }

  _onItemMouseEnter(event) {
    const target = event.currentTarget;
    if (target && target.dataset.path) {
      this.state.hoveredPath = parsePath(target.dataset.path);
    }
  }

  _onItemMouseLeave() {
    this.state.hoveredPath = null;
  }
}
