/**
 * Sortable list drag & drop — pointer event handlers, ghost element, drop targets
 */

import { parsePath, pathsEqual, isAncestorPath, getChildrenAtPath } from "./utils.js";

export function initDragHandlers(instance) {
  instance._onPointerDown = onPointerDown.bind(instance);
  instance._onPointerMove = onPointerMove.bind(instance);
  instance._onPointerUp = onPointerUp.bind(instance);
}

function onPointerDown(event) {
  if (event.target.classList.contains("sl-fold-arrow")) return;

  const target = event.target.closest(".sl-item");
  if (!target || target.classList.contains("dragging")) return;

  const rect = target.getBoundingClientRect();
  const offsetX = event.clientX - rect.left;
  const offsetY = event.clientY - rect.top;
  const targetId = target.dataset.id ?? "";
  const targetPath = parsePath(target.dataset.path);
  const wasMoving = this.state.isMoving;

  this.pendingDrag = {
    target, targetId, targetPath, event, offsetX, offsetY, wasMoving,
    pointerId: event.pointerId,
  };

  const handlePointerUp = (upEvent) => {
    if (upEvent.pointerId !== event.pointerId) return;
    if (this.pendingDrag && this.pendingDrag.timeoutId) {
      clearTimeout(this.pendingDrag.timeoutId);
    }
    if (this.pendingDrag && !this.dragSession) {
      const item = this._getItemAtPath(targetPath);
      if (item) this.config.onClick(item);
    }
    this.pendingDrag = null;
    window.removeEventListener("pointerup", handlePointerUp);
  };

  window.addEventListener("pointerup", handlePointerUp, { once: true });

  const timeoutId = setTimeout(() => {
    if (!this.pendingDrag) return;
    event.preventDefault();

    const stateChanged = this._abandonKeyboardMode({ revertMove: wasMoving });
    let dragTarget = target;
    if (stateChanged) {
      const escapedId = this._escapeForAttribute(targetId);
      dragTarget = this.container.querySelector(`[data-id="${escapedId}"]`);
      if (!dragTarget) { this.pendingDrag = null; return; }
    }

    startDrag.call(this, dragTarget, event, { offsetX, offsetY });
    this.pendingDrag = null;
  }, this.config.dragStartDelay);

  this.pendingDrag.timeoutId = timeoutId;
}

function startDrag(target, event, options = {}) {
  const originPath = parsePath(target.dataset.path);
  const originParentPath = originPath.slice(0, -1);
  const originIndex = originPath[originPath.length - 1] ?? 0;
  const rect = target.getBoundingClientRect();
  const offsetX = options.offsetX ?? event.clientX - rect.left;
  const offsetY = options.offsetY ?? event.clientY - rect.top;

  const ghost = document.createElement("div");
  ghost.className = "sl-drag-ghost";
  const label = target.querySelector(".sl-item-label");
  ghost.textContent = label?.textContent || target.textContent;
  ghost.style.width = `${rect.width}px`;
  const textHeight =
    parseFloat(getComputedStyle(target).fontSize) * this.config.lineHeightMultiplier +
    parseFloat(getComputedStyle(target).paddingTop) * 2;
  ghost.style.height = `${textHeight}px`;
  ghost.style.transform = `translate3d(${event.clientX - offsetX}px, ${event.clientY - offsetY}px, 0)`;
  document.body.appendChild(ghost);

  const draggedItem = this._getItemAtPath(originPath);

  this.dragSession = {
    pointerId: event.pointerId,
    originElement: target, originPath, originParentPath, originIndex,
    offsetX, offsetY, ghost, dropTarget: null, draggedItem,
    lastDropUpdateX: event.clientX, lastDropUpdateY: event.clientY,
    autoExpandedIds: new Set(), highlightedParent: null,
  };

  target.classList.add("dragging");
  target.setPointerCapture(event.pointerId);
  window.addEventListener("pointermove", this._onPointerMove);
  window.addEventListener("pointerup", this._onPointerUp, { once: true });
  this.config.onDragStart(this._getItemAtPath(originPath));
}

function onPointerMove(event) {
  if (!this.dragSession) return;
  event.preventDefault();
  const { offsetX, offsetY, ghost } = this.dragSession;
  ghost.style.transform = `translate3d(${event.clientX - offsetX}px, ${event.clientY - offsetY}px, 0)`;
  updateDropTarget.call(this, event.clientX, event.clientY);
}

