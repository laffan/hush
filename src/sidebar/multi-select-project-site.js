/**
 * Where a "Create Project" built from a multi-select batch should land.
 *
 * The batch already tells us where the user is working: if every
 * selected file sits inside the same Folder / Project / Inbox, the new
 * project belongs *there* rather than at the desk root, and it should
 * take the slot the first selected row occupied so the surrounding
 * order (project list order included) survives the grouping.
 *
 * `newProjectSite(tree, nodeIds)` returns `{ parentId, index }`:
 *   - `parentId` — the deepest shared container a project can live in
 *     (null → caller falls back to the active desk root)
 *   - `index` — the slot inside that container the earliest selected
 *     row occupies (-1 → append, i.e. leave wherever it was created)
 *
 * `placeNodeAt(tree, parentId, nodeId, index)` moves an already-created
 * node into that slot (the Rust `create_project` command appends, so
 * the reposition happens after the fact).
 */

import { findNode, findAncestorIds } from "../state/tree-helpers.js";

const SPECIAL_PREFIXES = ["__images__", "__pdfs__", "__trash__"];

/** Containers a freshly-created project may be nested inside. Desks,
 *  folders and projects qualify — including the Inbox (typed `project`)
 *  and the Archive (typed `folder`). The Images / PDFs / Trash specials
 *  don't: they're managed storage, not user structure. */
function canHoldProject(node) {
  if (!node) return false;
  if (node.type === "desk") return true;
  if (node.type !== "folder" && node.type !== "project") return false;
  const id = String(node.id || "");
  return !SPECIAL_PREFIXES.some((p) => id === p || id.startsWith(p + ":"));
}

/** Longest ancestor path every node in `nodeIds` shares, outermost first. */
function commonAncestorChain(tree, nodeIds) {
  const chains = nodeIds.map((id) => findAncestorIds(tree, id) || []);
  if (!chains.length) return [];
  const shared = [];
  for (let i = 0; i < chains[0].length; i++) {
    const id = chains[0][i];
    if (!chains.every((c) => c[i] === id)) break;
    shared.push(id);
  }
  return shared;
}

export function newProjectSite(tree, nodeIds) {
  const ids = (nodeIds || []).filter(Boolean);
  if (!ids.length) return { parentId: null, index: -1 };

  // Walk in from the deepest shared ancestor until we hit a container a
  // project can actually live in — a batch selected inside the desk's
  // PDFs folder, say, groups at the desk level instead.
  const chain = commonAncestorChain(tree, ids);
  let parentId = null;
  for (let i = chain.length - 1; i >= 0; i--) {
    if (canHoldProject(findNode(tree, chain[i]))) { parentId = chain[i]; break; }
  }
  if (!parentId) return { parentId: null, index: -1 };

  // The slot: the earliest position among the parent's direct children
  // that leads to one of the selected rows (a selection nested a level
  // or two deeper still anchors on the child that contains it).
  const parent = findNode(tree, parentId);
  const kids = parent?.children || [];
  let index = -1;
  for (const nodeId of ids) {
    const path = findAncestorIds(tree, nodeId) || [];
    const at = path.indexOf(parentId);
    const childId = at >= 0 ? (path[at + 1] ?? nodeId) : nodeId;
    const i = kids.findIndex((k) => k?.id === childId);
    if (i >= 0 && (index < 0 || i < index)) index = i;
  }
  return { parentId, index };
}

/** Move `nodeId` to `index` within `parentId`'s children. No-op when the
 *  node isn't a direct child of that parent (or is already in place). */
export function placeNodeAt(tree, parentId, nodeId, index) {
  if (index < 0) return false;
  const parent = parentId ? findNode(tree, parentId) : null;
  const kids = parent ? (parent.children || []) : tree;
  const from = kids.findIndex((k) => k?.id === nodeId);
  if (from < 0) return false;
  const to = index > from ? index - 1 : index;
  if (to === from) return false;
  const [node] = kids.splice(from, 1);
  kids.splice(Math.max(0, Math.min(to, kids.length)), 0, node);
  return true;
}
