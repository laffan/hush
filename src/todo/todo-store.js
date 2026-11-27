/**
 * To-do list — the model.
 *
 * Every to-do belongs to a desk, and may be linked to one file on it:
 *
 *   { id, deskId, title, notes, status, done, doneAt, timerStartedAt,
 *     fileId, fileType, createdAt, checklist }
 *
 * `status` is inactive / primed / active / complete (todo-status.js);
 * `done` mirrors "complete" for anything that reads the older field.
 * `notes` is markdown. `checklist` is the to-do's sub-to-dos, in order:
 *
 *   [{ id, title, status, done, doneAt, timerStartedAt }]
 *
 * — the same states, the same clicks and the same timer as a to-do's
 * own (todo-status.js). A to-do saved before there were sub-to-dos has
 * no `checklist`; `subsOf` reads that as none.
 *
 * `settings.todos` (`todos` on the Rust side, opaque JSON) is the runtime
 * store, in the user's order. Like desk stickies, each desk's own
 * to-dos are also written into its `.hushdesk` meta (sync/desk-meta.js),
 * so they travel with the desk folder to another device; a pull there
 * replaces that desk's to-dos wholesale and emits `todos-changed`.
 *
 * Every write goes through `commit`, which persists, pushes the desks'
 * meta and emits `todos-changed`. Typing in a title or a note goes
 * through `commitSoon`, debounced, so a keystroke is not a settings
 * write.
 *
 * The structural calls (add, remove, toggle, move, link) change the list
 * in memory *synchronously* and persist behind it: the panel re-renders
 * and moves the focus in the same tick as the Enter that asked for a new
 * item. Awaiting the write first (an IPC round trip, then one per desk
 * for the meta) left a window in which the next keystrokes still went
 * into the previous item.
 */
import { findNodeByFileId } from "../state/tree-helpers.js";
import { deskIdOfFile } from "../state/cross-desk.js";
import { statusOf, clickAction, applyTimer, startTodoTimer } from "./todo-status.js";

const TEXT_SAVE_MS = 400;
let textTimer = 0;

function uid(prefix = "todo-") {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** A to-do's sub-to-dos, always an array. */
export function subsOf(todo) {
  return Array.isArray(todo?.checklist) ? todo.checklist.filter((s) => s && typeof s.id === "string") : [];
}

/** A new sub-to-do, not yet in any list. */
export function makeSub(title = "") {
  return { id: uid("sub-"), title, status: "inactive", done: false, doneAt: null };
}

/** The stored list, always an array of well-formed entries. */
export function readTodos(state) {
  const raw = state.settings?.todos;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t) => t && typeof t.id === "string");
}

/** One desk's to-dos, in list order. */
export function deskTodos(state, deskId) {
  return readTodos(state).filter((t) => t.deskId === deskId);
}

/** The newest open (not completed) to-do linked to `fileId`, or null. */
export function fileTodo(state, fileId) {
  if (!fileId) return null;
  return readTodos(state)
    .filter((t) => t.fileId === fileId && statusOf(t) !== "complete")
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
}

/** The tree node of a to-do's linked file, or null when it has none or
 *  the file is gone (deleted, or on a desk that was archived). */
export function linkedNode(state, todo) {
  if (!todo?.fileId) return null;
  return findNodeByFileId(state.fileTree || [], todo.fileId) || null;
}

/** Persist the list, write each desk's share into its `.hushdesk`, and
 *  tell the panel (and any other listener). `state.settings.todos` is
 *  the new list as soon as this is called (`updateSettings` assigns
 *  before it writes). */
export async function commit(state, list) {
  clearTimeout(textTimer);
  textTimer = 0;
  await state.updateSettings({ todos: list });
  state.emit("todos-changed", { local: true });
  try {
    const { pushAllDeskMeta } = await import("../sync/desk-meta.js");
    await pushAllDeskMeta(state);
  } catch (_) { /* browser dev — no desk folders */ }
}

/** Write text edits after a pause; a structural change flushes them. */
export function commitSoon(state) {
  clearTimeout(textTimer);
  textTimer = setTimeout(() => { textTimer = 0; void commit(state, readTodos(state)); }, TEXT_SAVE_MS);
}

/** Flush a pending text save now (the panel closing, a window hiding). */
export function flushTodos(state) {
  if (!textTimer) return Promise.resolve();
  return commit(state, readTodos(state));
}

/** Change one to-do in memory, without persisting — the text fields'
 *  path, followed by `commitSoon`. */
export function patchInPlace(state, id, patch) {
  const t = readTodos(state).find((x) => x.id === id);
  if (t) Object.assign(t, patch);
}

/** Add a to-do on `deskId`, after `afterId` when given (else at the end
 *  of that desk's open items). Returns the new to-do. */