function onPointerUp(event) {
  if (!this.dragSession) return;
  if (event.pointerId !== this.dragSession.pointerId) return;
  this.dragSession.originElement.releasePointerCapture(event.pointerId);
  finishDrag.call(this);
}

function updateDropTarget(clientX, clientY) {
  if (!this.dragSession) return;

  const dx = clientX - this.dragSession.lastDropUpdateX;
  const dy = clientY - this.dragSession.lastDropUpdateY;
  if (this.dragSession.dropTarget && Math.sqrt(dx * dx + dy * dy) < this.config.hysteresisThreshold) {
    return;
  }

  const stack = document.elementsFromPoint(clientX, clientY);
  const hoveredItem = stack.find(
    (n) => n instanceof HTMLElement && n.classList.contains("sl-item") && !n.classList.contains("dragging")
  );

  if (hoveredItem) {
    const itemPath = parsePath(hoveredItem.dataset.path ?? "");
    const rect = hoveredItem.getBoundingClientRect();
    const offsetY = clientY - rect.top;
    const cs = getComputedStyle(hoveredItem);
    const textHeight =
      parseFloat(cs.fontSize) * this.config.lineHeightMultiplier +
      parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const boundary = Math.max(this.config.dropZoneBoundaryMin, textHeight * this.config.dropZoneBoundaryFraction);

    let zone = "before";
    if (offsetY > textHeight - boundary) zone = "after";
    else if (offsetY >= boundary) zone = "inside";

    if (zone === "inside") {
      if (hoveredItem.dataset.canNest !== "true") { clearDropTarget.call(this); return; }
      if (isAncestorPath(this.dragSession.originPath, itemPath)) { clearDropTarget.call(this); return; }

      // Check canDrop: is this dragged item allowed inside this target?
      const targetItem = this._getItemAtPath(itemPath);
      if (targetItem && this.dragSession.draggedItem && !this.config.canDrop(this.dragSession.draggedItem, targetItem)) {
        clearDropTarget.call(this); return;
      }

      const item = this._getItemAtPath(itemPath);
      if (item) {
        const itemId = this.config.getId(item);
        if (this.state.collapsedIds.has(itemId)) {
          this.state.collapsedIds.delete(itemId);
          this.dragSession.autoExpandedIds.add(itemId);
          this.render();
        }
      }

      const childList = ensureChildList(hoveredItem, itemPath);
      setDropTarget.call(this, childList, itemPath, clientY);
      this.dragSession.lastDropUpdateX = clientX;
      this.dragSession.lastDropUpdateY = clientY;
      return;
    }

    const parentList = hoveredItem.parentElement;
    if (parentList instanceof HTMLElement && parentList.classList.contains("sl-list")) {
      const parentPath = parsePath(parentList.dataset.path ?? "");
      if (isAncestorPath(this.dragSession.originPath, parentPath)) {
        clearDropTarget.call(this); return;
      }

      const siblings = Array.from(parentList.children).filter(
        (c) => c instanceof HTMLElement && c.classList.contains("sl-item") && !c.classList.contains("dragging")
      );
      const currentIndex = siblings.indexOf(hoveredItem);
      let insertionIndex = zone === "before" ? currentIndex : currentIndex + 1;
      insertionIndex = Math.max(0, Math.min(insertionIndex, siblings.length));

      this.dragSession.dropTarget = { parentPath, index: insertionIndex };
      const referenceNode = siblings[insertionIndex] ?? null;
      if (this.dropIndicator.parentElement !== parentList || this.dropIndicator.nextSibling !== referenceNode) {
        this.dropIndicator.remove();
        parentList.insertBefore(this.dropIndicator, referenceNode);
      }
      this.dropIndicator.classList.add("active");
      updateParentHighlight.call(this, parentPath);
      this.dragSession.lastDropUpdateX = clientX;
      this.dragSession.lastDropUpdateY = clientY;
      return;
    }
  }

  const containerEl = stack.find(
    (n) => n instanceof HTMLElement && n.classList.contains("sl-list")
  ) ?? this.container;
  if (!(containerEl instanceof HTMLElement)) { clearDropTarget.call(this); return; }
  const parentPath = parsePath(containerEl.dataset.path ?? "");
  setDropTarget.call(this, containerEl, parentPath, clientY);
  this.dragSession.lastDropUpdateX = clientX;
  this.dragSession.lastDropUpdateY = clientY;
}

