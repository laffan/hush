/**
 * What Courier can make, and where it can put it.
 *
 * Two modes: a **Sticky** (scoped to a document, a desk, or global) and
 * an **Append** (a new paragraph at the end of a document). A
 * destination row is `{ key, label, group, detail?, fileId? | deskId? }`
 * — `key` is stable across launches so the sheet can reselect the last
 * one used (courier-store.js).
 *
 * Desks come from the file tree, every desk rather than only the active
 * one: the active desk lists first, the rest in the tree's order. Trash,
 * Archive, Images and PDFs are left out.
 */

import { isSpecialNodeId } from "../state/state-desks.js";

export const MODES = [
  { id: "sticky", label: "Sticky" },
  { id: "append", label: "Append" },
];

export const STICKY_SCOPES = [
  { id: "document", label: "Document" },
  { id: "desk", label: "Desk" },
  { id: "global", label: "Global" },
];

const EXCLUDED_KINDS = ["__trash__", "__archive__", "__images__", "__pdfs__"];

function isExcludedSpecial(id) {
  return EXCLUDED_KINDS.some((k) => id === k || id.startsWith(k + ":"));
}

function orderedDesks(state) {
  const desks = (state.fileTree || []).filter((n) => n.type === "desk");
  const activeId = state.getActiveDesk?.()?.id;
  return [...desks.filter((d) => d.id === activeId), ...desks.filter((d) => d.id !== activeId)];
}

function walkDesk(desk, visit) {
  const walk = (nodes, path) => {
    for (const n of nodes || []) {
      if (isSpecialNodeId(n.id) && isExcludedSpecial(n.id)) continue;
      visit(n, path);
      if (n.children?.length) walk(n.children, [...path, n.name]);
    }
  };
  walk(desk.children, []);
}

/** Every document, grouped by desk. The one on screen leads its desk,
 *  then most recently edited — the document a note is meant for is
 *  usually one that was open a moment ago. */
function documentRows(state) {
  const modified = new Map((state.files || []).map((f) => [f.id, f.modified || 0]));
  const current = state.currentFileId;
  const rank = (r) => (r.fileId === current ? Infinity : r._modified);
  const rows = [];
  for (const desk of orderedDesks(state)) {
    const deskRows = [];
    walkDesk(desk, (n, path) => {
      if (n.type !== "document" || !n.fileId) return;
      deskRows.push({
        key: `doc:${n.fileId}`,
        label: n.name || "Untitled",
        detail: path.join(" / "),
        group: desk.name,
        fileId: n.fileId,
        _modified: modified.get(n.fileId) || 0,
      });
    });
    deskRows.sort((a, b) => rank(b) - rank(a));
    rows.push(...deskRows);
  }
  return rows;
}

function deskRows(state) {
  return orderedDesks(state).map((d) => ({ key: `desk:${d.id}`, label: d.name, group: "Desks", deskId: d.id }));
}

/** Rows for a mode (and, for a sticky, its scope). A global sticky has
 *  nowhere to choose, so it gets none. */
export function buildLocations(state, mode, scope) {
  if (mode === "append") return documentRows(state);
  if (scope === "document") return documentRows(state);
  if (scope === "desk") return deskRows(state);
  return [];
}

/** Every whitespace-separated term has to appear somewhere in the row. */
export function matchesFilter(row, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return true;
  const hay = `${row.label} ${row.detail || ""} ${row.group || ""}`.toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}
