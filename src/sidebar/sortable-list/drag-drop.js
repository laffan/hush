/**
 * Sortable list drag & drop — pointer event handlers, ghost element, drop targets
 */

import { parsePath, pathsEqual, isAncestorPath, getChildrenAtPath, getItemAtPath, removeItemById } from "./utils.js";

export function initDragHandlers(instance) {
  instance._onPointerDown = onPointerDown.bind(instance);
  instance._onPointerMove = onPointerMove.bind(instance);
  instance._onPointerUp = onPointerUp.bind(instance);
}

function onPointerDown(event) {
  if (event.target.classList.contains("sl-fold-arrow")) return;

  const target = event.target.closest(".sl-item");
  if (!target || target.classList.contains("dragging")) return;

  // Check canDrag before starting
  const targetPathForCheck = parsePath(target.dataset.path);
  const itemForCheck = this._getItemAtPath(targetPathForCheck);
  if (itemForCheck && !this.config.canDrag(itemForCheck)) return;

  const rect = target.getBoundingClientRect();
  const offsetX = event.clientX - rect.left;
  const offsetY = event.clientY - rect.top;
  const targetId = target.dataset.id ?? "";
  const targetPath = targetPathForCheck;
  const wasMoving = this.state.isMoving;

  this.pendingDrag = {
    target, targetId, targetPath, event, offsetX, offsetY, wasMoving,
    pointerId: event.pointerId,
  };

  // Suppress text selection immediately on pointerdown so dragging (or the
  // hold-delay before a drag starts) never highlights the file list text.
  document.body.classList.add("sl-drag-pending");

  // Track movement during the pending (pre-drag-hold) window. A tap that
  // barely moves is a click; movement past the threshold before the hold
  // timer fires means the user is scrolling the panel, so we abort the
  // pending intent and let the browser scroll natively.
  const TAP_SLOP = 10;
  const startX = event.clientX;
  const startY = event.clientY;
  let movedFar = false;

  const fireClickIfTap = (endEvent) => {
    if (this.pendingDrag && !this.dragSession && !movedFar) {
      // Don't fire onClick when user clicked an interactive element (button, input, link)
      const isInteractive = event.target.closest("button:not(.sl-fold-arrow)") || event.target.closest("input") || event.target.closest("a");
      if (!isInteractive) {
        const item = this._getItemAtPath(targetPath);
        // Forward modifier-key state from the end-event so callers can
        // do shift / cmd-aware selection without a separate listener.
        // Falls back to the down-event when (rarely) the end-event has
        // stale modifier state — e.g. user released the modifier key
        // mid-click.
        if (item) this.config.onClick(item, endEvent || event);
      }
    }
  };

  const cleanupPending = () => {
    document.body.classList.remove("sl-drag-pending");
    if (this.pendingDrag && this.pendingDrag.timeoutId) {
      clearTimeout(this.pendingDrag.timeoutId);
    }
    this.pendingDrag = null;
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerCancel);
    window.removeEventListener("pointermove", handlePendingMove);
  };

  const handlePendingMove = (moveEvent) => {
    if (moveEvent.pointerId !== event.pointerId) return;
    if (movedFar || this.dragSession) return;
    const dx = moveEvent.clientX - startX;
    const dy = moveEvent.clientY - startY;
    if (dx * dx + dy * dy > TAP_SLOP * TAP_SLOP) {
      // Past the slop radius this is no longer a tap, so never fire a click.
      movedFar = true;
      // On touch, movement before the hold timer means the user is
      // scrolling the panel — drop the pending intent so the drag-hold
      // timer can't hijack the scroll and a later cancel won't be
      // mistaken for a tap. A mouse has no scroll-by-drag, so we leave the
      // hold timer alone there and let a fast drag start a reorder.
      if (moveEvent.pointerType !== "mouse") cleanupPending();
    }
  };

  const handlePointerUp = (upEvent) => {
    if (upEvent.pointerId !== event.pointerId) return;
    fireClickIfTap(upEvent);
    cleanupPending();
  };

  // iOS fires `pointercancel` (not `pointerup`) when it claims a touch for
  // its own scroll gesture, even on a near-stationary tap. Without this the
  // tap was silently dropped — the cause of "files need two or three taps".
  // A cancel with little movement is recovered as a click; a cancel after
  // real movement is a genuine scroll and just cleans up.
  const handlePointerCancel = (cancelEvent) => {
    if (cancelEvent.pointerId !== event.pointerId) return;
    fireClickIfTap(cancelEvent);
    cleanupPending();
  };

  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerCancel);
  window.addEventListener("pointermove", handlePendingMove);

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
  // Anchor the ghost to the cursor's upper-left so the user can see
  // where the drop will land — the ghost trails down-right from the
  // pointer instead of obscuring it. Ignore the click-point offsets
  // that the caller computed for the cursor-relative anchor.
  void options;
  const offsetX = 0;
  const offsetY = 0;

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
  document.body.classList.add("sl-dragging");
  document.body.classList.remove("sl-drag-pending");
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
  finishDrag.call(this, event);
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

  // Local Sync rows are also `.sl-item` but live outside this list (no
  // `data-path`). Don't compute an in-list drop target for them — the
  // drop is handled by `onDropExternal` (move onto disk). Leaving the
  // previous target set would otherwise reparent the dragged item to the
  // list root when the drop lands over a Local Sync row. Outline the
  // destination container so the user sees where the file will land.
  if (hoveredItem && !hoveredItem.hasAttribute("data-path")) {
    clearDropTarget.call(this);
    this.dragSession.dropTarget = null;
    const extRow = hoveredItem.classList.contains("has-children")
      ? hoveredItem
      : hoveredItem.parentElement?.closest(".sl-item.has-children");
    if (this.dragSession.extDropRow && this.dragSession.extDropRow !== extRow) {
      this.dragSession.extDropRow.classList.remove("sl-drop-target-item");
    }
    if (extRow) extRow.classList.add("sl-drop-target-item");
    this.dragSession.extDropRow = extRow || null;
    this.dragSession.lastDropUpdateX = clientX;
    this.dragSession.lastDropUpdateY = clientY;
    return;
  }

  // No longer over a Local Sync row — drop the external outline.
  if (this.dragSession.extDropRow) {
    this.dragSession.extDropRow.classList.remove("sl-drop-target-item");
    this.dragSession.extDropRow = null;
  }

  if (hoveredItem) {
    const itemPath = parsePath(hoveredItem.dataset.path ?? "");
    const rect = hoveredItem.getBoundingClientRect();
    const offsetY = clientY - rect.top;
    const cs = getComputedStyle(hoveredItem);
    const textHeight =
      parseFloat(cs.fontSize) * this.config.lineHeightMultiplier +
      parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const isNestable = hoveredItem.dataset.canNest === "true";

    let zone;
    if (isNestable) {
      // Nestable items: small before/after strips (5px), rest is "inside"
      const edge = Math.min(5, textHeight * 0.15);
      if (offsetY < edge) zone = "before";
      else if (offsetY > textHeight - edge) zone = "after";
      else zone = "inside";
    } else {
      // Non-nestable items: no inside zone, just before/after split at midpoint
      zone = offsetY < textHeight / 2 ? "before" : "after";
    }

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
      // canDrop also governs sibling reorders — the new parent is the
      // list owning the drop target, or null when we're at the root.
      if (!canDropIntoParent.call(this, parentPath)) {
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
  if (!canDropIntoParent.call(this, parentPath)) { clearDropTarget.call(this); return; }
  setDropTarget.call(this, containerEl, parentPath, clientY);
  this.dragSession.lastDropUpdateX = clientX;
  this.dragSession.lastDropUpdateY = clientY;
}

/** Check canDrop against the parent container (null for root-level). */
function canDropIntoParent(parentPath) {
  const dragged = this.dragSession?.draggedItem;
  if (!dragged || !this.config.canDrop) return true;
  const parentItem = parentPath.length === 0
    ? null
    : this._getItemAtPath(parentPath);
  return this.config.canDrop(dragged, parentItem);
}

function clearDropTarget() {
  if (!this.dragSession) return;
  if (this.dragSession.extDropRow) {
    this.dragSession.extDropRow.classList.remove("sl-drop-target-item");
    this.dragSession.extDropRow = null;
  }
  if (this.dragSession.highlightedParent) {
    this.dragSession.highlightedParent.classList.remove("sl-drop-target-list");
    this.dragSession.highlightedParent = null;
  }
  if (this.dragSession.highlightedParentItem) {
    this.dragSession.highlightedParentItem.classList.remove("sl-drop-target-item");
    this.dragSession.highlightedParentItem = null;
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
  if (this.dragSession.highlightedParentItem) {
    this.dragSession.highlightedParentItem.classList.remove("sl-drop-target-item");
    this.dragSession.highlightedParentItem = null;
  }
  if (parentPath.length > 0) {
    const parentEl = this.container.querySelector(`[data-path="${parentPath.join("/")}"]`);
    if (parentEl) {
      const childList = parentEl.querySelector(":scope > .sl-list");
      if (childList) {
        childList.classList.add("sl-drop-target-list");
        this.dragSession.highlightedParent = childList;
      }
      parentEl.classList.add("sl-drop-target-item");
      this.dragSession.highlightedParentItem = parentEl;
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

function finishDrag(pointerEvent) {
  if (!this.dragSession) return;
  window.removeEventListener("pointermove", this._onPointerMove);

  const { originElement, ghost, dropTarget, originPath, originParentPath, originIndex, autoExpandedIds, highlightedParent, highlightedParentItem, draggedItem } = this.dragSession;

  // Check if the item was dragged outside the sidebar/panel. Cmd/Ctrl
  // elevates any item into a drag-out (used for floating panes), and
  // `forceDragOutside(item)` lets specific item types — e.g. sidebar
  // images destined for an editor or notebook — skip the modifier.
  const forceAllowed = this.config.forceDragOutside?.(draggedItem) === true;
  const cmdHeld = pointerEvent && (pointerEvent.metaKey || pointerEvent.ctrlKey
    || !!(typeof window !== "undefined" && window.__hushCmdHeld));
  const altHeld = pointerEvent && pointerEvent.altKey;
  if (pointerEvent && this.config.onDragOutside && draggedItem &&
      (forceAllowed || cmdHeld || altHeld)) {
    const panelOverlay = this.container.closest("#panel-overlay");
    const rect = panelOverlay?.getBoundingClientRect();
    if (rect && pointerEvent.clientX > rect.right) {
      clearDropTarget.call(this);
      if (highlightedParent) highlightedParent.classList.remove("sl-drop-target-list");
      if (highlightedParentItem) highlightedParentItem.classList.remove("sl-drop-target-item");
      ghost.remove();
      originElement.classList.remove("dragging");
      document.body.classList.remove("sl-dragging");
      autoExpandedIds.forEach((id) => this.state.collapsedIds.add(id));
      this.dragSession = null;
      this.render();
      this.config.onDragOutside(draggedItem, pointerEvent.clientX, pointerEvent.clientY, pointerEvent);
      this.config.onDragEnd(null, false);
      return;
    }
  }

  // External drop target (e.g. a Local Sync folder row sitting outside
  // this list). If the hook claims the drop, snap the source back — the
  // hook owns the actual move.
  if (pointerEvent && this.config.onDropExternal && draggedItem) {
    let handled = false;
    try { handled = this.config.onDropExternal(draggedItem, pointerEvent) === true; }
    catch (e) { console.error("onDropExternal failed:", e); }
    if (handled) {
      clearDropTarget.call(this);
      if (highlightedParent) highlightedParent.classList.remove("sl-drop-target-list");
      if (highlightedParentItem) highlightedParentItem.classList.remove("sl-drop-target-item");
      ghost.remove();
      originElement.classList.remove("dragging");
      document.body.classList.remove("sl-dragging");
      autoExpandedIds.forEach((id) => this.state.collapsedIds.add(id));
      this.dragSession = null;
      this.render();
      this.config.onDragEnd(null, false);
      return;
    }
  }

  clearDropTarget.call(this);
  if (highlightedParent) highlightedParent.classList.remove("sl-drop-target-list");
  if (highlightedParentItem) highlightedParentItem.classList.remove("sl-drop-target-item");
  ghost.remove();
  originElement.classList.remove("dragging");
  document.body.classList.remove("sl-dragging");

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

  const { getChildren, setChildren, getId } = this.config;

  // Resolve destination BEFORE any splicing — path indices are only valid now
  const sourceParent = getChildrenAtPath(this.state.items, originParentPath, getChildren, setChildren);
  const destination = getChildrenAtPath(this.state.items, dropTarget.parentPath, getChildren, setChildren);

  // Also find the destination container item by ID (for expand-after-drop),
  // BEFORE the splice shifts indices
  let destContainerId = null;
  if (dropTarget.parentPath.length > 0) {
    const destItem = getItemAtPath(this.state.items, dropTarget.parentPath, getChildren);
    if (destItem) destContainerId = getId(destItem);
  }

  const [moved] = sourceParent.splice(originIndex, 1);

  let adjustedIndex = dropTarget.index;
  if (pathsEqual(originParentPath, dropTarget.parentPath) && originIndex < dropTarget.index) {
    adjustedIndex -= 1;
  }
  const bounded = Math.max(0, Math.min(adjustedIndex, destination.length));
  destination.splice(bounded, 0, moved);

  // Multi-drag: when the dragged row is part of a multi-selection, the
  // config tells us the *other* selected ids. Pull each out of wherever it
  // sits and drop it right after the primary item so the whole batch moves
  // together (Finder-style) instead of one row at a time.
  const extraIds = this.config.getDraggedSiblings
    ? (this.config.getDraggedSiblings(moved) || [])
    : [];
  if (extraIds.length) {
    const movedId = getId(moved);
    const removedExtras = [];
    for (const exId of extraIds) {
      if (exId === movedId) continue;
      const r = removeItemById(this.state.items, exId, getChildren, getId);
      if (r) removedExtras.push(r);
    }
    if (removedExtras.length) {
      const movedIdx = destination.indexOf(moved);
      destination.splice(movedIdx + 1, 0, ...removedExtras);
    }
  }

  // Ensure the drop target container is expanded so the dropped item is visible
  if (destContainerId) {
    this.state.collapsedIds.delete(destContainerId);
  }

  this.dragSession = null;
  this.render();
  this.config.onChange(this.getData());
  this.config.onDragEnd(moved, true);
}