function clearDropTarget() {
  if (!this.dragSession) return;
  if (this.dragSession.highlightedParent) {
    this.dragSession.highlightedParent.classList.remove("sl-drop-target-list");
    this.dragSession.highlightedParent = null;
  }
  const container = this.dropIndicator.parentElement;
  this.dragSession.dropTarget = null;
  this.dropIndicator.classList.remove("active");
  if (container) {
    container.removeChild(this.dropIndicator);
    if (container.dataset.temp === "true" && container.children.length === 0) container.remove();
  } else {
    this.dropIndicator.remove();
  }
}

function setDropTarget(container, parentPath, clientY) {
  if (!this.dragSession) return;
  if (isAncestorPath(this.dragSession.originPath, parentPath)) { clearDropTarget.call(this); return; }

  const siblings = Array.from(container.children).filter(
    (c) => c instanceof HTMLElement && c.classList.contains("sl-item") && !c.classList.contains("dragging")
  );

  let insertionIndex = siblings.length;
  for (let i = 0; i < siblings.length; i++) {
    const rect = siblings[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) { insertionIndex = i; break; }
  }
  const bounded = Math.max(0, Math.min(insertionIndex, siblings.length));

  this.dragSession.dropTarget = { parentPath, index: bounded };
  const referenceNode = siblings[bounded] ?? null;
  if (this.dropIndicator.parentElement !== container || this.dropIndicator.nextSibling !== referenceNode) {
    this.dropIndicator.remove();
    container.insertBefore(this.dropIndicator, referenceNode);
  }
  this.dropIndicator.classList.add("active");
  updateParentHighlight.call(this, parentPath);
}

function updateParentHighlight(parentPath) {
  if (!this.dragSession) return;
  if (this.dragSession.highlightedParent) {
    this.dragSession.highlightedParent.classList.remove("sl-drop-target-list");
    this.dragSession.highlightedParent = null;
  }
  if (parentPath.length > 0) {
    const parentEl = this.container.querySelector(`[data-path="${parentPath.join("/")}"]`);
    if (parentEl) {
      const childList = parentEl.querySelector(":scope > .sl-list");
      if (childList) {
        childList.classList.add("sl-drop-target-list");
        this.dragSession.highlightedParent = childList;
      }
    }
  }
}

function ensureChildList(item, itemPath) {
  let list = Array.from(item.children).find(
    (c) => c instanceof HTMLElement && c.classList.contains("sl-list")
  );
  if (!list) {
    list = document.createElement("ul");
    list.className = "sl-list";
    list.dataset.path = itemPath.join("/");
    list.dataset.temp = "true";
    item.appendChild(list);
  }
  return list;
}

function finishDrag() {
  if (!this.dragSession) return;
  window.removeEventListener("pointermove", this._onPointerMove);

  const { originElement, ghost, dropTarget, originPath, originParentPath, originIndex, autoExpandedIds, highlightedParent } = this.dragSession;

  clearDropTarget.call(this);
  if (highlightedParent) highlightedParent.classList.remove("sl-drop-target-list");
  ghost.remove();
  originElement.classList.remove("dragging");

  if (!dropTarget) {
    autoExpandedIds.forEach((id) => this.state.collapsedIds.add(id));
    this.dragSession = null;
    this.render();
    this.config.onDragEnd(null, false);
    return;
  }

  if (pathsEqual(originParentPath, dropTarget.parentPath) && originIndex === dropTarget.index) {
    autoExpandedIds.forEach((id) => this.state.collapsedIds.add(id));
    this.dragSession = null;
    this.render();
    this.config.onDragEnd(null, false);
    return;
  }

  const { getChildren, setChildren } = this.config;
  const sourceParent = getChildrenAtPath(this.state.items, originParentPath, getChildren, setChildren);
  const destination = getChildrenAtPath(this.state.items, dropTarget.parentPath, getChildren, setChildren);
  const [moved] = sourceParent.splice(originIndex, 1);

  let adjustedIndex = dropTarget.index;
  if (pathsEqual(originParentPath, dropTarget.parentPath) && originIndex < dropTarget.index) {
    adjustedIndex -= 1;
  }
  const bounded = Math.max(0, Math.min(adjustedIndex, destination.length));
  destination.splice(bounded, 0, moved);

  this.dragSession = null;
  this.render();
  this.config.onChange(this.getData());
  this.config.onDragEnd(moved, true);
}
