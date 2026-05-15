/**
 * Tree-insertion helpers used by the cursor consumer.
 *
 * Extracted from `sync-polling.js` to keep that file under the
 * 700-line build cap. These functions own the "convert a Dropbox
 * relative path into a tree node under the right parent" logic — the
 * piece that has to know about desks, the per-desk Inbox / Trash /
 * Images specials, and the legacy bare-id fallbacks.
 *
 * Exports:
 *   insertDocumentNode(state, relativePath, fileId, isNotebook, name)
 *     — Insert a doc/notebook arriving from a cursor `Created` event.
 *
 *   ensureSeedDeskSpecials(desk, deskId)
 *     — Add the three special children (Inbox / Trash / Images) to a
 *       freshly-minted desk node.
 *
 *   insertImageNode(state, filename, relativePath)
 *     — Drop a downloaded image into the right desk's Images folder
 *       (falls back to active desk → any per-desk Images → legacy id).
 *
 *   insertExistingNode(state, relativePath, node)
 *     — Move an existing tree node to a new parent path (used by
 *       cross-folder rename reparenting).
 */

export function insertDocumentNode(state, relativePath, fileId, isNotebook, name) {
  const parts = relativePath.split("/");
  const rawFileName = parts.pop();
  const fileName = (rawFileName || name || "Untitled").replace(/\.(md|hushnote)$/, "");
  let current = state.fileTree;
  for (let depth = 0; depth < parts.length; depth++) {
    const dirName = parts[depth];
    if (!dirName) continue;
    const isTopLevel = depth === 0;
    let folder = current.find(n => n.type !== "document" && n.type !== "notebook" && n.name === dirName)
      || (dirName === "Inbox" && current.find(n => n.id === "__inbox__" || n.id?.startsWith("__inbox__:")))
      || (dirName === "Trash" && current.find(n => n.id === "__trash__" || n.id?.startsWith("__trash__:")));
    if (!folder) {
      if (isTopLevel) {
        // Top-level path segment = desk (per the .hushdesk model).
        // Mint a temp id; the matching `<DeskName>/.hushdesk` event
        // will reassign it to the canonical id when it arrives via
        // onDeskMeta. Inbox / Trash / Images specials get namespaced
        // under this desk via ensureDeskSpecials so subsequent matches
        // inside the loop find them by `__inbox__:<id>`.
        const deskId = crypto.randomUUID();
        folder = {
          id: deskId, type: "desk", name: dirName,
          children: [], flagged: false,
          createdAt: Math.floor(Date.now() / 1000),
        };
        ensureSeedDeskSpecials(folder, deskId);
        current.push(folder);
      } else {
        folder = { id: crypto.randomUUID(), type: "folder", name: dirName, children: [], flagged: false };
        const trashIdx = current.findIndex(n => n.id === "__trash__" || n.id?.startsWith("__trash__:") || n.name === "Trash");
        if (trashIdx >= 0) current.splice(trashIdx, 0, folder);
        else current.push(folder);
      }
    }
    if (!Array.isArray(folder.children)) folder.children = [];
    current = folder.children;
  }
  if (current.some(n => n.fileId === fileId)) return;
  const trashIdx = current.findIndex(n => n.id === "__trash__" || n.id?.startsWith("__trash__:") || n.name === "Trash");
  const node = {
    id: crypto.randomUUID(),
    type: isNotebook ? "notebook" : "document",
    name: fileName,
    fileId,
    children: [],
    flagged: false,
  };
  if (trashIdx >= 0) current.splice(trashIdx, 0, node);
  else current.push(node);
}

export function ensureSeedDeskSpecials(desk, deskId) {
  const wantInbox = !desk.children.some(c => c.id === `__inbox__:${deskId}`);
  const wantImages = !desk.children.some(c => c.id === `__images__:${deskId}`);
  const wantTrash = !desk.children.some(c => c.id === `__trash__:${deskId}`);
  if (wantInbox) desk.children.unshift({ id: `__inbox__:${deskId}`, type: "project", name: "Inbox", children: [], flagged: false });
  if (wantImages) desk.children.push({ id: `__images__:${deskId}`, type: "folder", name: "Images", children: [], flagged: false });
  if (wantTrash) desk.children.push({ id: `__trash__:${deskId}`, type: "folder", name: "Trash", children: [], flagged: false });
}

export function insertImageNode(state, filename, relativePath = "") {
  // Routing priority: per-desk by path → active desk → any per-desk
  // → bare-id legacy node.
  function findById(nodes, id) {
    for (const n of nodes || []) {
      if (n.id === id) return n;
      const found = findById(n.children, id);
      if (found) return found;
    }
    return null;
  }
  let images = null;
  if (relativePath) {
    const parts = relativePath.split("/");
    if (parts.length >= 2) {
      const deskName = parts[0];
      const deskNode = (state.fileTree || []).find(
        (n) => n.type === "desk" && n.name === deskName
      );
      if (deskNode) {
        images = (deskNode.children || []).find(
          (c) => c.id === `__images__:${deskNode.id}`
        ) || null;
      }
    }
  }
  if (!images) {
    const targetId = typeof state.getImagesId === "function" ? state.getImagesId() : "__images__";
    images = findById(state.fileTree, targetId);
  }
  if (!images) {
    function findByPrefix(nodes) {
      for (const n of nodes || []) {
        if (n.id === "__images__" || n.id?.startsWith("__images__:")) return n;
        const found = findByPrefix(n.children);
        if (found) return found;
      }
      return null;
    }
    images = findByPrefix(state.fileTree);
  }
  if (!images) return;
  if (!Array.isArray(images.children)) images.children = [];
  if (images.children.some(c => c.type === "image" && c.fileId === filename)) return;
  images.children.push({
    id: crypto.randomUUID(), type: "image", name: filename,
    fileId: filename, children: [], flagged: false,
  });
}

export function insertExistingNode(state, relativePath, node) {
  const parts = relativePath.split("/");
  parts.pop(); // drop the filename segment
  let current = state.fileTree;
  for (let depth = 0; depth < parts.length; depth++) {
    const dirName = parts[depth];
    if (!dirName) continue;
    const isTopLevel = depth === 0;
    let folder = current.find(n => n.type !== "document" && n.type !== "notebook" && n.name === dirName)
      || (dirName === "Inbox" && current.find(n => n.id === "__inbox__" || n.id?.startsWith("__inbox__:")))
      || (dirName === "Trash" && current.find(n => n.id === "__trash__" || n.id?.startsWith("__trash__:")));
    if (!folder) {
      if (isTopLevel) {
        const deskId = crypto.randomUUID();
        folder = {
          id: deskId, type: "desk", name: dirName,
          children: [], flagged: false,
          createdAt: Math.floor(Date.now() / 1000),
        };
        ensureSeedDeskSpecials(folder, deskId);
        current.push(folder);
      } else {
        folder = { id: crypto.randomUUID(), type: "folder", name: dirName, children: [], flagged: false };
        const trashIdx = current.findIndex(n => n.id === "__trash__" || n.id?.startsWith("__trash__:") || n.name === "Trash");
        if (trashIdx >= 0) current.splice(trashIdx, 0, folder);
        else current.push(folder);
      }
    }
    if (!Array.isArray(folder.children)) folder.children = [];
    current = folder.children;
  }
  const trashIdx = current.findIndex(n => n.id === "__trash__" || n.id?.startsWith("__trash__:") || n.name === "Trash");
  if (trashIdx >= 0) current.splice(trashIdx, 0, node);
  else current.push(node);
}
