/**
 * Courier's message types and, for each, the destinations it can go to.
 *
 * A destination ("location") is a plain row: `{ key, label, group,
 * detail?, action, ...payload }`. `key` is stable across launches so the
 * sheet can reselect the last one used (courier-store.js); `group` is
 * the heading it lists under (a desk's name, "Things", …); `action` and
 * the payload are what courier-send.js#deliver reads.
 *
 * Desks come from the file tree, every desk rather than only the active
 * one: the active desk lists first, the rest in the tree's order. Trash
 * and Archive are left out — nothing is sent to a place things go to
 * be put away.
 */

import { specialNodeId, isSpecialNodeId } from "../state/state-desks.js";
import { shortcutNames } from "./courier-store.js";

export const COURIER_TYPES = [
  { id: "append", label: "Send to a document" },
  { id: "new-doc", label: "Create a new document" },
  { id: "sticky", label: "Create a new sticky" },
  { id: "shortcut", label: "Run a shortcut" },
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

/** Depth-first walk of one desk, handing `visit` each node with the
 *  names of the containers above it. */
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

function documentRows(state) {
  const modified = new Map((state.files || []).map((f) => [f.id, f.modified || 0]));
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
        action: "append",
        fileId: n.fileId,
        _modified: modified.get(n.fileId) || 0,
      });
    });
    // Most recently edited first — the document a note is meant for is
    // usually one that was open a moment ago.
    deskRows.sort((a, b) => b._modified - a._modified);
    rows.push(...deskRows);
  }
  return rows;
}

function containerRows(state) {
  const rows = [];
  for (const desk of orderedDesks(state)) {
    const inboxId = specialNodeId("__inbox__", desk.id);
    rows.push({ key: `parent:${inboxId}`, label: "Inbox", group: desk.name, action: "new-doc", parentId: inboxId });
    walkDesk(desk, (n, path) => {
      if (n.type !== "folder" && n.type !== "project") return;
      if (isSpecialNodeId(n.id)) return;
      rows.push({
        key: `parent:${n.id}`,
        label: n.name || "Untitled",
        detail: [...path, n.type === "project" ? "project" : ""].filter(Boolean).join(" / "),
        group: desk.name,
        action: "new-doc",
        parentId: n.id,
      });
    });
  }
  return rows;
}

async function stickyRows(state) {
  const { canAddFileSticky, canAddProjectSticky } = await import("../sticky/sticky-notes.js");
  const rows = [{ key: "sticky:global", label: "Global", detail: "shows everywhere", group: "Anywhere", action: "sticky", kind: "global" }];
  if (canAddFileSticky(state)) {
    rows.push({ key: "sticky:file", label: "This file", group: "Here", action: "sticky", kind: "file" });
  }
  if (canAddProjectSticky(state)) {
    rows.push({ key: "sticky:project", label: "This project", group: "Here", action: "sticky", kind: "project" });
  }
  for (const desk of orderedDesks(state)) {
    rows.push({ key: `sticky:desk:${desk.id}`, label: desk.name, detail: "desk", group: "Desks", action: "sticky", kind: "desk", target: desk.id });
  }
  return rows;
}

let appleShortcutsPromise = null;

/** The user's Shortcuts, asked of macOS once per session (courier.rs).
 *  Empty on iPad and outside Tauri. */
function listAppleShortcuts() {
  if (!appleShortcutsPromise) {
    appleShortcutsPromise = (async () => {
      if (!window.__TAURI_INTERNALS__) return [];
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const names = await invoke("list_apple_shortcuts");
        return Array.isArray(names) ? names : [];
      } catch (_) { return []; }
    })();
  }
  return appleShortcutsPromise;
}

async function shortcutRows(state) {
  const rows = [
    { key: "things:inbox", label: "New To-Do", detail: "Inbox", group: "Things", action: "things", when: null },
    { key: "things:today", label: "New To-Do", detail: "Today", group: "Things", action: "things", when: "today" },
  ];
  const listed = await listAppleShortcuts();
  const seen = new Set();
  for (const name of [...shortcutNames(state), ...listed]) {
    if (seen.has(name)) continue;
    seen.add(name);
    rows.push({ key: `shortcut:${name}`, label: name, group: "Shortcuts", action: "shortcut", name });
  }
  rows.push({ key: "shortcut:other", label: "Other shortcut…", detail: "type its name", group: "Shortcuts", action: "shortcut", name: null, other: true });
  return rows;
}

export async function buildLocations(state, typeId) {
  switch (typeId) {
    case "append": return documentRows(state);
    case "new-doc": return containerRows(state);
    case "sticky": return stickyRows(state);
    case "shortcut": return shortcutRows(state);
    default: return [];
  }
}

/** Every whitespace-separated term has to appear somewhere in the row. */
export function matchesFilter(row, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return true;
  const hay = `${row.label} ${row.detail || ""} ${row.group || ""}`.toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}
