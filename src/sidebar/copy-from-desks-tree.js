/**
 * Tree data + row markup for the "Copy Files from other Desks" modal.
 *
 * Both columns render from the same recursive renderer so a folder in
 * the source list reads exactly like the same folder does in the files
 * sidebar. The left column is built from every desk *except* the active
 * one; the right column is the active desk, with the planned (not-yet-
 * copied) rows interleaved in grey where they'll land.
 */

import { typeIcons, escHtml } from "./files-panel-shared.js";

/** Node types the copier understands. Images are excluded (they're
 *  filename-keyed desk storage, not user-visible files). */
export const COPYABLE_TYPES = new Set(["document", "notebook", "stack", "pdf", "project", "folder"]);

const HIDDEN_SPECIALS = ["__images__", "__trash__"];

export function isHiddenSpecialId(id) {
  const s = String(id || "");
  return HIDDEN_SPECIALS.some((p) => s === p || s.startsWith(p + ":"));
}

export function isContainerType(type) {
  return type === "folder" || type === "project" || type === "desk";
}

/** Icon for a row, matching the sidebar's type glyphs (with the Inbox /
 *  Archive / PDFs specials keeping their own icons). */
function iconFor(node) {
  const id = String(node.id || "");
  if (id === "__inbox__" || id.startsWith("__inbox__:")) return typeIcons.inbox;
  if (id === "__archive__" || id.startsWith("__archive__:")) return typeIcons.archive;
  if (node.type === "folder" && (node.pdfFolder || id.startsWith("__pdfs__"))) return typeIcons.folder;
  return typeIcons[node.type] || typeIcons.document;
}

/** Copy of `nodes` keeping only the types the copier handles, recursed
 *  into containers. Pure — the modal never mutates the live tree. */
export function filterCopyable(nodes) {
  const out = [];
  for (const n of nodes || []) {
    if (!n || !COPYABLE_TYPES.has(n.type)) continue;
    if (isHiddenSpecialId(n.id)) continue;
    out.push({ ...n, children: filterCopyable(n.children) });
  }
  return out;
}

/** Every desk other than the active one, each with its copyable subtree. */
export function buildSourceForest(state) {
  const activeId = state.getActiveDesk?.()?.id || state.settings?.activeDeskId || null;
  return (state.fileTree || [])
    .filter((n) => n?.type === "desk" && n.id !== activeId)
    .map((desk) => ({
      id: desk.id,
      name: desk.name || "Untitled desk",
      children: filterCopyable(desk.children),
    }));
}

/** Prune the forest to nodes matching `query` (a node survives when it
 *  matches or any descendant does). Returns `{ forest, expand }` where
 *  `expand` holds the ids to force open so every hit is visible. */
export function searchForest(forest, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return { forest, expand: null };
  const expand = new Set();
  const walk = (nodes) => {
    const kept = [];
    for (const n of nodes) {
      const kids = walk(n.children || []);
      const self = String(n.name || "").toLowerCase().includes(q);
      if (!self && !kids.length) continue;
      if (kids.length) expand.add(n.id);
      kept.push({ ...n, children: kids });
    }
    return kept;
  };
  const out = [];
  for (const desk of forest) {
    const kids = walk(desk.children || []);
    if (!kids.length) continue;
    expand.add(desk.id);
    out.push({ ...desk, children: kids });
  }
  return { forest: out, expand };
}

const arrow = (open) =>
  `<span class="cfd-arrow${open ? " open" : ""}">${open ? "▾" : "▸"}</span>`;

/**
 * Recursive row markup.
 *
 * @param nodes    array of tree nodes
 * @param opts     { side, expanded:Set, parentId, plan, selection:Set, depth }
 *   - side "src"    — draggable source rows
 *   - side "dst"    — drop-target rows, planned ghosts interleaved
 */
export function renderRows(nodes, opts) {
  const { side, expanded, parentId, depth = 0 } = opts;
  const entries = side === "dst" ? interleavePlan(nodes, parentId, opts.plan || []) : nodes.map((n) => ({ kind: "real", node: n }));
  let html = "";
  let realIndex = 0;
  for (const entry of entries) {
    if (entry.kind === "plan") { html += plannedRow(entry.plan, depth, parentId, realIndex); continue; }
    const node = entry.node;
    const index = realIndex++;
    const container = isContainerType(node.type);
    const kids = node.children || [];
    const open = container && expanded.has(node.id);
    const selected = side === "src" && opts.selection?.has(node.id);
    html += `<div class="cfd-row${selected ? " selected" : ""}" data-node-id="${escHtml(node.id)}"`
      + ` data-parent-id="${escHtml(parentId || "")}" data-index="${index}" data-type="${escHtml(node.type)}"`
      + ` data-container="${container ? 1 : 0}" data-child-count="${kids.length}" data-depth="${depth}"`
      + ` style="--cfd-depth:${depth}">`
      + (container ? arrow(open) : `<span class="cfd-arrow-spacer"></span>`)
      + `<span class="cfd-icon">${iconFor(node)}</span>`
      + `<span class="cfd-name">${escHtml(node.name || "Untitled")}</span>`
      + `</div>`;
    if (container && open) {
      html += renderRows(kids, { ...opts, parentId: node.id, depth: depth + 1 });
    }
  }
  return html;
}

/** Splice the plan's ghost rows into a container's real children at the
 *  slots they were dropped on, keeping drop order within a slot. */
function interleavePlan(nodes, parentId, plan) {
  const out = nodes.map((node) => ({ kind: "real", node }));
  const mine = plan
    .map((p, seq) => ({ p, seq }))
    .filter(({ p }) => p.parentId === parentId)
    .sort((a, b) => (a.p.displayIndex - b.p.displayIndex) || (a.seq - b.seq));
  let offset = 0;
  for (const { p } of mine) {
    const at = Math.min(Math.max(p.displayIndex, 0), nodes.length) + offset;
    out.splice(at, 0, { kind: "plan", plan: p });
    offset++;
  }
  return out;
}

/** A ghost row carries the same parent / index attributes as a real one
 *  so a drop landing on it resolves to the slot it's standing in. */
function plannedRow(plan, depth, parentId, index) {
  return `<div class="cfd-row cfd-planned" data-plan-id="${escHtml(plan.planId)}"`
    + ` data-parent-id="${escHtml(parentId || "")}" data-index="${index}" data-container="0" data-depth="${depth}"`
    + ` style="--cfd-depth:${depth}">`
    + `<span class="cfd-arrow-spacer"></span>`
    + `<span class="cfd-icon">${typeIcons[plan.type] || typeIcons.document}</span>`
    + `<span class="cfd-name">${escHtml(plan.name || "Untitled")}</span>`
    + `<span class="cfd-planned-from">${escHtml(plan.deskName || "")}</span>`
    + `<button type="button" class="cfd-planned-remove" title="Remove from plan">×</button>`
    + `</div>`;
}
