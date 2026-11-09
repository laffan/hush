/**
 * To-do list — the model.
 *
 * Every to-do belongs to a desk, and may be linked to one file on it:
 *
 *   { id, deskId, title, notes, status, done, doneAt, archivedAt, timerStartedAt,
 *     fileId, fileType, createdAt }
 *
 * `status` is inactive / primed / active / complete (todo-status.js);
 * `done` mirrors "complete or archived" for anything that reads the older field.
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
import { statusOf, nextStatus, applyTimer, startTodoTimer, isFinished } from "./todo-status.js";

const TEXT_SAVE_MS = 400;
let textTimer = 0;

function uid() {
  return "todo-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
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
export function addTodo(state, deskId, { afterId = null, title = "", fileId = null, fileType = null } = {}) {
  const todo = {
    id: uid(), deskId, title, notes: "", status: "inactive", done: false, doneAt: null,
    fileId, fileType: fileId ? fileType || "document" : null, createdAt: Date.now(),
  };
  const list = [...readTodos(state)];
  let at = afterId ? list.findIndex((t) => t.id === afterId) + 1 : 0;
  if (!afterId) {
    // After the last open item on the desk — completed ones sit below.
    list.forEach((t, i) => { if (t.deskId === deskId && !isFinished(statusOf(t))) at = i + 1; });
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

export function removeTodo(state, id) {
  return commit(state, readTodos(state).filter((t) => t.id !== id));
}

/** Set a to-do's status. The list changes in memory at once (the panel
 *  re-renders on it); cancelling a timer it started follows behind.
 *  Making a to-do active sends any other active one back to primed. */
export async function setTodoStatus(state, id, status) {
  const list = readTodos(state);
  const t = list.find((x) => x.id === id);
  if (!t) return;
  const from = statusOf(t);
  if (from === status) return;
  const at = Date.now();
  // `doneAt` is when it was finished — kept through archiving, so the
  // Archived section orders by when the work was done; `archivedAt`
  // only while archived.
  const as = (x, s) => ({
    ...x, status: s, done: isFinished(s),
    doneAt: isFinished(s) ? (isFinished(statusOf(x)) && x.doneAt ? x.doneAt : at) : null,
    archivedAt: s === "archived" ? at : null,
  });
  const demoted = status === "active" ? list.filter((x) => x.id !== id && statusOf(x) === "active") : [];
  void commit(state, list.map((x) => (x.id === id ? as(x, status) : demoted.includes(x) ? as(x, "primed") : x)));
  // Demoted first, so its timer is gone before this one's starts.
  for (const d of demoted) {
    const patch = await applyTimer(state, d, "active", "primed");
    if ("timerStartedAt" in patch) await updateTodo(state, d.id, patch);
  }
  const patch = await applyTimer(state, t, from, status);
  if ("timerStartedAt" in patch) await updateTodo(state, id, patch);
}

/** Start the focus timer for an active to-do's length, and remember it
 *  as this to-do's (so leaving active cancels it). */
export async function startTimerFor(state, id) {
  const t = readTodos(state).find((x) => x.id === id);
  if (!t || statusOf(t) !== "active") return;
  const startedAt = await startTodoTimer(state, t);
  if (startedAt) await updateTodo(state, id, { timerStartedAt: startedAt });
}

/** One step through the states (⌘-click: one step back). */
export function cycleTodo(state, id, dir = 1) {
  const t = readTodos(state).find((x) => x.id === id);
  if (!t) return Promise.resolve();
  return setTodoStatus(state, id, nextStatus(statusOf(t), dir));
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
