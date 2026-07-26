/**
 * Execution half of "Copy Files from other Desks" — turns the planned
 * drops into real nodes in the active desk.
 *
 * Docs / notebooks / stacks are copied by content: `state.duplicateFile`
 * mints a fresh fileId from the source bytes and the new tree node's
 * name + position decide where `save_forest` places it on disk. Folders
 * and projects clone structurally, recursing into their children.
 *
 * PDFs are the exception: their binaries are a per-device cache keyed by
 * the registry fileId (see README-TECHNICAL, desk_store), so a copy is a
 * node referencing the same fileId — exactly what a project PDF alias
 * already does. If the destination desk already carries that PDF, the
 * copy degrades to "add an alias to the target project" (or nothing).
 *
 * Stacks reference their columns by fileId. Because a batch usually
 * carries the stack *and* the docs it points at, every copied fileId is
 * recorded and the cloned stacks are rewritten through that map, so a
 * copied stack points at the copies rather than reaching back into the
 * source desk.
 */

import {
  findNode, uniqueChildName, enforceSpecialPositions,
  normalizeProjectChildren, isRealProjectNode,
} from "../state/tree-helpers.js";
import { normalizePdfProjectAliases, addPdfAliasToProject } from "../state/state-pdf-aliases.js";
import { isHiddenSpecialId, COPYABLE_TYPES } from "./copy-from-desks-tree.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/**
 * @param state AppState
 * @param plan  ordered `[{ srcNodeId, parentId, index, type, name }]`
 * @returns `{ copied, skipped }`
 */
export async function runCopyPlan(state, plan) {
  const tree = state.fileTree;
  const entries = (plan || []).map((p, seq) => ({ ...p, seq }));
  if (!entries.length) return { copied: 0, skipped: 0 };

  // `aliased` counts PDFs that were already in this desk and so became a
  // project reference instead of a new node — copied, just not a node.
  const ctx = { fileIdMap: new Map(), clonedStacks: [], aliased: 0 };
  let copied = 0, skipped = 0;

  // Group by destination so several drops into the same container keep
  // the order the user planned them in.
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.parentId)) groups.set(e.parentId, []);
    groups.get(e.parentId).push(e);
  }

  for (const [parentId, group] of groups) {
    const parent = findNode(tree, parentId);
    if (!parent) { skipped += group.length; continue; }
    if (!Array.isArray(parent.children)) parent.children = [];
    const baseLen = parent.children.length;
    group.sort((a, b) => (a.index - b.index) || (a.seq - b.seq));
    let offset = 0;
    for (const e of group) {
      const src = findNode(tree, e.srcNodeId);
      if (!src) { skipped++; continue; }
      const before = ctx.aliased;
      const clone = await cloneForCopy(state, src, parent, ctx);
      if (!clone) { if (ctx.aliased > before) copied++; else skipped++; continue; }
      const at = Math.min(Math.max(e.index, 0), baseLen) + offset;
      parent.children.splice(at, 0, clone);
      offset++;
      copied++;
    }
  }

  await rewriteStackReferences(state, ctx.clonedStacks, ctx.fileIdMap);

  enforceSpecialPositions(tree);
  normalizeProjectChildren(tree);
  normalizePdfProjectAliases(tree);
  await state.saveFileTree();
  if (typeof state.reconcileSync === "function") state.reconcileSync();
  state.emit("files-changed");
  return { copied, skipped };
}

/** Recursive clone. `parent` is the node the clone will live under —
 *  used for sibling name deduplication and for the PDF-alias fallback. */
async function cloneForCopy(state, src, parent, ctx) {
  if (!src || !COPYABLE_TYPES.has(src.type)) return null;
  if (isHiddenSpecialId(src.id)) return null;

  if (src.type === "pdf") return clonePdf(state, src, parent, ctx);

  if (src.type === "folder" || src.type === "project") {
    // The Inbox / Archive / PDFs specials copy as plain folders under
    // their own name — the destination desk already owns those roles, so
    // the copy is ordinary structure rather than a second special.
    const type = String(src.id || "").startsWith("__") ? "folder" : src.type;
    const node = baseNode({ ...src, type }, uniqueChildName(parent, src.name || "Untitled", type));
    for (const child of src.children || []) {
      const clone = await cloneForCopy(state, child, node, ctx);
      if (clone) node.children.push(clone);
    }
    return node;
  }

  if (!src.fileId) return null;
  const newFileId = await state.duplicateFile(src.fileId);
  if (!newFileId) return null;
  ctx.fileIdMap.set(src.fileId, newFileId);
  const node = baseNode(src, uniqueChildName(parent, src.name || "Untitled", src.type));
  node.fileId = newFileId;
  if (src.type === "stack") ctx.clonedStacks.push(node);
  return node;
}

function baseNode(src, name) {
  const node = {
    id: crypto.randomUUID(),
    type: src.type,
    name,
    children: [],
    flagged: false,
  };
  if (src.bgColor) node.bgColor = src.bgColor;
  if (src.useAsNote) node.useAsNote = true;
  if (src.showNumbers) node.showNumbers = true;
  return node;
}

function clonePdf(state, src, parent, ctx) {
  if (!src.fileId) return null;
  const desk = state.getActiveDesk?.() || null;
  const existing = desk ? findRealPdf(desk.children || [], src.fileId) : null;
  if (existing) {
    // Already in this desk — the most useful thing left to do is wire a
    // reference into the project the user dropped on.
    if (isRealProjectNode(parent) && addPdfAliasToProject(parent, existing)) ctx.aliased++;
    return null;
  }
  const node = {
    id: crypto.randomUUID(),
    type: "pdf",
    name: src.name || "Untitled",
    fileId: src.fileId,
    children: [],
    flagged: false,
  };
  if (src.zoteroAttKey) node.zoteroAttKey = src.zoteroAttKey;
  return node;
}

function findRealPdf(nodes, fileId) {
  for (const n of nodes || []) {
    if (n?.type === "pdf" && !n.pdfAlias && n.fileId === fileId) return n;
    const deeper = findRealPdf(n?.children, fileId);
    if (deeper) return deeper;
  }
  return null;
}

/** Point every copied stack's columns at the copies of the docs that
 *  travelled with it. Columns whose source didn't come along keep their
 *  original fileId (the file still resolves — it just lives elsewhere). */
async function rewriteStackReferences(state, stackNodes, fileIdMap) {
  if (!stackNodes.length || !fileIdMap.size) return;
  for (const node of stackNodes) {
    try {
      const raw = await readFileContent(state, node.fileId);
      if (!raw) continue;
      const data = JSON.parse(raw);
      if (!Array.isArray(data?.items)) continue;
      let changed = false;
      for (const item of data.items) {
        const mapped = item?.fileId && fileIdMap.get(item.fileId);
        if (mapped) { item.fileId = mapped; changed = true; }
      }
      if (changed) await writeFileContent(state, node.fileId, JSON.stringify(data));
    } catch (e) {
      console.warn("[copy-from-desks] stack reference rewrite failed", e);
    }
  }
}

async function readFileContent(state, fileId) {
  if (IS_TAURI) return (await tauriInvoke("load_file", { id: fileId }))?.content || "";
  return state.files?.find((f) => f.id === fileId)?.content || "";
}

async function writeFileContent(state, fileId, content) {
  if (IS_TAURI) { await tauriInvoke("save_file", { id: fileId, content }); return; }
  const file = state.files?.find((f) => f.id === fileId);
  if (file) { file.content = content; state._saveFilesLocal?.(); }
}
