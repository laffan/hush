/**
 * Tab markers in the files sidebar.
 *
 * Documents with `---Tab name---` markers expose each marker as a small
 * synthetic child row underneath their tree node, mirroring how the
 * outline view's tab section reads. Clicking a row opens the parent
 * doc and scrolls the editor to the marker's source offset.
 *
 * The synthetic rows are *not* persisted — they're injected into the
 * tree shape just before SortableList builds the DOM, and stripped
 * back out before `onChange` writes the tree to disk. They also opt
 * out of every drag-and-drop path (`canDrag`, `canDrop`, `canNest`
 * all return false) so a regular reorder never touches them.
 *
 * Active-file content is pulled from `state.editor.getContent()` so
 * the sidebar tracks markers added between autosaves. Other docs read
 * from the cached `state.files` snapshot — accurate to the last
 * file-tree refresh, which is enough since their content doesn't
 * change while the user is editing a sibling.
 */
import { parseTabSections } from "../longview/longview-parser.js";
import { EditorView } from "@codemirror/view";
import { GOOGLE_DOCS_ICON_SVG } from "../google-docs/icon.js";

/** True for the synthetic rows this module injects. */
export function isTabMarkerItem(item) {
  return item?.type === "tab-marker";
}

/** Read the live content for `fileId`, preferring the editor's buffer
 *  when it's the active doc so unsaved tab edits show up immediately.
 *  Shared with files-panel-headings.js. */
export function readDocContent(state, fileId) {
  if (state?.currentFileId === fileId && state?.editor?.getContent) {
    try { return state.editor.getContent() || ""; } catch (_) { /* fall through */ }
  }
  const file = (state?.files || []).find((f) => f?.id === fileId);
  return file?.content || "";
}

/** Return `[{ title, path, offset, depth }, …]` for a document's
 *  `---Tab name---` markers, in source order. The root section (no
 *  marker) is dropped — only actual markers surface in the sidebar. */
export function getTabsForDoc(state, fileId) {
  const text = readDocContent(state, fileId);
  if (!text) return [];
  const sections = parseTabSections(text, 0);
  const out = [];
  for (const s of sections) {
    if (!s?.path?.length) continue;
    out.push({
      title: s.title || s.path[s.path.length - 1],
      path: s.path,
      depth: s.depth,
      offset: s.startOffset,
    });
  }
  return out;
}

/** Walk the tree and append synthetic tab-marker children under every
 *  `type: "document"` node that carries markers. Nested markers
 *  produce nested tab-marker children — `---Parent---/---Child---`
 *  becomes a Child tab-marker node inside its Parent tab-marker
 *  node's `children`, which SortableList renders with the existing
 *  indent + left-border tree styling. Pure — never mutates the input. */
export function augmentTreeWithTabs(state, tree) {
  if (!Array.isArray(tree)) return tree;
  return tree.map((node) => augmentNode(state, node));
}

function augmentNode(state, node) {
  if (!node || typeof node !== "object") return node;
  let nextChildren = node.children;
  if (Array.isArray(node.children) && node.children.length) {
    nextChildren = node.children.map((child) => augmentNode(state, child));
  }
  if (node.type === "document" && node.fileId) {
    const tabs = getTabsForDoc(state, node.fileId);
    if (tabs.length) {
      const tabTree = buildTabSubtree(node.id, node.fileId, tabs);
      const baseChildren = Array.isArray(nextChildren) ? nextChildren : [];
      return { ...node, children: [...baseChildren, ...tabTree] };
    }
  }
  if (nextChildren !== node.children) return { ...node, children: nextChildren };
  return node;
}

/** Walk tabs in source order, threading each one into the right slot
 *  of the parent chain. A tab at depth D nests inside whatever was
 *  pushed at depth D-1; same-depth or shallower entries pop the stack
 *  first so siblings share their parent. Marker ids include the parent
 *  tree-node id + the source offset so they stay unique across the
 *  whole augmented tree. */
function buildTabSubtree(parentNodeId, fileId, tabs) {
  const roots = [];
  const stack = [{ depth: -1, children: roots }];
  for (const t of tabs) {
    while (stack.length > 1 && stack[stack.length - 1].depth >= t.depth) {
      stack.pop();
    }
    const marker = {
      id: `tab:${parentNodeId}:${t.offset}`,
      type: "tab-marker",
      name: t.title,
      fileId,
      tabOffset: t.offset,
      tabPath: t.path,
      tabDepth: t.depth,
      children: [],
    };
    stack[stack.length - 1].children.push(marker);
    stack.push({ depth: t.depth, children: marker.children });
  }
  return roots;
}

/** Inverse of `augmentTreeWithTabs` — drops every synthetic node so
 *  the saved file tree never inherits one. */
export function stripTabMarkersFromTree(tree) {
  if (!Array.isArray(tree)) return tree;
  const out = [];
  for (const node of tree) {
    if (isTabMarkerItem(node)) continue;
    if (Array.isArray(node?.children) && node.children.length) {
      out.push({ ...node, children: stripTabMarkersFromTree(node.children) });
    } else {
      out.push(node);
    }
  }
  return out;
}

/** Inline DOM for a tab-marker row. Smaller text + indentation are
 *  driven by `.tree-tab-marker-row` styles in `files-panel.css`.
 *
 *  The click handler is attached here rather than through
 *  SortableList's onClick because SortableList's pointer flow bails
 *  on items where `canDrag` returns false — no `pendingDrag` is set,
 *  so no synthetic click event fires. A direct listener on the row
 *  element bypasses that path entirely. */
export function renderTabMarkerRow(item, onJump) {
  const row = document.createElement("span");
  row.className = "tree-item-row tree-tab-marker-row";
  const icon = document.createElement("span");
  icon.className = "tree-tab-marker-icon";
  icon.innerHTML = GOOGLE_DOCS_ICON_SVG;
  row.appendChild(icon);
  const nameEl = document.createElement("span");
  nameEl.className = "tree-item-name tree-tab-marker-name";
  nameEl.textContent = item.name || "";
  row.appendChild(nameEl);
  if (typeof onJump === "function") {
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      onJump(item);
    });
  }
  return row;
}

/** Open the parent doc and scroll the editor so `offset` lands in view.
 *  Uses `EditorView.scrollIntoView` as a state effect because
 *  `coordsAtPos` returns null for offsets outside the current
 *  viewport, which made the simpler `scrollIntoView: true` path
 *  quietly no-op for markers far below the top of the doc on a
 *  freshly-opened file. */
export async function openDocAtTab(state, fileId, offset) {
  if (state.ratchetMode) return; // openFile refuses while ratchet is on
  if (state.currentFileId !== fileId) {
    await state.openFile(fileId);
    // Two rAFs so CodeMirror's reflow after openFile/setContent
    // settles before we dispatch the scroll effect.
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
  }
  const view = state.editor?.view;
  if (!view) return;
  const safeOffset = Math.max(0, Math.min(offset, view.state.doc.length));
  view.dispatch({
    selection: { anchor: safeOffset },
    effects: EditorView.scrollIntoView(safeOffset, { y: "start", yMargin: 80 }),
  });
  view.focus();
}
