/**
 * Helpers for the "Create New From Selected" and "Send Selected" command
 * palette entries. Capture the active selection — text in doc mode, shapes
 * in notebook mode — and either spin it out into a new file in the Inbox
 * or append it to an existing one.
 */

import { findNodeByFileId } from "./state/tree-helpers.js";
import { renameTreeNode } from "./state/state-tree.js";

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

function genId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** ddmmyy-hhmm — month and minute zero-padded; 24-hour clock. */
export function makeStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}${pad(d.getMonth() + 1)}${pad(d.getFullYear() % 100)}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** Snapshot the current CodeMirror selection. Returns the selected text
 *  or null if nothing is selected / no editor is mounted. Stays a string
 *  capture so callers can route into a new file or an append safely. */
export function getDocSelection(state) {
  if (!state || !state.editor) return null;
  const view = state.editor.view;
  if (!view) return null;
  const sel = view.state.selection.main;
  if (sel.from === sel.to) return null;
  return view.state.sliceDoc(sel.from, sel.to);
}

/** Snapshot selected notebook shapes plus the flow edges that live
 *  entirely within the selection. Shape ids and parent/group/edge
 *  references are remapped so the snapshot can be inserted into a
 *  different notebook without colliding with whatever is already there.
 *  Returns null if no canvas is mounted or nothing is selected. */
export async function getNotebookSelection() {
  const { getCanvasInstance } = await import("./notebook/notebook-bridge.js");
  const canvas = getCanvasInstance();
  if (!canvas) return null;
  const dState = canvas.state;
  const selectedIds = dState.selectedIds;
  if (!selectedIds || selectedIds.size === 0) return null;
  const selected = dState.shapes.filter((s) => selectedIds.has(s.id));
  if (selected.length === 0) return null;

  const idMap = new Map();
  for (const s of selected) idMap.set(s.id, genId());

  const newShapes = selected.map((s) => {
    const ns = { ...s, id: idMap.get(s.id) };
    if (ns.parentId) {
      if (idMap.has(ns.parentId)) ns.parentId = idMap.get(ns.parentId);
      else delete ns.parentId;
    }
    if (ns.groupId) {
      if (idMap.has(ns.groupId)) ns.groupId = idMap.get(ns.groupId);
      else delete ns.groupId;
    }
    return ns;
  });

  const oldEdges = dState.flowchart.serialize();
  const newEdges = oldEdges
    .filter((e) => idMap.has(e.from) && idMap.has(e.to))
    .map((e) => ({ id: genId(), from: idMap.get(e.from), to: idMap.get(e.to) }));

  return { shapes: newShapes, edges: newEdges };
}

/** Create a new document or notebook in the Inbox seeded with the
 *  current selection. Title is the same `Extracted-…` stamp regardless
 *  of type, picked off `makeStamp()`. */
export async function createNewFromSelected(state) {
  const inNotebook = !!state.currentNotebookFileId;
  const title = `Extracted-${makeStamp()}`;

  if (inNotebook) {
    const sel = await getNotebookSelection();
    if (!sel) return;
    const created = await state.createNotebook(title, null, { openImmediately: false });
    if (!created) return;
    const { encodeNotebookContent } = await import("./notebook/notebook-content.ts");
    const content = encodeNotebookContent({ shapes: sel.shapes, flowEdges: sel.edges });
    try { await tauriInvoke("save_file", { id: created.fileId, content }); }
    catch (e) { console.error("Failed to seed extracted notebook:", e); return; }
    await state.openNotebook(created.fileId);
  } else {
    const text = getDocSelection(state);
    if (!text) return;
    const created = await state.newFile(null, { openImmediately: false });
    if (!created) return;
    try { await tauriInvoke("save_file", { id: created.fileId, content: text }); }
    catch (e) { console.error("Failed to seed extracted doc:", e); return; }
    const node = findNodeByFileId(state.fileTree, created.fileId);
    if (node) await renameTreeNode(state, node.id, title);
    await state.openFile(created.fileId);
  }
}

/** Append the current selection to an existing file of the matching
 *  type. Does not open the target. If the target happens to be the
 *  currently open file/notebook the live view is refreshed so the user
 *  sees the appended content immediately. */
export async function sendSelectedToFile(state, target) {
  const inNotebook = !!state.currentNotebookFileId;

  if (inNotebook && target.type === "notebook") {
    const sel = await getNotebookSelection();
    if (!sel) return;
    let file;
    try { file = await tauriInvoke("load_file", { id: target.fileId }); }
    catch (e) { console.error("Failed to load target notebook:", e); return; }
    const { decodeNotebookContent, encodeNotebookContent } = await import("./notebook/notebook-content.ts");
    const existing = decodeNotebookContent(file.content) || { shapes: [] };
    const mergedShapes = [...(existing.shapes || []), ...sel.shapes];
    const mergedEdges = [...(existing.flowEdges || []), ...sel.edges];
    const content = encodeNotebookContent({
      shapes: mergedShapes,
      layers: existing.layers,
      flowEdges: mergedEdges,
    });
    try { await tauriInvoke("save_file", { id: target.fileId, content }); }
    catch (e) { console.error("Failed to write target notebook:", e); return; }
    if (state.currentNotebookFileId === target.fileId) {
      const { reloadNotebookShapes } = await import("./notebook/notebook-bridge.js");
      await reloadNotebookShapes(content);
    }
    // Delete the original shapes from the source notebook now that the
    // copy has landed safely in the target.
    const { getCanvasInstance } = await import("./notebook/notebook-bridge.js");
    const canvas = getCanvasInstance();
    if (canvas?.state) canvas.state.deleteSelected();
    return;
  }

  if (!inNotebook && target.type === "document") {
    const view = state.editor?.view;
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.from === sel.to) return;
    const fromPos = sel.from;
    const toPos = sel.to;
    const text = view.state.sliceDoc(fromPos, toPos);
    let file;
    try { file = await tauriInvoke("load_file", { id: target.fileId }); }
    catch (e) { console.error("Failed to load target doc:", e); return; }
    const existing = file.content || "";
    const sep = existing.length > 0 && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
    const merged = existing + sep + text;
    try { await tauriInvoke("save_file", { id: target.fileId, content: merged }); }
    catch (e) { console.error("Failed to write target doc:", e); return; }
    if (state.currentFileId === target.fileId && state.editor && typeof state.editor.setContent === "function") {
      state.editor.setContent(merged);
    }
    // Delete the original selection from the source editor now that the
    // copy has landed safely in the target. Range was captured up front
    // so an awaited save can't shift it under us.
    view.dispatch({ changes: { from: fromPos, to: toPos, insert: "" } });
  }
}
