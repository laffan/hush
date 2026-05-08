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

/**
 * Collect fileIds of every `document` descendant. Notebooks are skipped:
 * the project's joined editor buffer is text-only, so notebook files
 * inside a project surface as sidebar children rather than feeding the
 * editor stream.
 */
export function collectDocumentIds(nodes) {
  const ids = [];
  for (const n of nodes) {
    // Docs flagged `useAsNote: true` ride alongside the project as
    // supplementary material — they should not feed the joined editor
    // buffer (matching the existing notebook-in-project behaviour).
    if (n.type === "document" && n.fileId && !n.useAsNote) ids.push(n.fileId);
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

/**
 * Collect flagged items into a forest. A flagged folder/project keeps
 * its children so the UI can render them nested underneath — matching
 * the layout the user sees in the regular file tree. A flagged document
 * / notebook shows as a single row (empty children[]). Non-flagged
 * containers are walked into so flagged items nested several levels
 * deep still surface at the top of the Flagged section.
 */
export function collectFlaggedItems(nodes) {
  const result = [];
  for (const n of nodes) {
    if (n.flagged) {
      // Clone the node with its children preserved (but sanitised: image
      // subtrees and the Trash node are always stripped out of bubbled
      // content since they're filesystem scaffolding).
      const cloned = {
        ...n,
        children: (n.type === "folder" || n.type === "project")
          ? sanitizeDescendants(n.children || [])
          : [],
      };
      result.push(cloned);
      continue;
    }
    if (n.children) result.push(...collectFlaggedItems(n.children));
  }
  return result;
}

/** Strip image nodes and special subtrees from a bubbled-up descendant
 *  list but otherwise preserve the original tree structure. Special
 *  ids are matched by prefix to cover per-desk namespacing
 *  (`__images__:<deskId>`, `__trash__:<deskId>`). */
function sanitizeDescendants(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.type === "image") continue;
    if (isImagesOrTrashId(n.id)) continue;
    out.push({
      ...n,
      children: n.children ? sanitizeDescendants(n.children) : [],
    });
  }
  return out;
}

function isImagesOrTrashId(id) {
  if (!id) return false;
  return id === "__images__" || id === "__trash__"
    || id.startsWith("__images__:") || id.startsWith("__trash__:");
}

const _isInbox = (id) => id === "__inbox__" || id?.startsWith("__inbox__:");
const _isImages = (id) => id === "__images__" || id?.startsWith("__images__:");
const _isTrash = (id) => id === "__trash__" || id?.startsWith("__trash__:");

/** Pin Inbox to the head and Images / Trash to the tail of `arr`.
 *  Used by the SortableList onChange handler — the user can drag any
 *  node anywhere, and we re-establish the canonical layout afterwards. */
export function pinSpecialsInList(arr) {
  const inboxIdx = arr.findIndex((n) => _isInbox(n.id));
  if (inboxIdx > 0) { const [inbox] = arr.splice(inboxIdx, 1); arr.unshift(inbox); }
  const trashIdx = arr.findIndex((n) => _isTrash(n.id));
  if (trashIdx >= 0 && trashIdx < arr.length - 1) {
    const [trash] = arr.splice(trashIdx, 1);
    arr.push(trash);
  }
  const imgIdx = arr.findIndex((n) => _isImages(n.id));
  if (imgIdx >= 0) {
    const trashAt = arr.findIndex((n) => _isTrash(n.id));
    const target = trashAt >= 0 ? trashAt : arr.length;
    if (imgIdx !== target - 1) {
      const [img] = arr.splice(imgIdx, 1);
      const newTrashAt = arr.findIndex((n) => _isTrash(n.id));
      arr.splice(newTrashAt >= 0 ? newTrashAt : arr.length, 0, img);
    }
  }
}

/** Pin specials at the global tree level (desks-off mode) and within
 *  each desk node's children (desks-on mode). */
