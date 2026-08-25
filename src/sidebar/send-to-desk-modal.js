/**
 * Send / Copy a node to another desk.
 *
 * `openSendToDeskModal(state, nodeId, mode)` — `mode` is "send" or
 * "copy". Surfaces a small modal listing every desk other than the
 * current source desk; the user picks a target, the node lands at the
 * root of the target desk's children (preserving sub-tree structure).
 *
 * Send: the node is moved (removed from source, appended to target).
 * A send is a departure, so the source desk lets go of the surface
 * too — the open editor drops to the empty pane and any pane backed by
 * a file inside the subtree closes, rather than leaving the user typing
 * into a document their desk no longer holds.
 * Copy: the subtree is recursively cloned. Doc / notebook leaves get
 * fresh fileIds via `state.duplicateFile`; folders / projects become
 * structural clones with new tree-node ids.
 *
 * Image nodes intentionally aren't supported here (they live in their
 * desk's Images folder and are referenced by markdown filenames; a
 * cross-desk copy would require renaming refs everywhere). Calling
 * with an image node is a no-op.
 */

import { escHtml, typeIcons, deskRatchetGlyph } from "./files-panel-shared.js";
import { findNode, removeNode } from "../state/tree-helpers.js";
import { collectTypedFileIds } from "../state/state-tree.js";
import deskRaw from "./sidebar_icons/desk.svg?raw";

let _overlayEl = null;

/** Wire option-click on file-panel rows to open the Send-to-desk
 *  modal. Captured at pointerdown so it pre-empts the SortableList's
 *  click → openFile / toggle behaviour. Idempotent — safe to call on
 *  every panel rebuild. No-ops while there's only one desk (no target
 *  to send to). */
export function attachDeskShortcuts(container, state) {
  if (container._deskShortcutsAttached) return;
  container._deskShortcutsAttached = true;
  container.addEventListener("pointerdown", (e) => {
    if (!e.altKey || e.button !== 0) return;
    if ((state?.settings?.desks || []).length < 2) return;
    const nodeId = e.target.closest(".sl-item")?.dataset.id;
    if (!nodeId || state.isSpecialNodeId(nodeId)) return;
    const node = findNode(state.fileTree, nodeId);
    if (!node || node.type === "image" || node.type === "desk") return;
    e.stopPropagation(); e.preventDefault();
    openSendToDeskModal(state, nodeId, "send");
  }, true);
}

