/**
 * Sortable list utilities — path operations, deep clone, tree traversal
 */

export function parsePath(pathString) {
  if (!pathString) return [];
  return pathString.split("/").filter(Boolean).map(Number);
}

export function pathsEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export function isAncestorPath(ancestor, candidate) {
  if (ancestor.length > candidate.length) return false;
  return ancestor.every((value, index) => value === candidate[index]);
}

export function deepClone(items, getChildren, setChildren) {
  return items.map((item) => {
    const cloned = { ...item };
    const children = getChildren(item);
    // Always clone the children array — even empty ones — to avoid shared references
    if (children) {
      setChildren(cloned, children.length ? deepClone(children, getChildren, setChildren) : []);
    }
    return cloned;
  });
}

export function getChildrenAtPath(items, path, getChildren, setChildren) {
  let current = items;
  for (const index of path) {
    const node = current[index];
    if (!node) return [];
    let children = getChildren(node);
    if (!children) {
      children = [];
      setChildren(node, children);
    }
    current = children;
  }
  return current;
}

export function getItemAtPath(items, path, getChildren) {
  let current = items;
  let item = null;
  for (const index of path) {
    item = current[index];
    if (!item) return null;
    current = getChildren(item) || [];
  }
  return item;
}

export function escapeForAttribute(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return String(value).replace(/(["'\\\[\].#:])/g, "\\$1");
}

/** Remove the first item whose id === `id` from anywhere in the nested
 *  structure, returning the removed item (or null). Used by multi-drag to
 *  gather the companion-selected items before re-inserting them. */
export function removeItemById(items, id, getChildren, getId) {
  for (let i = 0; i < items.length; i++) {
    if (getId(items[i]) === id) return items.splice(i, 1)[0];
    const children = getChildren(items[i]);
    if (children && children.length) {
      const removed = removeItemById(children, id, getChildren, getId);
      if (removed) return removed;
    }
  }
  return null;
}

export function getAllVisiblePaths(items, getChildren, getId, collapsedIds) {
  const paths = [];
  const collect = (list, path) => {
    list.forEach((item, index) => {
      const itemPath = [...path, index];
      paths.push(itemPath);
      const itemId = getId(item);
      const isCollapsed = collapsedIds.has(itemId);
      const children = getChildren(item);
      if (children && children.length && !isCollapsed) {
        collect(children, itemPath);
      }
    });
  };
  collect(items, []);
  return paths;
}