export function enforceSpecialPositions(tree) {
  pinSpecialsInList(tree);
  for (const node of tree) {
    if (node.type === "desk" && Array.isArray(node.children)) pinSpecialsInList(node.children);
  }
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

/**
 * Inside every user project, push notebook children to the bottom while
 * preserving the user's order within each group. Documents first (they
 * feed the joined editor buffer), notebooks second (the supplementary
 * sidebar block under the dashed separator). The pinned `__inbox__`
 * node is typed `project` for legacy reasons but behaves like a
 * folder, so it's skipped. Recurses into nested containers so a project
 * under a folder gets normalized too. Mutates in place; safe to call
 * repeatedly (idempotent).
 */
export function normalizeProjectChildren(nodes) {
  if (!Array.isArray(nodes)) return nodes;
  for (const n of nodes) {
    if (!n || !Array.isArray(n.children)) continue;
    if (n.type === "project" && n.id !== "__inbox__" && !n.id?.startsWith("__inbox__:")) {
      const docs = [], notebooks = [], rest = [];
      for (const c of n.children) {
        // Docs marked `useAsNote: true` sort with notebooks (under the
        // joined buffer at 50 % opacity) so a project can carry both
        // the doc's main flow and supplementary notes side by side.
        if (c.type === "document" && !c.useAsNote) docs.push(c);
        else if (c.type === "notebook" || (c.type === "document" && c.useAsNote)) notebooks.push(c);
        else rest.push(c);
      }
      n.children = [...docs, ...notebooks, ...rest];
    }
    normalizeProjectChildren(n.children);
  }
  return nodes;
}

export function insertNode(tree, node, parentId, findNodeFn) {
  if (!parentId) { insertBeforeTrash(tree, node); return; }
  const parent = findNodeFn(tree, parentId);
  if (parent) { (parent.children || (parent.children = [])).push(node); }
  else { insertBeforeTrash(tree, node); }
}

/** Walk the tree and return the parent node that directly contains
 *  the child with `targetId`. Returns null when the node lives at the
 *  top level (no parent) or isn't found at all. */
export function findParentOfNode(nodes, targetId) {
  for (const n of nodes) {
    if (Array.isArray(n.children)) {
      if (n.children.some((c) => c?.id === targetId)) return n;
      const deeper = findParentOfNode(n.children, targetId);
      if (deeper) return deeper;
    }
  }
  return null;
}

/** Return a name that doesn't collide with any same-type sibling
 *  inside `parent`. If `baseName` is free we return it unchanged;
 *  otherwise we append " (2)" / " (3)" until something fits. Used
 *  on create + rename so a folder can't end up with two children of
 *  the same type sharing a name (which would map to the same Dropbox
 *  path). `excludeId` skips one child from the check — used by rename
 *  so a node doesn't see itself as a conflict. */
export function uniqueChildName(parent, baseName, type, excludeId = null) {
  const siblings = (parent?.children) || [];
  const taken = new Set();
  for (const c of siblings) {
    if (!c || c.id === excludeId) continue;
    if (c.type !== type) continue;
    if (c.name) taken.add(c.name);
  }
  if (!taken.has(baseName)) return baseName;
  for (let i = 2; i < 1000; i++) {
    const cand = `${baseName} (${i})`;
    if (!taken.has(cand)) return cand;
  }
  return baseName;
}

function insertBeforeTrash(tree, node) {
  // Keep both special tail nodes (Images, Trash) below any new root-level
  // insertion by preferring the earlier of the two as the insertion point.
  // (When desks are on, the top-level tree has no global specials — the
  // Images/Trash live inside each desk — so this falls through to push.)
  const imagesIdx = tree.findIndex(n => n.id === "__images__");
  if (imagesIdx >= 0) { tree.splice(imagesIdx, 0, node); return; }
  const trashIdx = tree.findIndex(n => n.id === "__trash__");
  if (trashIdx >= 0) tree.splice(trashIdx, 0, node);
  else tree.push(node);
}
