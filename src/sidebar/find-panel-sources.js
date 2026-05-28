/**
 * Sources for the Find panel — tree walking, content loading, and the
 * per-file search adapters that wrap pure search/snippet helpers around
 * either a markdown doc or a notebook's text shapes.
 */

import { decodeNotebookContent } from "../notebook/notebook-content.ts";
import { getCanvasInstance } from "../notebook/notebook-bridge.js";
import { findMatchesIn, lineAndSnippet } from "./find-panel-search.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Walk the active desk's tree and collect every searchable file along
 *  with the folder / project ancestors so each result row can show its
 *  location underneath the filename. Documents and notebooks are both
 *  searchable — notebooks get JSON-decoded so each text shape's body
 *  can be matched against the query. */
export function collectSearchableFiles(state) {
  const desks = state.fileTree.filter(n => n.type === "desk");
  const active = desks.find(n => n.id === state.settings?.activeDeskId) || desks[0];
  const rootChildren = active ? (active.children || []) : state.fileTree;
  const out = [];
  function walk(nodes, ancestors) {
    for (const n of nodes) {
      if ((n.type === "document" || n.type === "notebook") && n.fileId && !n.useAsNote) {
        out.push({
          fileId: n.fileId,
          name: n.name || "Untitled",
          kind: n.type,
          pathParts: ancestors.slice(),
        });
      }
      if (n.children && (n.type === "folder" || n.type === "project")) {
        walk(n.children, [...ancestors, n.name || (n.type === "project" ? "Project" : "Folder")]);
      } else if (n.children) {
        walk(n.children, ancestors);
      }
    }
  }
  walk(rootChildren, []);
  return out;
}

/** Resolve a file's current text content, preferring live in-memory
 *  state over the on-disk copy: the open editor's buffer for the active
 *  doc, the canvas's live shapes for the active notebook. */
export async function loadContent(state, fileId) {
  if (fileId === state.currentFileId && state.editor) {
    return state.editor.getContent();
  }
  if (fileId === state.currentNotebookFileId) {
    const ci = getCanvasInstance?.();
    if (ci && typeof ci.getShapes === "function") {
      try {
        const shapes = ci.getShapes();
        return JSON.stringify({ format: "hushnote", version: 1, shapes });
      } catch (_) {}
    }
  }
  if (IS_TAURI) {
    try {
      const file = await tauriInvoke("load_file", { id: fileId });
      return file?.content || "";
    } catch (_) { return ""; }
  }
  const f = state.files.find(x => x.id === fileId);
  return f ? f.content : "";
}

/** Persist replacement output for an off-screen doc — the active doc
 *  goes through the editor so undo / dirty tracking flow normally. */
export async function writeDocContent(state, fileId, content) {
  if (IS_TAURI) {
    try { await tauriInvoke("save_file", { id: fileId, content }); }
    catch (e) { console.error("Find replace save failed:", e); return; }
    try {
      state.files = await tauriInvoke("list_files");
      state.syncFileToExternal?.(fileId, content);
    } catch (_) {}
  } else {
    const f = state.files.find(x => x.id === fileId);
    if (f) {
      f.content = content;
      f.modified = Math.floor(Date.now() / 1000);
      state._saveFilesLocal?.();
    }
  }
}

export function searchDocFile(info, query, content, isCurrent, opts) {
  const matches = findMatchesIn(content, query, opts).map(m => ({
    ...m,
    snippet: lineAndSnippet(content, m.from, m.to),
  }));
  if (matches.length === 0) return null;
  return {
    fileId: info.fileId,
    name: info.name,
    kind: "document",
    pathParts: info.pathParts,
    isCurrent,
    content,
    matches,
  };
}

export function searchNotebookFile(info, query, content, isCurrent, opts) {
  let parsed;
  try { parsed = decodeNotebookContent(content); }
  catch (_) { parsed = null; }
  if (!parsed || !Array.isArray(parsed.shapes)) return null;
  const matches = [];
  for (const shape of parsed.shapes) {
    if (!shape || shape.type !== "text" || typeof shape.text !== "string") continue;
    if (shape.headerLabel) continue; // shadow header labels are computed, not user text
    const hits = findMatchesIn(shape.text, query, opts);
    for (const h of hits) {
      matches.push({
        shapeId: shape.id,
        from: h.from,
        to: h.to,
        snippet: lineAndSnippet(shape.text, h.from, h.to),
      });
    }
  }
  if (matches.length === 0) return null;
  return {
    fileId: info.fileId,
    name: info.name,
    kind: "notebook",
    pathParts: info.pathParts,
    isCurrent,
    content,
    matches,
  };
}