export function addTodo(state, deskId, {
  afterId = null, title = "", notes = "", fileId = null, fileType = null, checklist = [],
} = {}) {
  const todo = {
    id: uid(), deskId, title, notes, status: "inactive", done: false, doneAt: null,
    fileId, fileType: fileId ? fileType || "document" : null, createdAt: Date.now(), checklist,
  };
  const list = [...readTodos(state)];
  let at = afterId ? list.findIndex((t) => t.id === afterId) + 1 : 0;
  if (!afterId) {
    // After the last open item on the desk — completed ones sit below.
    list.forEach((t, i) => { if (t.deskId === deskId && statusOf(t) !== "complete") at = i + 1; });
    if (at === 0) {
      const firstOfDesk = list.findIndex((t) => t.deskId === deskId);
      at = firstOfDesk >= 0 ? firstOfDesk : list.length;
    }
  }
  list.splice(at, 0, todo);
  void commit(state, list);
  return todo;
}

export function updateTodo(state, id, patch) {
  const list = readTodos(state).map((t) => (t.id === id ? { ...t, ...patch } : t));
  return commit(state, list);
}

/** Patch a to-do, or — with `subId` — one of its sub-to-dos. */
function updateItem(state, id, subId, patch) {
  if (!subId) return updateTodo(state, id, patch);
  return commit(state, readTodos(state).map((t) => (t.id !== id ? t
    : { ...t, checklist: subsOf(t).map((s) => (s.id === subId ? { ...s, ...patch } : s)) })));
}

/** Change a sub-to-do in memory, without persisting — the typing path. */
export function patchSubInPlace(state, id, subId, patch) {
  const s = subsOf(readTodos(state).find((x) => x.id === id)).find((x) => x.id === subId);
  if (s) Object.assign(s, patch);
}

/**
 * Add sub-to-dos to a to-do — one per title — after `afterSubId`, or at
 * the end without one. Synchronous in memory, as `addTodo` is. Returns
 * the new sub-to-dos (none when the to-do is gone).
 */
export function addSubs(state, id, titles = [""], afterSubId = null) {
  const list = readTodos(state);
  const t = list.find((x) => x.id === id);
  if (!t) return [];
  const subs = subsOf(t);
  const made = titles.map((title) => makeSub(title));
  const after = afterSubId ? subs.findIndex((s) => s.id === afterSubId) : -1;
  subs.splice(after >= 0 ? after + 1 : subs.length, 0, ...made);
  void commit(state, list.map((x) => (x.id === id ? { ...x, checklist: subs } : x)));
  return made;
}

export function removeSub(state, id, subId) {
  return commit(state, readTodos(state).map((t) => (t.id !== id ? t
    : { ...t, checklist: subsOf(t).filter((s) => s.id !== subId) })));
}

/** Drop a to-do's sub-to-dos that were never written in — run as the
 *  to-do closes, so an added and abandoned row doesn't linger. */
export function pruneEmptySubs(state, id) {
  const t = readTodos(state).find((x) => x.id === id);
  const subs = subsOf(t);
  if (!subs.some((s) => !(s.title || "").trim())) return false;
  void commit(state, readTodos(state).map((x) => (x.id !== id ? x
    : { ...x, checklist: subs.filter((s) => (s.title || "").trim()) })));
  return true;
}

/**
 * Reorder a set of to-dos — one desk's inactive ones, or the primed
 * ones — to `orderedIds`. The set keeps the places it holds in the list
 * and is laid back into them in the new order, so nothing outside it
 * moves (a desk's completed to-dos, another desk's, the active one).
 */
export function reorderTodos(state, orderedIds) {
  const list = readTodos(state);
  const ids = new Set(orderedIds);
  const slots = [];
  list.forEach((t, i) => { if (ids.has(t.id)) slots.push(i); });
  if (slots.length !== orderedIds.length) return Promise.resolve();
  const byId = new Map(list.map((t) => [t.id, t]));
  const next = [...list];
  slots.forEach((slot, k) => { next[slot] = byId.get(orderedIds[k]); });
  if (next.every((t, i) => t === list[i])) return Promise.resolve();
  return commit(state, next);
}

export function removeTodo(state, id) {
  return commit(state, readTodos(state).filter((t) => t.id !== id));
}

/** A to-do, or one of its sub-to-dos, by id: `{ todo, item }` (item is
 *  the sub-to-do when `subId` is given), or null. */
function findItem(state, id, subId = null) {
  const todo = readTodos(state).find((x) => x.id === id);
  const item = subId ? subsOf(todo).find((s) => s.id === subId) : todo;
  return todo && item ? { todo, item } : null;
}

