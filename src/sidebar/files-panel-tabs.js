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

/** True for the synthetic rows this module injects. */
export function isTabMarkerItem(item) {
  return item?.type === "tab-marker";
}

/** Read the live content for `fileId`, preferring the editor's buffer
 *  when it's the active doc so unsaved tab edits show up immediately. */
function readDocContent(state, fileId) {
  if (state?.currentFileId === fileId && state?.editor?.getContent) {
    try { return state.editor.getContent() || ""; } catch (_) { /* fall through */ }
  }
  const file = (state?.files || []).find((f) => f?.id === fileId);
  return file?.content || "";
}

/** Return `[{ title, offset }, …]` for a document's `---Tab name---`
 *  markers, in source order. The root section (no marker) is dropped
 *  — only actual markers surface in the sidebar. */
export function getTabsForDoc(state, fileId) {
  const text = readDocContent(state, fileId);
  if (!text) return [];
  const sections = parseTabSections(text, 0);
  const out = [];
  for (const s of sections) {
    if (!s?.title) continue;
    out.push({ title: s.title, offset: s.startOffset });
  }
  return out;
}

/** Walk the tree and append synthetic tab-marker children under every
 *  `type: "document"` node that carries markers. Pure — never mutates
 *  the input. Used by the files panel before handing data to
 *  SortableList; the inverse `stripTabMarkersFromTree` runs in
 *  `onChange` so saved trees never carry the synthetic nodes. */
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
      // Marker ids include the parent tree node id so two tree nodes
      // pointing to the same fileId (rare but legal — e.g. a doc
      // alias) still get unique synthetic children for SortableList.
      const tabNodes = tabs.map((t) => ({
        id: `tab:${node.id}:${t.offset}`,
        type: "tab-marker",
        name: t.title,
        fileId: node.fileId,
        tabOffset: t.offset,
        children: [],
      }));
      const baseChildren = Array.isArray(nextChildren) ? nextChildren : [];
      return { ...node, children: [...baseChildren, ...tabNodes] };
    }
  }
  if (nextChildren !== node.children) return { ...node, children: nextChildren };
  return node;
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
 *  driven by `.tree-tab-marker-row` styles in `files-panel.css`. */
export function renderTabMarkerRow(item) {
  const row = document.createElement("span");
  row.className = "tree-item-row tree-tab-marker-row";
  const nameEl = document.createElement("span");
  nameEl.className = "tree-item-name tree-tab-marker-name";
  nameEl.textContent = item.name || "";
  row.appendChild(nameEl);
  return row;
}

/** Open the parent doc and scroll the editor so `offset` lands in view.
 *  Uses CodeMirror's transactional `scrollIntoView: true` because
 *  `coordsAtPos` returns null for positions outside the current
 *  viewport, which made the manual-scroll path quietly no-op for any
 *  marker far below the top of the doc. */
export async function openDocAtTab(state, fileId, offset) {
  if (state.ratchetMode) return; // openFile refuses while ratchet is on
  if (state.currentFileId !== fileId) {
    await state.openFile(fileId);
  }
  // Two rAFs so CodeMirror's reflow after openFile/setContent settles
  // — the first frame applies decorations and the second paints, after
  // which a `scrollIntoView: true` transaction lands cleanly.
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => requestAnimationFrame(r));
  const view = state.editor?.view;
  if (!view) return;
  const safeOffset = Math.max(0, Math.min(offset, view.state.doc.length));
  view.dispatch({
    selection: { anchor: safeOffset },
    scrollIntoView: true,
  });
  view.focus();
}
