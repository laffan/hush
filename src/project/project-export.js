/**
 * Project export — writes the active project out as a .hushproject zip,
 * bundling its docs, notebooks (and their images), and stacks into one
 * self-contained envelope. Mirrors stack-export.js, but the payload is
 * binary (the zip bytes) rather than JSON text.
 */

import { findNode } from "../state/tree-helpers.js";
import { isIOS } from "../settings/settings-ui.js";
import { packProject } from "./project-pack.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

async function loadContent(state, fileId) {
  if (IS_TAURI) {
    try { return (await tauriInvoke("load_file", { id: fileId })).content || ""; }
    catch (e) { console.warn("Project export: skipping file", fileId, e); return ""; }
  }
  const f = state.files.find((x) => x.id === fileId);
  return f?.content || "";
}

/** Walk a project node into the normalized descriptor packProject wants,
 *  loading each child's content. Nested folders / projects / PDFs are out
 *  of scope for the v1 envelope. */
export async function collectProjectDescriptor(state, projectNode) {
  const children = [];
  for (const c of (projectNode.children || [])) {
    if (!c || !c.fileId) continue;
    if (c.type === "document") {
      children.push({ type: "document", name: c.name, content: await loadContent(state, c.fileId), ...(c.useAsNote ? { useAsNote: true } : {}) });
    } else if (c.type === "notebook") {
      children.push({ type: "notebook", name: c.name, content: await loadContent(state, c.fileId), ...(c.gutter ? { gutter: true } : {}) });
    } else if (c.type === "stack") {
      children.push({ type: "stack", name: c.name, content: await loadContent(state, c.fileId) });
    }
  }
  return {
    name: projectNode.name,
    showNumbers: !!projectNode.showNumbers,
    flagged: !!projectNode.flagged,
    bgColor: projectNode.bgColor || null,
    children,
  };
}

function sanitizeName(raw) {
  return (raw || "project").replace(/[\/\\:*?"<>|]/g, "-").slice(0, 120) || "project";
}

export async function exportCurrentProject(state) {
  if (!state.currentProjectId) return;
  // Flush the joined buffer back to the child docs so the export is current.
  if (state.dirty) await state.saveProjectContent();
  const node = findNode(state.fileTree, state.currentProjectId);
  if (!node || node.type !== "project") return;

  const descriptor = await collectProjectDescriptor(state, node);
  const bytes = await packProject(descriptor);
  const fileName = `${sanitizeName(node.name)}.hushproject`;

  if (!IS_TAURI) {
    const blob = new Blob([bytes], { type: "application/x-hushproject" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = fileName; a.click();
    URL.revokeObjectURL(url);
    return;
  }

  if (isIOS()) {
    const file = new File([bytes], fileName, { type: "application/x-hushproject" });
    if (!(navigator.canShare && navigator.canShare({ files: [file] }))) {
      console.error("Web Share API cannot share a .hushproject on this device");
      return;
    }
    try { await navigator.share({ files: [file] }); }
    catch (e) {
      if (e && (e.name === "AbortError" || /aborted|cancel/i.test(e.message || ""))) return;
      console.error("Project export share failed:", e);
    }
    return;
  }

  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const filePath = await save({
      defaultPath: fileName,
      filters: [{ name: "Hush Project", extensions: ["hushproject"] }],
    });
    if (!filePath) return;
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(filePath, bytes);
  } catch (e) {
    console.error("Project export failed:", e);
  }
}