export function openSendToDeskModal(state, nodeId, mode) {
  const node = findNode(state.fileTree, nodeId);
  if (!node || node.type === "image" || node.type === "desk") return;
  if (state.isSpecialNodeId(nodeId)) return;

  const sourceDeskId = findContainingDeskId(state.fileTree, nodeId);
  const targets = (state.settings?.desks || []).filter((d) => d.id !== sourceDeskId);
  if (targets.length === 0) return;

  closeModal();
  const overlay = document.createElement("div");
  overlay.className = "send-to-desk-overlay";
  const verb = mode === "copy" ? "Copy to" : "Send to";
  const fileIcon = typeIcons[node.type] || typeIcons.document;
  const rows = targets.map((d) => `
    <button class="send-to-desk-row" type="button" data-desk-id="${d.id}">
      <span class="send-to-desk-row-icon">${deskRaw}</span>
      <span class="send-to-desk-row-label">${escHtml(d.name || "Untitled desk")}</span>${deskRatchetGlyph(state, d.id)}
    </button>
  `).join("");
  overlay.innerHTML = `
    <div class="send-to-desk-modal">
      <div class="send-to-desk-title">${verb} desk</div>
      <div class="send-to-desk-name">
        <span class="send-to-desk-name-icon">${fileIcon}</span>
        <span class="send-to-desk-name-label">${escHtml(node.name || "Untitled")}</span>
      </div>
      <div class="send-to-desk-list">${rows}</div>
      <div class="send-to-desk-actions">
        <button class="send-to-desk-cancel" type="button">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  _overlayEl = overlay;

  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  overlay.querySelector(".send-to-desk-cancel").addEventListener("click", closeModal);
  overlay.querySelectorAll(".send-to-desk-row").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const targetId = btn.dataset.deskId;
      try {
        await runSendOrCopy(state, nodeId, targetId, mode);
      } catch (e) { console.error(`${mode} to desk failed:`, e); }
      closeModal();
    });
  });
  document.addEventListener("keydown", onKey, true);
}

function onKey(e) { if (e.key === "Escape") { closeModal(); e.stopPropagation(); } }

function closeModal() {
  if (_overlayEl?.parentNode) _overlayEl.parentNode.removeChild(_overlayEl);
  _overlayEl = null;
  document.removeEventListener("keydown", onKey, true);
}

async function runSendOrCopy(state, nodeId, targetDeskId, mode) {
  const tree = state.fileTree;
  const target = tree.find((n) => n.type === "desk" && n.id === targetDeskId);
  if (!target) return;
  if (!Array.isArray(target.children)) target.children = [];

  if (mode === "send") {
    // Ask whether the open surface is inside what we're about to move
    // BEFORE moving it — and let go of it before the tree is saved.
    // A send is a departure from this desk: the file is gone from the
    // sidebar the moment it lands in the other desk, and leaving it in
    // the editor left the user typing into a document their desk no
    // longer holds. Mirrors the ordering `deleteTreeNode` uses for the
    // same reason (state-tree.js).
    const departing = findNode(tree, nodeId);
    const wasOpen = departing ? subtreeHoldsActiveSurface(state, nodeId, departing) : false;
    const removed = removeNode(tree, nodeId);
    if (!removed) return;
    if (wasOpen) await state.clearActiveFile();
    // Drop into the target desk's root, just before its specials.
    insertBeforeDeskSpecials(target.children, removed);
    await closePanesForSubtree(removed);
  } else {
    const node = findNode(tree, nodeId);
    if (!node) return;
    const cloned = await cloneSubtree(state, node);
    if (!cloned) return;
    insertBeforeDeskSpecials(target.children, cloned);
  }
  await state.saveFileTree();
  state.emit("files-changed");
}

/** True when the surface the editor is showing lives inside `node` —
 *  the doc / notebook / PDF / stack itself, or the project whose parts
 *  are joined into the buffer. */
function subtreeHoldsActiveSurface(state, nodeId, node) {
  const { docFileIds, pdfFileIds, stackFileIds } = collectTypedFileIds(node);
  return docFileIds.includes(state.currentFileId)
    || docFileIds.includes(state.currentNotebookFileId)
    || pdfFileIds.includes(state.currentPdfFileId)
    || stackFileIds.includes(state.currentStackFileId)
    || nodeId === state.currentProjectId;
}

/** Close any floating pane backed by a file that just left the desk —
 *  the same cleanup a delete does, for the same reason: the pane would
 *  otherwise keep autosaving into a file this desk no longer lists. */
async function closePanesForSubtree(node) {
  const { docFileIds, pdfFileIds, stackFileIds } = collectTypedFileIds(node);
  const goneIds = new Set([...docFileIds, ...pdfFileIds, ...stackFileIds]);
  if (!goneIds.size) return;
  try {
    const [{ panes }, { closePane }] = await Promise.all([
      import("../pane/pane-state.js"),
      import("../pane/pane-manager.js"),
    ]);
    for (const [id, pane] of [...panes]) {
      if (goneIds.has(pane.fileId)) await closePane(id);
    }
  } catch (e) {
    console.error("closing panes for sent files failed:", e);
  }
}

function insertBeforeDeskSpecials(children, node) {
  // Specials are pinned at tail (Images, Trash) inside a desk; the
  // Inbox sits at head. Insert right before the specials block so the
  // dropped node becomes a regular root-of-desk entry.
  const isSpecial = (n) => n.id?.startsWith("__images__:") || n.id?.startsWith("__trash__:");
  const tailIdx = children.findIndex(isSpecial);
  if (tailIdx >= 0) children.splice(tailIdx, 0, node);
  else children.push(node);
}

async function cloneSubtree(state, node) {
  // Doc/notebook leaves: backend mints a new fileId from the original.
  if ((node.type === "document" || node.type === "notebook") && node.fileId) {
    const newFileId = await state.duplicateFile(node.fileId);
    if (!newFileId) return null;
    return {
      id: crypto.randomUUID(),
      type: node.type,
      name: (node.name || "Untitled") + "-Copy",
      fileId: newFileId,
      children: [],
      flagged: false,
    };
  }
  // Folders / projects: structural clone with fresh ids and recursed
  // children. Images and special nodes inside the subtree are skipped
  // (cross-desk copy of images isn't supported in this phase).
  if (node.type === "folder" || node.type === "project") {
    const cloned = {
      id: crypto.randomUUID(),
      type: node.type,
      name: (node.name || "Untitled"),
      children: [],
      flagged: false,
    };
    for (const child of (node.children || [])) {
      if (child.type === "image") continue;
      if (state.isSpecialNodeId(child.id)) continue;
      const childClone = await cloneSubtree(state, child);
      if (childClone) cloned.children.push(childClone);
    }
    return cloned;
  }
  return null;
}

function findContainingDeskId(tree, nodeId) {
  for (const top of tree) {
    if (top.type !== "desk") continue;
    if (containsNodeId(top, nodeId)) return top.id;
  }
  return null;
}

function containsNodeId(node, target) {
  if (node.id === target) return true;
  if (!node.children) return false;
  for (const c of node.children) if (containsNodeId(c, target)) return true;
  return false;
}