/**
 * Set the status of a to-do, or — with `subId` — of one of its
 * sub-to-dos. The list changes in memory at once (the panel re-renders
 * on it); cancelling a timer that was running follows behind. Only one
 * thing is active at a time, to-do or sub-to-do: making one active
 * sends whatever else was active back to primed. Completing a to-do
 * does the same to an active sub-to-do inside it — a finished to-do
 * keeps nothing running.
 */
export async function setTodoStatus(state, id, status, subId = null) {
  const found = findItem(state, id, subId);
  if (!found) return;
  const from = statusOf(found.item);
  if (from === status) return;
  const at = Date.now();
  // `doneAt` is when it was completed, and orders the Completed
  // section. `archivedAt` belonged to a state that is gone.
  const as = (x, s) => ({
    ...x, status: s, done: s === "complete", doneAt: s === "complete" ? at : null, archivedAt: undefined,
  });
  const isActive = (x) => statusOf(x) === "active";
  const demoted = []; // { id, subId, item }
  const next = readTodos(state).map((t) => {
    let y = t;
    if (t.id === id && !subId) y = as(t, status);
    else if (status === "active" && isActive(t)) { demoted.push({ id: t.id, subId: null, item: t }); y = as(t, "primed"); }
    const subs = subsOf(t);
    if (!subs.length) return y;
    let touched = false;
    const checklist = subs.map((s) => {
      if (t.id === id && s.id === subId) { touched = true; return as(s, status); }
      const completingOwner = status === "complete" && !subId && t.id === id;
      if ((status === "active" || completingOwner) && isActive(s)) {
        touched = true;
        demoted.push({ id: t.id, subId: s.id, item: s });
        return as(s, "primed");
      }
      return s;
    });
    return touched ? { ...y, checklist } : y;
  });
  void commit(state, next);
  // Demoted first, so its timer is gone before this one's starts.
  for (const d of demoted) {
    const patch = await applyTimer(state, d.item, "active", "primed");
    if ("timerStartedAt" in patch) await updateItem(state, d.id, d.subId, patch);
  }
  const patch = await applyTimer(state, found.item, from, status);
  if ("timerStartedAt" in patch) await updateItem(state, id, subId, patch);
}

/** Start the focus timer for an active to-do's (or sub-to-do's) length,
 *  and remember it as that item's (so leaving active cancels it). */
export async function startTimerFor(state, id, subId = null) {
  const found = findItem(state, id, subId);
  if (!found || statusOf(found.item) !== "active") return;
  const startedAt = await startTodoTimer(state, found.item);
  if (startedAt) await updateItem(state, id, subId, { timerStartedAt: startedAt });
}

/** What a click on the toggle does (`back`: ⌘- or ⇧-click): one step
 *  through the states, or — a plain click on a completed to-do — delete
 *  it for good. A sub-to-do's toggle (`subId`) works the same. Resolves to the action taken ("delete", a status, or
 *  null for none). */
export async function clickTodo(state, id, back = false, subId = null) {
  const found = findItem(state, id, subId);
  if (!found) return null;
  const action = clickAction(statusOf(found.item), back);
  if (action === "delete") await (subId ? removeSub(state, id, subId) : removeTodo(state, id));
  else if (action) await setTodoStatus(state, id, action, subId);
  return action;
}

/** Point a to-do at a desk. A linked file on another desk is dropped:
 *  a to-do and its file are always on the same desk. */
export function setTodoDesk(state, id, deskId) {
  const t = readTodos(state).find((x) => x.id === id);
  if (!t || t.deskId === deskId) return Promise.resolve();
  const keepFile = t.fileId && deskIdOfFile(state, t.fileId) === deskId;
  return updateTodo(state, id, { deskId, ...(keepFile ? {} : { fileId: null, fileType: null }) });
}

/** Link a file (a picker leaf: `{ fileId, type, deskId }`); the to-do
 *  moves to the file's desk. */
export function linkTodoFile(state, id, leaf) {
  return updateTodo(state, id, { fileId: leaf.fileId, fileType: leaf.type || "document", deskId: leaf.deskId });
}

export function unlinkTodoFile(state, id) {
  return updateTodo(state, id, { fileId: null, fileType: null });
}

/** The "+": make a document for the to-do in its desk's Inbox — named
 *  after the to-do, whose title is its first line — and link it. The
 *  document isn't opened; the link opens it. */
export async function createTodoFile(state, id) {
  const t = readTodos(state).find((x) => x.id === id);
  if (!t) return null;
  const title = (t.title || "").trim() || "Untitled";
  const created = await state.newFile(`__inbox__:${t.deskId}`, {
    openImmediately: false,
    initialName: title,
    initialContent: `${title}\n`,
  });
  if (!created?.fileId) return null;
  void updateTodo(state, id, { fileId: created.fileId, fileType: "document" });
  return created;
}
