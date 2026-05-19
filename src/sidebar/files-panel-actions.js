/**
 * Row-action handlers for the files panel — rename, duplicate, convert,
 * delete, empty-trash, and reveal-in-finder. Each function takes the
 * AppState plus the row's tree-node id (and whatever auxiliary data the
 * action needs) and updates the tree, leaning on
 * `state.<verb>TreeNode(...)` for the actual mutation.
 *
 * Extracted from `files-panel.js` so that file stays under the 700-line
 * cap. Callers pass `refreshAfter` so the panel can repaint without
 * this module having to import the panel back (which would otherwise
 * create a circular dependency).
 */
import { findNode } from "../state/tree-helpers.js";
import { showConfirmModal, showDeleteConfirmModal } from "./files-panel-shared.js";

function escAttrValue(str) {
  return (str || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Inline rename: swap the row label for an input element, commit on
 *  Enter / blur, cancel on Escape. `triggerEl` is the button that
 *  fired the action (used to walk up to the row); falls back to a
 *  `data-id` query when invoked from outside the row (e.g. the row
 *  menu dropdown). */
export function handleRename(nodeId, triggerEl, state, refreshAfter) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  let li = triggerEl?.closest(".sl-item") || null;
  if (!li) {
    const safe = (window.CSS && typeof window.CSS.escape === "function") ? window.CSS.escape(nodeId) : nodeId;
    li = document.querySelector(`.sl-item[data-id="${safe}"]`);
  }
  if (!li) return;
  const nameEl = li.querySelector(".tree-item-name");
  if (!nameEl) return;
  const rowEl = li.querySelector(".tree-item-row");
  if (rowEl) rowEl.classList.add("renaming");

  const currentName = nameEl.textContent;
  nameEl.innerHTML = `<input class="tree-rename-input" type="text" value="${escAttrValue(currentName)}" />`;
  const input = nameEl.querySelector("input");
  input.focus();
  input.select();

  function finishRename() {
    if (rowEl) rowEl.classList.remove("renaming");
    const newName = input.value.trim();
    if (newName && newName !== currentName) {
      state.renameTreeNode(nodeId, newName).then(() => refreshAfter());
    } else {
      nameEl.textContent = currentName;
    }
  }

  input.addEventListener("blur", finishRename, { once: true });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { input.value = currentName; input.blur(); }
  });
}

export async function handleRevealInFinder(nodeId, state) {
  const node = findNode(state.fileTree, nodeId);
  if (!node?.syncFolderId) return;
  const folder = (state.settings.syncFolders || []).find((f) => f.id === node.syncFolderId);
  if (!folder?.path) return;
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.revealItemInDir(folder.path);
  } catch (e) {
    console.error("Failed to reveal in Finder:", e);
  }
}

/** Convert a folder to a project or vice versa. Projects → folders
 *  prompts first because the conversion drops the project's ordering
 *  and joined preview view. */
export function handleConvertContainer(nodeId, targetType, state, refreshAfter) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  if (targetType !== "folder" && targetType !== "project") return;
  if (node.type === targetType) return;
  const doConvert = () => state.convertContainerType(nodeId, targetType).then(() => refreshAfter());
  if (node.type === "project" && targetType === "folder") {
    showConfirmModal({
      title: `Convert "${node.name}" to a folder?`,
      message: "Switching from a project to a folder loses the project's ordering and the joined preview view. Files will be preserved.",
      confirmLabel: "Convert",
      onConfirm: doConvert,
    });
  } else {
    doConvert();
  }
}

export function handleDuplicate(nodeId, state, refreshAfter) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  const typeName = node.type === "notebook" ? "notebook" : "document";
  showConfirmModal({
    title: `Duplicate ${typeName} "${node.name}"?`,
    message: `A copy named "${node.name}-Copy" will be created next to the original.`,
    confirmLabel: "Duplicate",
    onConfirm: () => state.duplicateTreeNode(nodeId).then(() => refreshAfter()),
  });
}

export function handleDelete(nodeId, state, refreshAfter) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  const inTrash = state.isInTrash(nodeId);

  if (node.type === "folder" || node.type === "project" || inTrash) {
    const items = collectAllNames(node.children || []);
    const itemList = items.length > 0
      ? items.map((n) => `  • ${n}`).join("\n")
      : "  (empty)";
    const typeName = node.type === "folder" ? "folder" : node.type === "project" ? "project" : node.type === "notebook" ? "notebook" : "document";
    const title = inTrash
      ? `Permanently delete "${node.name}"?`
      : `Delete ${typeName} "${node.name}"?`;
    const message = inTrash
      ? `This will permanently delete this item and cannot be undone.${items.length > 0 ? `\n\nContents:\n${itemList}` : ""}`
      : `This will move the ${typeName} to Trash.\n\nContents:\n${itemList}`;
    showDeleteConfirmModal(title, message, () => {
      state.deleteTreeNode(nodeId).then(() => refreshAfter());
    });
  } else {
    state.deleteTreeNode(nodeId).then(() => refreshAfter());
  }
}

export function handleEmptyTrash(state, refreshAfter) {
  const trash = findNode(state.fileTree, state.getTrashId());
  if (!trash?.children?.length) return;
  const items = collectAllNames(trash.children);
  const itemList = items.map((n) => `  • ${n}`).join("\n");
  showDeleteConfirmModal(
    "Empty Trash?",
    `This will permanently delete all items and cannot be undone.\n\nContents:\n${itemList}`,
    () => { state.emptyTrash().then(() => refreshAfter()); },
  );
}

function collectAllNames(nodes) {
  const names = [];
  for (const n of nodes) {
    names.push(n.name);
    if (n.children) names.push(...collectAllNames(n.children));
  }
  return names;
}
