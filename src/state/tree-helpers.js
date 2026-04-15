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
    if ((n.type === "document" || n.type === "notebook") && n.fileId) ids.push(n.fileId);
    if (n.children) ids.push(...collectDocumentIds(n.children));
  }
  return ids;
}

export function findNodeByFileId(nodes, fileId) {
  for (const n of nodes) {
    if ((n.type === "document" || n.type === "notebook") && n.fileId === fileId) return n;
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

/**
 * Find the sync context for a node — returns { syncFolderId, relativePath }
 * or null if the node is not found.
 * In the new full-tree sync model, every node has a sync context.
 * relativePath is built from the node's position in the tree using node names.
 * For legacy synced folders (with syncFolderId), the old behavior is preserved.
 */
export function findSyncContext(nodes, targetId) {
  function search(nodes, syncFolderId, pathParts) {
    for (const node of nodes) {
      const curSyncId = node.syncFolderId || syncFolderId;
      // If this node IS a legacy synced folder root, path resets to empty
      const curPath = node.syncFolderId ? [] : [...pathParts, node.name];

      if (node.id === targetId) {
        if (node.syncFolderId) return { syncFolderId: node.syncFolderId, relativePath: "" };
        // In full-tree sync mode, return the path from tree root
        return { syncFolderId: curSyncId || "__dropbox_sync__", relativePath: curPath.join("/") };
      }

      if (node.children?.length) {
        const result = search(node.children, curSyncId, curPath);
        if (result !== undefined) return result;
      }
    }
    return undefined; // not found in this branch
  }
  const result = search(nodes, null, []);
  return result === undefined ? null : result;
}

export function insertNode(tree, node, parentId, findNodeFn) {
  if (!parentId) { insertBeforeTrash(tree, node); return; }
  const parent = findNodeFn(tree, parentId);
  if (parent) { (parent.children || (parent.children = [])).push(node); }
  else { insertBeforeTrash(tree, node); }
}

function insertBeforeTrash(tree, node) {
  const idx = tree.findIndex(n => n.id === "__trash__");
  if (idx >= 0) tree.splice(idx, 0, node);
  else tree.push(node);
}
