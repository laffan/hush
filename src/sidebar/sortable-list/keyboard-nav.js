/**
 * Sortable list keyboard navigation — arrow keys, move mode, collapse/expand
 */

import {
  pathsEqual,
  getAllVisiblePaths,
  getChildrenAtPath,
  getItemAtPath,
} from "./utils.js";
import { deepClone } from "./utils.js";

export function initKeyboardHandlers(instance) {
  instance._onKeyDown = onKeyDown.bind(instance);
}

function onKeyDown(event) {
  if (event.key === "m" || event.key === "M") {
    event.preventDefault();
    if (this.state.isMoving) confirmMove.call(this);
    else enterMovingMode.call(this);
  } else if (event.key === "q" || event.key === "Q") {
    event.preventDefault();
    cancelMove.call(this);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    if (!this.state.isMoving) collapseSelected.call(this);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    if (!this.state.isMoving) expandSelected.call(this);
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    if (this.state.isMoving) moveItemInTree.call(this, "down");
    else moveSelection.call(this, "down");
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    if (this.state.isMoving) moveItemInTree.call(this, "up");
    else moveSelection.call(this, "up");
  }
}

function collapseSelected() {
  if (!this.state.selectedPath) return;
  const item = getItemAtPath(this.state.items, this.state.selectedPath, this.config.getChildren);
  if (!item) return;
  const children = this.config.getChildren(item);
  if (!children || children.length === 0) return;
  this.state.collapsedIds.add(this.config.getId(item));
  this.render();
  scrollSelectedIntoView.call(this);
}

function expandSelected() {
  if (!this.state.selectedPath) return;
  const item = getItemAtPath(this.state.items, this.state.selectedPath, this.config.getChildren);
  if (!item) return;
  const children = this.config.getChildren(item);
  if (!children || children.length === 0) return;
  this.state.collapsedIds.delete(this.config.getId(item));
  this.render();
  scrollSelectedIntoView.call(this);
}

function scrollSelectedIntoView() {
  if (!this.state.selectedPath) return;
  const el = this.container.querySelector(`[data-path="${this.state.selectedPath.join("/")}"]`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function moveSelection(direction) {
  const allPaths = getAllVisiblePaths(
    this.state.items, this.config.getChildren, this.config.getId, this.state.collapsedIds
  );
  if (allPaths.length === 0) return;

  if (!this.state.selectedPath) {
    this.state.selectedPath = direction === "down" ? allPaths[0] : allPaths[allPaths.length - 1];
    this.render();
    scrollSelectedIntoView.call(this);
    return;
  }

  const idx = allPaths.findIndex((p) => pathsEqual(p, this.state.selectedPath));
  if (idx === -1) { this.state.selectedPath = allPaths[0]; this.render(); return; }

  if (direction === "down" && idx < allPaths.length - 1) {
    this.state.selectedPath = allPaths[idx + 1];
  } else if (direction === "up" && idx > 0) {
    this.state.selectedPath = allPaths[idx - 1];
  } else {
    return;
  }
  this.render();
  scrollSelectedIntoView.call(this);
}

function enterMovingMode() {
  if (!this.state.selectedPath || this.state.isMoving) return;
  this.state.isMoving = true;
  this.state.itemsBeforeMove = deepClone(
    this.state.items, this.config.getChildren, this.config.setChildren
  );
  this.render();
}

function confirmMove() {
  if (!this.state.isMoving) return;
  this.state.isMoving = false;
  this.state.itemsBeforeMove = null;
  this.render();
  this.config.onChange(this.getData());
}

function cancelMove() {
  if (!this.state.isMoving) return;
  this._abandonKeyboardMode({ revertMove: true });
}

export function abandonKeyboardMode(instance, { revertMove = false } = {}) {
  const wasMoving = instance.state.isMoving;
  const hadSelection = Boolean(instance.state.selectedPath);
  const shouldResetItems = revertMove && instance.state.itemsBeforeMove;

  if (!wasMoving && !hadSelection && !shouldResetItems) return false;

  if (shouldResetItems) instance.state.items = instance.state.itemsBeforeMove;
  instance.state.isMoving = false;
  instance.state.itemsBeforeMove = null;
  instance.state.selectedPath = null;
  instance.render();
  return true;
}

function moveItemInTree(direction) {
  if (!this.state.selectedPath || !this.state.isMoving) return;

  const allPaths = getAllVisiblePaths(
    this.state.items, this.config.getChildren, this.config.getId, this.state.collapsedIds
  );
  const idx = allPaths.findIndex((p) => pathsEqual(p, this.state.selectedPath));
  if (idx === -1) return;

  let targetIndex;
  if (direction === "down" && idx < allPaths.length - 1) targetIndex = idx + 1;
  else if (direction === "up" && idx > 0) targetIndex = idx - 1;
  else return;

  const { getChildren, setChildren } = this.config;
  const originParentPath = this.state.selectedPath.slice(0, -1);
  const originIndex = this.state.selectedPath[this.state.selectedPath.length - 1];
  const sourceParent = getChildrenAtPath(this.state.items, originParentPath, getChildren, setChildren);
  const [moved] = sourceParent.splice(originIndex, 1);

  const newAllPaths = getAllVisiblePaths(
    this.state.items, getChildren, this.config.getId, this.state.collapsedIds
  );
  const newTargetIndex = direction === "down" ? idx : idx - 1;

  if (newTargetIndex < 0 || newTargetIndex >= newAllPaths.length) {
    sourceParent.splice(originIndex, 0, moved);
    return;
  }

  const newTargetPath = newAllPaths[newTargetIndex];
  const targetParentPath = newTargetPath.slice(0, -1);
  const targetIndexInParent = newTargetPath[newTargetPath.length - 1];
  const destination = getChildrenAtPath(this.state.items, targetParentPath, getChildren, setChildren);
  const targetItem = getItemAtPath(this.state.items, newTargetPath, getChildren);

  if (direction === "down" && targetItem && this.config.canNest(targetItem)) {
    const targetItemId = this.config.getId(targetItem);
    this.state.collapsedIds.delete(targetItemId);
    const containerChildren = getChildrenAtPath(this.state.items, newTargetPath, getChildren, setChildren);
    containerChildren.splice(0, 0, moved);
    this.state.selectedPath = [...newTargetPath, 0];
  } else if (direction === "down") {
    destination.splice(targetIndexInParent + 1, 0, moved);
    this.state.selectedPath = [...targetParentPath, targetIndexInParent + 1];
  } else {
    destination.splice(targetIndexInParent, 0, moved);
    this.state.selectedPath = [...targetParentPath, targetIndexInParent];
  }

  this.render();
  scrollSelectedIntoView.call(this);
}
