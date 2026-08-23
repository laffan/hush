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
import { showConfirmModal, showDeleteConfirmModal, showPromptModal } from "./files-panel-shared.js";

/** Desk row-menu actions (all-desks view): set-active / rename / delete.
 *  Kept here so files-panel.js stays under the line cap. */
export function handleDeskAction(action, deskId, state) {
  if (action === "set-active-desk") { state.setActiveDesk(deskId); return; }
  const desk = (state.settings.desks || []).find(d => d.id === deskId);
  if (action === "rename-desk") {
    // Local desks are named by their folder; the menu drops this entry
    // for them, so reaching here at all means the roots map moved under
    // us — say so rather than throwing into the void.
    if (state.deskRoots?.[deskId]) {
      window.alert("This desk lives in a folder on disk and takes that folder's name. Rename the folder instead.");
      return;
    }
    showPromptModal({
      title: "Rename desk", label: "Name", initialValue: desk?.name || "",
      confirmLabel: "Rename",
      onConfirm: async (name) => {
        try { await state.renameDesk(deskId, name); }
        catch (e) { window.alert(String(e?.message || e)); }
      },
    });
  } else if (action === "archive-desk") {
    import("./desk-archive.js").then((m) => m.confirmArchiveDesk(state, deskId));
  }
}

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
  // An Inbox row stacks the filename over its last-edit line, both
  // inside `.tree-item-name` — rename the name span, not the stack, or
  // the input opens pre-filled with "Notes3 days ago".
  const nameEl = li.querySelector(".tree-item-inbox-name") || li.querySelector(".tree-item-name");
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
      message:
        "Switching from a project to a folder will lose project-only functionality: " +
        "the joined preview view that reads all child docs as one buffer, the custom " +
        "child ordering, outline numbering (Show numbers), and the ability to convert " +
        "to a single tabbed document. The child files themselves stay where they are.",
      confirmLabel: "Convert to folder",
      onConfirm: doConvert,
    });
  } else {
    doConvert();
  }
}

export function handleConvertProjectToDoc(nodeId, state, refreshAfter) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  showConfirmModal({
    title: `Convert "${node.name}" to a document?`,
    message: "Each document in the project will become a tab in the new document. Non-document files will be moved to a separate folder.",
    confirmLabel: "Convert",
    onConfirm: () => state.convertProjectToDoc(nodeId).then(() => refreshAfter()),
  });
}

export function handleConvertDocToProject(nodeId, state, refreshAfter) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  showConfirmModal({
    title: `Convert "${node.name}" to a project?`,
    message: "Each tab in the document will become a separate document in the new project.",
    confirmLabel: "Convert",
    onConfirm: () => state.convertDocToProject(nodeId).then(() => refreshAfter()),
  });
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

export async function handleOpenAsStack(nodeId, state, refreshAfter) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  const children = (node.children || []).filter((c) =>
    (c.type === "document" || c.type === "notebook" || c.type === "pdf") && c.fileId);
  const proceed = async () => {
    const result = await state.createStack(node.name, null, { openImmediately: true });
    if (!result) return;
    // `createStack({ openImmediately: true })` returns once the file is
    // created, but the stack mounts asynchronously through the
    // "stack-open" event handler in main.js. Poll until the bridge
    // reports the *new* stack as mounted (matching fileId so we never
    // populate a stale instance left over from a previously-open stack)
    // before adding the container's children as columns.
    const { getStackInstance, getStackFileId } = await import("../stack/stack-bridge.js");
    let inst = null;
    for (let i = 0; i < 60; i++) {
      if (getStackFileId() === result.fileId) {
        inst = getStackInstance();
        if (inst) break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!inst) return;
    for (const c of children) inst.addItem(c.fileId, c.type, c.name);
    refreshAfter();
  };
  if (children.length > 15) {
    showConfirmModal({
      title: "Large container",
      message: `This ${node.type} has ${children.length} items. Opening as a stack may be slow. Continue?`,
      confirmLabel: "Open as Stack",
      onConfirm: proceed,
    });
  } else {
    await proceed();
  }
}

function collectAllNames(nodes) {
  const names = [];
  for (const n of nodes) {
    names.push(n.name);
    if (n.children) names.push(...collectAllNames(n.children));
  }
  return names;
}

export async function handleRestore(nodeId, state, refreshAfter) {
  const { restoreFromTrash } = await import("../state/state-tree.js");
  await restoreFromTrash(state, nodeId);
  refreshAfter();
}

export async function handlePermanentDelete(nodeId, state, refreshAfter) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  showDeleteConfirmModal(
    `Permanently delete "${node.name || "Untitled"}"?`,
    "This cannot be undone.",
    async () => {
      const { permanentDelete } = await import("../state/state-tree.js");
      await permanentDelete(state, nodeId);
      refreshAfter();
    },
  );
}
