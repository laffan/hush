/**
 * Project PDF aliases — PDFs added to a project live in a
 * project-specific "PDFs" folder as *aliases*: tree nodes that share the
 * original's fileId (so binary + registry metadata resolve identically)
 * but are just references. The desk's PDFs folder keeps the one real
 * node; deleting it removes every alias, while deleting an alias never
 * touches the desk copy.
 *
 * Node markers (declared on the Rust TreeNode so they survive the
 * save/load round trip):
 *   - `pdfAlias: true`  on the alias pdf nodes (+ `addedAt` epoch secs)
 *   - `pdfFolder: true` on the project's own "PDFs" folder
 *
 * `normalizePdfProjectAliases` is the drag-and-drop counterpart to
 * `enforceSpecialPositions`: the sidebar lets a PDF row be *dropped* on
 * a project, and this pass converts that move into "alias into the
 * project + original returns to its desk's PDFs folder" after the fact.
 */

import { isRealProjectNode, pinSpecialsInList } from "./tree-helpers.js";

const isPdfsSpecialId = (id) => id === "__pdfs__" || (typeof id === "string" && id.startsWith("__pdfs__:"));
const isTrashSpecialId = (id) => id === "__trash__" || (typeof id === "string" && id.startsWith("__trash__:"));

export function isProjectPdfFolder(node) {
  return !!node && node.type === "folder" && node.pdfFolder === true;
}

/** Find or create the project's own PDFs folder. Pure tree edit. */
export function ensureProjectPdfFolder(project) {
  if (!project.children) project.children = [];
  let folder = project.children.find(isProjectPdfFolder);
  if (!folder) {
    folder = { id: crypto.randomUUID(), type: "folder", name: "PDFs", pdfFolder: true, children: [], flagged: false };
    project.children.push(folder);
  }
  return folder;
}

/** Add an alias for `pdfNode` into `project`'s PDFs folder (deduped by
 *  fileId). Pure tree edit — the caller persists. Returns true when an
 *  alias was actually added. */
export function addPdfAliasToProject(project, pdfNode) {
  if (!isRealProjectNode(project) || !pdfNode?.fileId) return false;
  const folder = ensureProjectPdfFolder(project);
  if (folder.children.some((c) => c.type === "pdf" && c.fileId === pdfNode.fileId)) return false;
  const alias = {
    id: crypto.randomUUID(),
    type: "pdf",
    name: pdfNode.name,
    fileId: pdfNode.fileId,
    pdfAlias: true,
    addedAt: Math.floor(Date.now() / 1000),
    children: [],
    flagged: false,
  };
  if (pdfNode.zoteroAttKey) alias.zoteroAttKey = pdfNode.zoteroAttKey;
  folder.children.push(alias);
  return true;
}

/** Find the desk's `__pdfs__:<deskId>` folder (creating it when the
 *  desk doesn't have one yet — e.g. a cross-desk drop). `desk` may be
 *  null on a pre-migration flat tree, in which case the legacy bare
 *  `__pdfs__` at the root is used. */
function ensureDeskPdfsFolder(tree, desk) {
  const list = desk ? (desk.children || (desk.children = [])) : tree;
  const id = desk ? `__pdfs__:${desk.id}` : "__pdfs__";
  let folder = list.find((n) => n.id === id);
  if (!folder) {
    folder = { id, type: "folder", name: "PDFs", children: [], flagged: false };
    list.push(folder);
    pinSpecialsInList(list);
  }
  if (!folder.children) folder.children = [];
  return folder;
}

function spliceOut(list, node) {
  const i = list.indexOf(node);
  if (i >= 0) list.splice(i, 1);
  return i >= 0;
}

/** Walk `nodes` (skipping Trash subtrees), calling
 *  `visit(node, ancestors, containingList)` for every node. */
function walkOutsideTrash(nodes, visit, ancestors = []) {
  for (const n of [...nodes]) {
    if (!n || isTrashSpecialId(n.id)) continue;
    visit(n, ancestors, nodes);
    if (Array.isArray(n.children)) walkOutsideTrash(n.children, visit, [...ancestors, n]);
  }
}

/**
 * Re-establish the canonical PDF layout after any tree mutation the
 * user can make by dragging:
 *   1. A real (non-alias) PDF dropped outside a desk PDFs folder is
 *      returned there; if it landed inside a project, an alias is left
 *      behind in that project's PDFs folder.
 *   2. An alias dropped elsewhere in its project is re-slotted into the
 *      project's PDFs folder; an alias dragged out of any project is
 *      removed (dragging out = removing the reference).
 *   3. Aliases whose original no longer exists (outside Trash) are
 *      pruned, and emptied project PDFs folders are dropped.
 * Mutates in place; returns true when anything changed.
 */
