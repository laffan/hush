/**
 * Placeholder documents in the files panel. A Project Desktop's
 * placeholders (desktop/board/board-model.js) are listed where their
 * documents will go — after the document (or nested project) they follow,
 * or at the head of their container — under the name the document will
 * take: the first item of the placeholder's outline. They are synthetic
 * rows, like heading and tab-marker rows: added to the tree for each
 * render (`augmentTreeWithPlaceholders`), stripped before any tree write
 * (`stripPlaceholdersFromTree`), never dragged or dropped on. Clicking
 * one opens its project's Desktop scrolled to it (or scrolls the
 * Desktop already open).
 */
import { findNode, findParentOfNode } from "../state/tree-helpers.js";
import { boardData, placeholderName } from "../desktop/board/board-model.js";
import { escHtml } from "./files-panel-shared.js";

const PREFIX = "__ph__:";

export const isPlaceholderItem = (item) => item?.type === "placeholder";

const PH_ICON = `<svg class="tree-type-icon" viewBox="0 0 16 16"><rect x="3.5" y="2" width="9" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.6"/></svg>`;

/** containerId → [{ afterId, item }] for every placeholder of every
 *  project's board, in the board's order. */
function placementsFor(state) {
  const out = new Map();
  const add = (containerId, afterId, item) => {
    if (!out.has(containerId)) out.set(containerId, []);
    out.get(containerId).push({ afterId, item });
  };
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.type === "project") {
        for (const ph of boardData(n).placeholders) {
          const item = {
            id: PREFIX + ph.id, type: "placeholder", name: placeholderName(ph) || "Untitled",
            phId: ph.id, boardId: n.id, children: [],
          };
          const after = ph.afterId ? findNode(state.fileTree, ph.afterId) : null;
          if (after) add(findParentOfNode(state.fileTree, ph.afterId)?.id || n.id, ph.afterId, item);
          else if (ph.afterId) add(n.id, "__end__", item);
          else add((ph.parentId && findNode(state.fileTree, ph.parentId)) ? ph.parentId : n.id, null, item);
        }
      }
      if (n.children?.length) walk(n.children);
    }
  };
  walk(state.fileTree);
  return out;
}

/** The display tree with every placeholder in its place. */
export function augmentTreeWithPlaceholders(state, tree) {
  const placements = placementsFor(state);
  if (!placements.size || !Array.isArray(tree)) return tree;
  const visit = (node) => {
    if (!node || typeof node !== "object") return node;
    let children = Array.isArray(node.children) && node.children.length ? node.children.map(visit) : node.children;
    const mine = placements.get(node.id);
    if (mine) {
      const list = [...(children || [])];
      // Head of the container: after a pinned cards notebook, if any.
      const head = mine.filter((p) => p.afterId === null).map((p) => p.item);
      let at = 0;
      while (at < list.length && list[at]?.cardsHome) at++;
      list.splice(at, 0, ...head);
      for (const p of mine) {
        if (p.afterId === null || p.afterId === "__end__") continue;
        const i = list.findIndex((c) => c.id === p.afterId);
        // After the node and any placeholders already placed behind it.
        let j = i < 0 ? list.length : i + 1;
        while (j < list.length && isPlaceholderItem(list[j])) j++;
        list.splice(j, 0, p.item);
      }
      list.push(...mine.filter((p) => p.afterId === "__end__").map((p) => p.item));
      children = list;
    }
    return children !== node.children ? { ...node, children } : node;
  };
  return tree.map(visit);
}

export function stripPlaceholdersFromTree(tree) {
  if (!Array.isArray(tree)) return tree;
  return tree.filter((n) => !isPlaceholderItem(n)).map((n) => (Array.isArray(n?.children) && n.children.length
    ? { ...n, children: stripPlaceholdersFromTree(n.children) } : n));
}

/** A placeholder's row: a dashed page and its tentative name. Clicking
 *  it opens its Desktop at it; `afterOpen` closes an overlay sidebar. */
export function renderPlaceholderRow(state, item, afterOpen) {
  const row = document.createElement("span");
  row.className = "tree-item-row tree-placeholder-row";
  row.title = "Not written yet — opens its place on the Project Desktop";
  row.innerHTML = `${PH_ICON}<span class="tree-item-name">${escHtml(item.name)}</span>`;
  row.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.selectedDocIds?.length) state.clearSelectedDocs();
    import("../desktop/desktop-view.js").then((m) => m.openDesktop(state, item.boardId, { focusPlaceholder: item.phId }));
    afterOpen?.();
  });
  return row;
}
