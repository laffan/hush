/**
 * Conversion between Projects and tabbed Docs.
 *
 * - convertProjectToDoc: merges a project's child docs into a single
 *   tabbed document, moving non-doc children to a "[Name] - Files" folder.
 * - convertDocToProject: splits a tabbed document into a project where
 *   each tab section becomes a child document.
 */

import { findNode, findParentOfNode } from "./tree-helpers.js";
import { parseTabs, joinTabs } from "../editor/tabs.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

async function loadFileContent(state, fileId) {
  if (IS_TAURI) {
    try {
      const file = await tauriInvoke("load_file", { id: fileId });
      return file.content || "";
    } catch (e) {
      console.warn("Load file for conversion:", e);
      return "";
    }
  }
  const file = state.files.find(f => f.id === fileId);
  return file?.content || "";
}

export async function convertProjectToDoc(state, nodeId) {
  const node = findNode(state.fileTree, nodeId);
  if (!node || node.type !== "project") return;

  if (state.currentProjectId === nodeId) {
    await state.saveProjectContent();
  }

  const docChildren = [];
  const nonDocChildren = [];
  for (const child of (node.children || [])) {
    if (child.type === "document" && child.fileId && !child.useAsNote) {
      docChildren.push(child);
    } else if (child.type === "folder" && child.pdfFolder) {
      // The project's PDFs folder holds aliases — project-scoped
      // references that don't survive the project. Dropped; the desk's
      // PDFs folder keeps the real entries.
      continue;
    } else {
      nonDocChildren.push(child);
    }
  }

  const sections = [];
  for (const doc of docChildren) {
    const content = await loadFileContent(state, doc.fileId);
    sections.push({ path: [doc.name || "Untitled"], content });
  }

  const combinedContent = joinTabs(sections);

  let fileId;
  if (IS_TAURI) {
    try {
      const file = await tauriInvoke("create_file");
      fileId = file.id;
      await tauriInvoke("save_file", { id: fileId, content: combinedContent });
      await tauriInvoke("rename_file", { id: fileId, name: node.name });
    } catch (e) {
      console.error("Create file for conversion failed:", e);
      return;
    }
  } else {
    fileId = crypto.randomUUID();
    state.files.unshift({
      id: fileId, name: node.name, content: combinedContent,
      modified: Math.floor(Date.now() / 1000),
    });
  }

  const newDocNode = {
    id: crypto.randomUUID(),
    type: "document",
    name: node.name,
    fileId,
    children: [],
    flagged: node.flagged,
    ...(node.bgColor ? { bgColor: node.bgColor } : {}),
  };

  let filesFolder = null;
  if (nonDocChildren.length > 0) {
    filesFolder = {
      id: crypto.randomUUID(),
      type: "folder",
      name: `${node.name} - Files`,
      children: nonDocChildren,
      flagged: false,
    };
  }

  const parent = findParentOfNode(state.fileTree, nodeId);
  const siblings = parent ? parent.children : state.fileTree;
  const idx = siblings.findIndex(n => n.id === nodeId);
  if (idx >= 0) {
    if (filesFolder) {
      siblings.splice(idx, 1, newDocNode, filesFolder);
    } else {
      siblings.splice(idx, 1, newDocNode);
    }
  }

  for (const doc of docChildren) {
    if (IS_TAURI) {
      try { await tauriInvoke("delete_file", { id: doc.fileId }); } catch (_) {}
      try { await tauriInvoke("delete_document_snapshots", { documentId: doc.fileId }); } catch (_) {}
    } else {
      state.files = state.files.filter(f => f.id !== doc.fileId);
    }
  }

  if (IS_TAURI) state.files = await tauriInvoke("list_files");
  else state._saveFilesLocal();

  await state.saveFileTree();

  state.currentProjectId = null;
  state.projectDocIds = [];
  await state.openFile(fileId);

  state.emit("files-changed");
  state.syncCreateFile(newDocNode.id, fileId, combinedContent);
}

export async function convertDocToProject(state, nodeId) {
  const node = findNode(state.fileTree, nodeId);
  if (!node || node.type !== "document" || !node.fileId) return;

  if (state.currentFileId === node.fileId && state.dirty) {
    await state.saveCurrentFile();
  }

  let content;
  if (state.currentFileId === node.fileId && state.editor?.getContent) {
    content = state.editor.getContent() || "";
  } else {
    content = await loadFileContent(state, node.fileId);
  }

  const sections = parseTabs(content);

  const childNodes = [];
  for (const section of sections) {
    if (section.path.length === 0 && !section.content.trim()) continue;

    const name = section.path.length > 0
      ? section.path[section.path.length - 1]
      : node.name;
    const sectionContent = section.content || "";

    let childFileId;
    if (IS_TAURI) {
      try {
        const file = await tauriInvoke("create_file");
        childFileId = file.id;
        await tauriInvoke("save_file", { id: childFileId, content: sectionContent });
        await tauriInvoke("rename_file", { id: childFileId, name });
      } catch (e) {
        console.error("Create child doc for conversion failed:", e);
        continue;
      }
    } else {
      childFileId = crypto.randomUUID();
      state.files.unshift({
        id: childFileId, name, content: sectionContent,
        modified: Math.floor(Date.now() / 1000),
      });
    }

    childNodes.push({
      id: crypto.randomUUID(),
      type: "document",
      name,
      fileId: childFileId,
      children: [],
      flagged: false,
    });
  }

  if (childNodes.length === 0) {
    // An empty (or whitespace-only) doc still converts — it becomes a project
    // with a single child doc carrying the original content. Without this the
    // conversion silently no-ops, which made "Add Gutter" on a fresh/empty
    // document appear to do nothing (no project created).
    let childFileId;
    if (IS_TAURI) {
      try {
        const file = await tauriInvoke("create_file");
        childFileId = file.id;
        await tauriInvoke("save_file", { id: childFileId, content });
        await tauriInvoke("rename_file", { id: childFileId, name: node.name });
      } catch (e) {
        console.error("Create child doc for conversion failed:", e);
        return;
      }
    } else {
      childFileId = crypto.randomUUID();
      state.files.unshift({
        id: childFileId, name: node.name, content,
        modified: Math.floor(Date.now() / 1000),
      });
    }
    childNodes.push({
      id: crypto.randomUUID(),
      type: "document",
      name: node.name,
      fileId: childFileId,
      children: [],
      flagged: false,
    });
  }

  const projectNode = {
    id: crypto.randomUUID(),
    type: "project",
    name: node.name,
    children: childNodes,
    flagged: node.flagged,
    ...(node.bgColor ? { bgColor: node.bgColor } : {}),
  };

  const parent = findParentOfNode(state.fileTree, nodeId);
  const siblings = parent ? parent.children : state.fileTree;
  const idx = siblings.findIndex(n => n.id === nodeId);
  if (idx >= 0) {
    siblings.splice(idx, 1, projectNode);
  }

  if (IS_TAURI) {
    try { await tauriInvoke("delete_file", { id: node.fileId }); } catch (_) {}
    try { await tauriInvoke("delete_document_snapshots", { documentId: node.fileId }); } catch (_) {}
    state.files = await tauriInvoke("list_files");
  } else {
    state.files = state.files.filter(f => f.id !== node.fileId);
    state._saveFilesLocal();
  }

  await state.saveFileTree();

  state.currentFileId = null;
  await state.openProject(projectNode.id);

  state.emit("files-changed");
  state.syncProjectOrdering(projectNode.id);
  for (const child of childNodes) {
    state.syncCreateFile(child.id, child.fileId, "");
  }
}
