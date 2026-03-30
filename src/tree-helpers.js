/**
 * Pure tree utility functions for file tree manipulation
 */

export function findNode(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

export function removeNode(nodes, id) {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return nodes.splice(i, 1)[0];
    if (nodes[i].children) {
      const removed = removeNode(nodes[i].children, id);
      if (removed) return removed;
    }
  }
  return null;
}

export function collectDocumentIds(nodes) {
  const ids = [];
  for (const n of nodes) {
    if (n.type === "document" && n.fileId) ids.push(n.fileId);
    if (n.children) ids.push(...collectDocumentIds(n.children));
  }
  return ids;
}

export function findNodeByFileId(nodes, fileId) {
  for (const n of nodes) {
    if (n.type === "document" && n.fileId === fileId) return n;
    if (n.children) {
      const found = findNodeByFileId(n.children, fileId);
      if (found) return found;
    }
  }
  return null;
}

export function insertAfter(nodes, afterId, newNode) {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === afterId) { nodes.splice(i + 1, 0, newNode); return true; }
    if (nodes[i].children && insertAfter(nodes[i].children, afterId, newNode)) return true;
  }
  return false;
}

export function collectFlaggedItems(nodes) {
  const result = [];
  for (const n of nodes) {
    if (n.flagged) result.push(n);
    if (n.children) result.push(...collectFlaggedItems(n.children));
  }
  return result;
}

export function findAncestorIds(nodes, targetId, path = []) {
  for (const n of nodes) {
    if (n.id === targetId) return path;
    if (n.children) {
      const found = findAncestorIds(n.children, targetId, [...path, n.id]);
      if (found) return found;
    }
  }
  return null;
}

export function insertNode(tree, node, parentId, findNodeFn) {
  if (!parentId) { tree.push(node); return; }
  const parent = findNodeFn(tree, parentId);
  if (parent) { (parent.children || (parent.children = [])).push(node); }
  else { tree.push(node); }
}