export function normalizePdfProjectAliases(tree) {
  let changed = false;
  const strays = [];     // real pdf outside any __pdfs__ special
  const misplaced = [];  // alias inside a project but not in its PDFs folder
  const dropped = [];    // alias outside any project

  walkOutsideTrash(tree, (n, ancestors, list) => {
    if (n.type !== "pdf" || !n.fileId) return;
    const project = [...ancestors].reverse().find(isRealProjectNode) || null;
    if (!n.pdfAlias) {
      if (ancestors.some((a) => isPdfsSpecialId(a.id))) return;
      const desk = ancestors.find((a) => a.type === "desk") || null;
      strays.push({ node: n, list, project, desk });
    } else {
      const parent = ancestors[ancestors.length - 1] || null;
      if (!project) dropped.push({ node: n, list });
      else if (!isProjectPdfFolder(parent)) misplaced.push({ node: n, list, project });
    }
  });

  for (const { node, list, project, desk } of strays) {
    if (!spliceOut(list, node)) continue;
    changed = true;
    if (project) addPdfAliasToProject(project, node);
    const pdfsFolder = ensureDeskPdfsFolder(tree, desk);
    if (!pdfsFolder.children.some((c) => c.type === "pdf" && !c.pdfAlias && c.fileId === node.fileId)) {
      pdfsFolder.children.push(node);
    }
  }
  for (const { node, list, project } of misplaced) {
    if (!spliceOut(list, node)) continue;
    changed = true;
    const folder = ensureProjectPdfFolder(project);
    if (!folder.children.some((c) => c.type === "pdf" && c.fileId === node.fileId)) {
      folder.children.push(node);
    }
  }
  for (const { node, list } of dropped) {
    if (spliceOut(list, node)) changed = true;
  }

  // Dedupe within each project PDFs folder — an alias dragged across
  // projects can land beside an existing alias for the same PDF.
  walkOutsideTrash(tree, (n) => {
    if (!isProjectPdfFolder(n) || !Array.isArray(n.children)) return;
    const seen = new Set();
    for (let i = 0; i < n.children.length; i++) {
      const c = n.children[i];
      if (!c || c.type !== "pdf" || !c.fileId) continue;
      if (seen.has(c.fileId)) {
        n.children.splice(i, 1);
        i--;
        changed = true;
      } else {
        seen.add(c.fileId);
      }
    }
  });

  // Orphan pruning — an alias only lives as long as its desk original.
  const originals = new Set();
  walkOutsideTrash(tree, (n) => {
    if (n.type === "pdf" && n.fileId && !n.pdfAlias) originals.add(n.fileId);
  });
  walkOutsideTrash(tree, (n, _ancestors, list) => {
    if (n.pdfAlias && !originals.has(n.fileId)) {
      if (spliceOut(list, n)) changed = true;
    }
  });

  if (pruneEmptyPdfFolders(tree)) changed = true;
  if (enforcePinnedPdfOrder(tree)) changed = true;
  return changed;
}

/** Keep pinned PDFs at the top of every PDFs folder (desk specials and
 *  project pdfFolders) — stable within each group. Mutates in place;
 *  returns true when any folder was reordered. */
export function enforcePinnedPdfOrder(tree) {
  let changed = false;
  walkOutsideTrash(tree, (n) => {
    if (!isPdfsSpecialId(n.id) && !isProjectPdfFolder(n)) return;
    if (!Array.isArray(n.children) || n.children.length < 2) return;
    const pinned = n.children.filter((c) => c?.pinned);
    if (!pinned.length) return;
    const reordered = [...pinned, ...n.children.filter((c) => !c?.pinned)];
    if (reordered.some((c, i) => c !== n.children[i])) {
      n.children = reordered;
      changed = true;
    }
  });
  return changed;
}

/** Remove every alias referencing one of `fileIds`, everywhere in the
 *  tree (Trash included — a purged original leaves no references
 *  behind). Returns true when anything was removed. */
export function removeAliasesForFileIds(tree, fileIds) {
  const targets = new Set(fileIds || []);
  if (!targets.size) return false;
  let changed = false;
  const scan = (nodes) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (!n) continue;
      if (n.pdfAlias && targets.has(n.fileId)) {
        nodes.splice(i, 1);
        changed = true;
        continue;
      }
      if (Array.isArray(n.children)) scan(n.children);
    }
  };
  scan(tree);
  if (pruneEmptyPdfFolders(tree)) changed = true;
  return changed;
}

/** Drop project PDFs folders that no longer hold anything. */
export function pruneEmptyPdfFolders(tree) {
  let changed = false;
  const scan = (nodes) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (!n) continue;
      if (Array.isArray(n.children)) scan(n.children);
      if (isProjectPdfFolder(n) && (!n.children || n.children.length === 0)) {
        nodes.splice(i, 1);
        changed = true;
      }
    }
  };
  scan(tree);
  return changed;
}
