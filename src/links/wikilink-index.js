/**
 * Wikilink resolver — Obsidian-style `[[Note Title]]` links that target
 * docs and notebooks by their tree-node name. The user-facing identifier
 * is the file's display name (the tree node `name`), not its uuid, so
 * link text stays portable across devices and survives sync.
 */

import { findNodeByFileId } from "../state/tree-helpers.js";

const SKIP_TYPES = new Set(["folder", "project", "desk", "image"]);

/** Resolve the active desk's tree node. Returns null when desks haven't
 *  been initialised yet so callers can fall back to the whole tree. */
function getActiveDeskNode(state) {
  const tree = state.fileTree || [];
  const id = state.settings?.activeDeskId;
  if (id) {
    const match = tree.find((n) => n && n.type === "desk" && n.id === id);
    if (match) return match;
  }
  return tree.find((n) => n && n.type === "desk") || null;
}

/** Walk the file tree and collect every linkable note (docs + notebooks)
 *  in the *active desk only*, skipping anything inside that desk's
 *  Trash. A wikilink lives inside a document that belongs to a single
 *  desk; resolving across desks would let a `[[Note]]` typed in Desk A
 *  silently land on a same-named note in Desk B even though the two
 *  desks are otherwise sealed from each other (sidebar, file picker,
 *  Send Selected, sync). Returns:
 *    [{ nodeId, fileId, name, type, path }]
 *  where `path` is the breadcrumb of containing folders / projects, used
 *  in the search popup to disambiguate same-name notes living in
 *  different parents. */
export function getLinkableNotes(state) {
  const out = [];
  const desk = getActiveDeskNode(state);
  // Pre-desk migrations have a flat tree with no desk node; fall back
  // to walking everything so the popup still functions on first launch.
  const roots = desk ? (desk.children || []) : (state.fileTree || []);
  walk(roots, [], (node, crumb) => {
    if (!node) return;
    const isFileBacked = node.type === "document" || node.type === "notebook"
      || node.type === "stack" || node.type === "pdf";
    const isProject = node.type === "project";
    if (!isFileBacked && !isProject) return;
    if (isFileBacked && !node.fileId) return;
    out.push({
      nodeId: node.id,
      // Projects have no fileId — they're keyed by node.id at open time.
      fileId: node.fileId || null,
      name: node.name || "Untitled",
      type: node.type,
      path: crumb.join(" / "),
    });
  }, (node) => {
    // Don't descend into trash, images folders, or skip-typed nodes.
    if (!node) return false;
    if (state.isSpecialNodeId?.(node.id)) {
      // Inbox is fine; trash / images are not.
      return !(node.id === "__trash__" || node.id?.startsWith?.("__trash__:")
        || node.id === "__images__" || node.id?.startsWith?.("__images__:"));
    }
    return true;
  });
  return out;
}

function walk(nodes, crumb, visit, gate) {
  for (const n of nodes) {
    if (gate && !gate(n)) continue;
    visit(n, crumb);
    if (n.children && n.children.length) {
      const nextCrumb = SKIP_TYPES.has(n.type) ? [...crumb, n.name || ""] : crumb;
      walk(n.children, nextCrumb, visit, gate);
    }
  }
}

/** Case-insensitive name lookup. Returns the first match — same-type
 *  siblings of the same parent can't collide (see uniqueChildName), but
 *  two notes in different parents might share a title; the first hit
 *  wins, which is what Obsidian does too. */
export function resolveWikilink(state, title) {
  if (!title) return null;
  const t = title.trim().toLowerCase();
  if (!t) return null;
  const notes = getLinkableNotes(state);
  for (const n of notes) {
    if (n.name.toLowerCase() === t) return n;
  }
  return null;
}

/** Open the note referenced by `title`. Returns true if a target was
 *  found and opened, false if the link is broken. */
export async function openWikilink(state, title) {
  const note = resolveWikilink(state, title);
  if (!note) return false;
  if (note.type === "notebook") {
    await state.openNotebook(note.fileId);
  } else if (note.type === "stack") {
    await state.openStack(note.fileId);
  } else if (note.type === "pdf") {
    await state.openPdf(note.fileId);
  } else if (note.type === "project") {
    await state.openProject(note.nodeId);
  } else {
    await state.openFile(note.fileId);
  }
  return true;
}

/** Open the note referenced by `title` as a floating pane in the current
 *  context. Projects aren't pane-hostable, so they fall back to a normal
 *  open. Returns true if a target was found, false if the link is broken. */
export async function openWikilinkAsPane(state, title) {
  const note = resolveWikilink(state, title);
  if (!note) return false;
  if (note.type === "project" || !note.fileId) {
    // Projects can't be panes — fall back to opening in place.
    return openWikilink(state, title);
  }
  const { createPane } = await import("../pane/pane-manager.js");
  // Anchor the new pane near the viewport centre so it lands somewhere
  // visible regardless of which surface (doc, notebook) opened it.
  const cx = (typeof window !== "undefined" ? window.innerWidth : 800) / 2;
  const cy = (typeof window !== "undefined" ? window.innerHeight : 600) / 2;
  await createPane(note.fileId, note.name, note.type, cx, cy);
  return true;
}

/** Filter notes by a search query. Case-insensitive substring match
 *  with a small ranking boost for prefix matches so typing `Pro` lands
 *  on `Project Plan` before `Reflections on Procrastination`. */
export function filterNotes(notes, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return notes.slice(0, 50);
  const hits = [];
  for (const n of notes) {
    const lower = n.name.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx < 0) continue;
    // Prefix matches sort first; otherwise by match position.
    hits.push({ n, score: idx === 0 ? -1 : idx });
  }
  hits.sort((a, b) => a.score - b.score);
  return hits.slice(0, 50).map((h) => h.n);
}

/** Return the active doc/notebook's tree node, or null. Used so the
 *  search popup can hide the current file from its own results — you
 *  rarely want to link a note to itself. */
export function getActiveNoteNodeId(state) {
  if (state.currentNotebookFileId) {
    const node = findNodeByFileId(state.fileTree, state.currentNotebookFileId);
    return node?.id || null;
  }
  if (state.currentFileId) {
    const node = findNodeByFileId(state.fileTree, state.currentFileId);
    return node?.id || null;
  }
  return null;
}

/** Escape `s` so it can be embedded inside a `new RegExp(…)` literal. */
export function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
