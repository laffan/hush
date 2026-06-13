/**
 * Materialize a .hushproject envelope (the normalized descriptor produced by
 * project/project-pack.js#unpackProject) into a real project subtree.
 *
 * Mirrors the file-creation pattern used by convertDocToProject: each child
 * gets a backing file in the content store (notebooks and stacks are just
 * files whose tree-node `type` makes them render as a canvas / stack), and
 * the tree nodes are assembled in JS and persisted via saveFileTree. The
 * empty project itself is created through state.createProject so desk / parent
 * placement reuses the proven path.
 */

import { findNode, normalizeProjectChildren } from "./tree-helpers.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Create a backing file (content store) and return its id. */
async function createBackingFile(state, name, content) {
  if (IS_TAURI) {
    const f = await tauriInvoke("create_file");
    await tauriInvoke("save_file", { id: f.id, content: content || "" });
    if (name) { try { await tauriInvoke("rename_file", { id: f.id, name }); } catch (_) {} }
    return f.id;
  }
  const id = crypto.randomUUID();
  state.files.unshift({ id, name, content: content || "", modified: Math.floor(Date.now() / 1000) });
  return id;
}

export async function createProjectFromEnvelope(state, envelope, parentId = null, opts = {}) {
  const openImmediately = opts.openImmediately !== false;
  if (openImmediately && state.dirty) await state.saveCurrentFile();

  const created = await state.createProject(envelope?.name || "Imported Project", parentId);
  if (!created) return null;
  const projectId = created.id;
  const projectNode = findNode(state.fileTree, projectId);
  if (!projectNode) return null;
  projectNode.children = projectNode.children || [];

  const childSync = [];
  for (const child of (envelope?.children || [])) {
    if (!child || !child.type) continue;
    const fileId = await createBackingFile(state, child.name, child.content || "");
    const node = {
      id: crypto.randomUUID(), type: child.type, name: child.name || "Untitled",
      fileId, children: [], flagged: false,
    };
    if (child.useAsNote) node.useAsNote = true;
    if (child.gutter) node.gutter = true;
    projectNode.children.push(node);
    childSync.push({ node, content: child.content || "" });
  }

  if (envelope?.showNumbers) projectNode.showNumbers = true;
  if (envelope?.bgColor) projectNode.bgColor = envelope.bgColor;
  if (envelope?.flagged) projectNode.flagged = true;
  normalizeProjectChildren([projectNode]);

  if (IS_TAURI) state.files = await tauriInvoke("list_files");
  else state._saveFilesLocal?.();
  await state.saveFileTree();
  state.emit("files-changed");

  // Register each backing file with the sync layer (project node itself was
  // registered by createProject → syncCreateNode).
  for (const { node, content } of childSync) state.syncCreateFile?.(node.id, node.fileId, content);
  state.syncProjectOrdering?.(projectId);

  if (openImmediately) await state.openProject(projectId);
  return { projectId, name: projectNode.name };
}
