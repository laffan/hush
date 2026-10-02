/**
 * Writing progress — what the Progress modal asks for and how.
 *
 * The tally itself is Rust's (`writing_progress`, src-tauri/src/progress.rs):
 * it reads the version history of every document in scope and diffs one
 * local midnight against the next. This side decides the scope — the
 * project the open document belongs to, or the whole active desk — and
 * the days, as local midnights so a day is the user's day wherever the
 * clocks change.
 */

import { findNode, findNodeByFileId, nearestAncestorProjectId, collectDocumentIds } from "../state/tree-helpers.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

/** The project the main surface is working in: the open project
 *  buffer, else the nearest real project above the open document. */
export function currentProjectNode(state) {
  const tree = state.fileTree || [];
  if (state.currentProjectId) {
    const n = findNode(tree, state.currentProjectId);
    if (n?.type === "project") return n;
  }
  if (!state.currentFileId) return null;
  const doc = findNodeByFileId(tree, state.currentFileId);
  if (!doc) return null;
  const pid = nearestAncestorProjectId(tree, doc.id);
  return pid ? findNode(tree, pid) : null;
}

/** What a scope covers: every document under `root` (notes included —
 *  they are writing too), and every project there with the documents its
 *  joined buffer holds, so the tally can read its buffer's snapshots. */
function collectScope(root, { skipTrash }) {
  const files = [];
  const projects = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (skipTrash && typeof n.id === "string" && n.id.startsWith("__trash__")) continue;
      if (n.type === "document" && n.fileId) {
        files.push({ id: n.fileId, name: n.name || "Untitled", createdMs: n.createdAt ? n.createdAt * 1000 : null });
      }
      if (n.type === "project") projects.push({ id: n.id, docIds: collectDocumentIds(n.children || []) });
      if (n.children) walk(n.children);
    }
  };
  if (root.type === "project") projects.push({ id: root.id, docIds: collectDocumentIds(root.children || []) });
  walk(root.children);
  return { files, projects };
}

/** `{ kind, title, files, projects }` for "project" or "desk", or null
 *  when there is no such scope right now. */
export function resolveScope(state, kind) {
  if (kind === "project") {
    const node = currentProjectNode(state);
    if (!node) return null;
    return { kind, title: node.name || "Project", ...collectScope(node, { skipTrash: true }) };
  }
  const node = state.getActiveDesk?.();
  if (!node) return null;
  return { kind, title: node.name || "Desk", ...collectScope(node, { skipTrash: true }) };
}

/** Local midnights from the first of `month` to the first of the next:
 *  one more entry than the month has days. */
export function monthDayStarts(year, month) {
  const out = [];
  const days = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= days + 1; d++) out.push(new Date(year, month, d).getTime());
  return out;
}

/** Words added on each day of the month: `[{ dayStart, total, files:
 *  [{ id, added, sections: [{ title, added }] }] }]`, one per day. */
export async function loadMonthProgress(scope, year, month) {
  const dayStarts = monthDayStarts(year, month);
  if (!IS_TAURI) {
    return dayStarts.slice(0, -1).map((dayStart) => ({ dayStart, total: 0, files: [] }));
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("writing_progress", {
    request: { files: scope.files, projects: scope.projects, dayStarts },
  });
}
