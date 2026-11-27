/**
 * To-do list — the markup: the rows, the desk groups, the top block,
 * the Completed section and the file section, as strings for
 * todo-list.js to put in place. Pure apart from reading the state;
 * todo-list.js does the wiring.
 *
 * A row is a to-do: its toggle, its title, its note (a rendered preview
 * when closed, the editor's slot when open — todo-notes.js), its
 * sub-to-dos, and a line of meta (its desk, its file, a sub-to-do count,
 * Start timer). Every sub-to-do is in the markup; CSS shows them all on
 * an open row and only the primed and active ones on a closed row —
 * those are why it sits in the top block — so opening and closing a row
 * never needs a render.
 */
import { escHtml, leafIcon, DRAG_HANDLE_SVG } from "../sidebar/files-panel-shared.js";
import { readTodos, linkedNode, subsOf } from "./todo-store.js";
import { statusOf, rankOf, clickAction, statusIcon, statusLabel, parseDuration, todoTimerRunning } from "./todo-status.js";
import { notesPreviewHtml } from "./todo-notes.js";
import { DRAFT_ID } from "./todo-file-context.js";

export const SEARCH = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25 13.5 13.5"/></svg>`;
export const PLUS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>`;
export const CROSS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>`;
const CHECKS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5l1.3 1.3 2.2-2.4M2.5 10.5l1.3 1.3 2.2-2.4M8.5 4.5h5M8.5 10.5h5"/></svg>`;

const DRAFT_TIP = "Add a note or a sub-to-do to keep this to-do";

export function deskName(state, deskId) {
  return (state.settings?.desks || []).find((d) => d.id === deskId)?.name
    || (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId)?.name
    || "Untitled desk";
}

/** The block at the top: the active to-do, then the primed ones, from
 *  every desk, in list order — each counted by its rank, so a to-do with
 *  a sub-to-do under way is here too. `skipId` is the file section's. */
export function nowItems(state, skipId = null) {
  const todos = readTodos(state).filter((t) => t.id !== skipId);
  return [...todos.filter((t) => rankOf(t) === "active"), ...todos.filter((t) => rankOf(t) === "primed")];
}

/** The groups to show, in order: the desk in front (always, so there is
 *  somewhere to add), then every other desk with a to-do, in the user's
 *  desk order, then to-dos whose desk is gone. Only to-dos not yet
 *  started: primed and active ones are in the top block, completed ones
 *  in the Completed section at the foot. */
export function groups(state, skipId = null) {
  const todos = readTodos(state).filter((t) => t.id !== skipId && rankOf(t) === "inactive");
  const active = state.settings?.activeDeskId;
  const desks = (state.settings?.desks || []).map((d) => d.id)
    .filter((id) => (state.fileTree || []).some((n) => n.type === "desk" && n.id === id));
  const order = [active, ...desks.filter((id) => id !== active)].filter(Boolean);
  const known = new Set(order);
  const out = order
    .map((deskId) => ({ deskId, name: deskName(state, deskId), items: todos.filter((t) => t.deskId === deskId) }))
    .filter((g) => g.deskId === active || g.items.length);
  const orphans = todos.filter((t) => !known.has(t.deskId));
  if (orphans.length) out.push({ deskId: "", name: "No desk", items: orphans });
  return out;
}

/** Draw a status onto its row — a to-do's or a sub-to-do's — and its
 *  toggle. */
export function paintStatus(row, status) {
  for (const s of ["inactive", "primed", "active", "complete"]) row.classList.toggle(`is-${s}`, s === status);
  row.classList.toggle("done", status === "complete");
  const btn = row.querySelector(":scope > .todo-status");
  if (!btn) return;
  btn.innerHTML = statusIcon(status);
  btn.classList.remove("previewing", "will-delete", "no-action");
  btn.dataset.tooltip = statusLabel(status);
  btn.setAttribute("aria-label", statusLabel(status));
}

/** Hovering a toggle shows what a click will do — the state it would
 *  move to, as ⌘ / ⇧ say (back) or don't (forward); the red trash can
 *  on a completed one; the icon dimmed where a click does nothing
 *  (back from inactive). */
export function previewStatus(btn, status, back) {
  const action = clickAction(status, back);
  btn.innerHTML = statusIcon(action || status);
  btn.classList.add("previewing");
  btn.classList.toggle("will-delete", action === "delete");
  btn.classList.toggle("no-action", !action);
  btn.dataset.tooltip = statusLabel(status, back);
  btn.setAttribute("aria-label", statusLabel(status, back));
}

/** An active item whose title ends in a length offers its timer. */
function timerHtml(state, item) {
  const length = statusOf(item) === "active" ? parseDuration(item.title) : null;
  if (!length) return "";
  const running = todoTimerRunning(state, item);
  return `<button type="button" class="todo-timer" data-act="start-timer"${running ? " disabled" : ""}>${running ? "Timer running" : "Start timer"}</button>`;
}

function toggleHtml(status, draft = false) {
  const tip = draft ? DRAFT_TIP : statusLabel(status);
  return `<button type="button" class="todo-status${draft ? " no-action" : ""}" data-act="cycle" data-tooltip="${tip}" aria-label="${tip}"${draft ? ' aria-disabled="true"' : ""}>${statusIcon(status)}</button>`;
}

/** One sub-to-do: a toggle, a title, Start timer when it asks for one,
 *  and an × on hover. */
export function subHtml(state, s) {
  const status = statusOf(s);
  const cls = ["todo-sub", `is-${status}`];
  if (status === "complete") cls.push("done");
  return `<li class="${cls.join(" ")}" data-sub-id="${escHtml(s.id)}">
    ${toggleHtml(status)}
    <textarea class="todo-sub-title" rows="1" placeholder="Sub-to-do" spellcheck="false" aria-label="Sub-to-do">${escHtml(s.title || "")}</textarea>
    ${timerHtml(state, s)}
    <button type="button" class="todo-sub-delete" data-act="sub-delete" data-tooltip="Delete" aria-label="Delete sub-to-do">${CROSS}</button>
  </li>`;
}

/**
 * A to-do's row.
 *
 * @param {object} [o]
 * @param {boolean} [o.open]      Open: the note's editor and every sub-to-do.
 * @param {boolean} [o.showDesk]  Away from its desk's heading (the top
 *   block, Completed): say which desk it belongs to.
 * @param {boolean} [o.pinned]    The file section's: always open, its
 *   file named in the section's head rather than under the title.
 * @param {boolean} [o.draft]     The file section's draft (`DRAFT_ID`).
 */
export function itemHtml(state, t, { open = false, showDesk = false, pinned = false, draft = false } = {}) {
  const node = pinned || draft ? null : linkedNode(state, t);
  const notes = t.notes || "";
  const status = statusOf(t);
  const rank = rankOf(t);
  const subs = subsOf(t);
  const cls = ["todo-item", `is-${status}`];
  if (rank !== status) cls.push("is-lifted");
  if (status === "complete") cls.push("done");
  if (open || pinned || draft) cls.push("open");
  if (notes) cls.push("has-notes");
  if (pinned || draft) cls.push("is-pinned");
  if (draft) cls.push("is-draft");
  const file = node
    ? `<span class="todo-file"><button type="button" class="todo-file-open" data-act="open-file" data-tooltip="Open">${leafIcon({ ...node, type: node.type })}<span class="todo-file-name">${escHtml(node.name)}</span></button><button type="button" class="todo-file-unlink" data-act="unlink" data-tooltip="Unlink" aria-label="Unlink file">${CROSS}</button></span>`
    : "";
  const desk = showDesk ? `<span class="todo-desk-tag">${escHtml(deskName(state, t.deskId))}</span>` : "";
  const finished = subs.filter((s) => statusOf(s) === "complete").length;
  const count = subs.length
    ? `<span class="todo-sub-count" data-tooltip="Sub-to-dos done">${CHECKS}${finished}/${subs.length}</span>` : "";
  const timer = timerHtml(state, t);
  const meta = file || desk || count || timer ? `<span class="todo-meta">${desk}${file}${count}${timer}</span>` : "";
  const grip = rank === status && (status === "inactive" || status === "primed") && !pinned && !draft
    ? `<span class="todo-grip" data-act="drag" data-tooltip="Drag to reorder" aria-hidden="true">${DRAG_HANDLE_SVG}</span>` : "";
  const tools = draft ? "" : `<span class="todo-tools">
      <button type="button" data-act="search" data-tooltip="Find a desk or file" aria-label="Find a desk or file">${SEARCH}</button>
      ${node || pinned ? "" : `<button type="button" data-act="new-file" data-tooltip="New document in the desk's Inbox" aria-label="New document in the desk's Inbox">${PLUS}</button>`}
      ${grip}
      <button type="button" data-act="delete" data-tooltip="Delete" aria-label="Delete">${CROSS}</button>
    </span>`;
  return `<li class="${cls.join(" ")}" data-id="${escHtml(draft ? DRAFT_ID : t.id)}">
    ${toggleHtml(status, draft)}
    <div class="todo-main">
      <textarea class="todo-title" rows="1" placeholder="New To-Do" spellcheck="false" aria-label="To-do">${escHtml(t.title || "")}</textarea>
      <div class="todo-notes-preview">${notesPreviewHtml(notes)}</div>
      <div class="todo-notes-field"></div>
      <ul class="todo-checklist">${subs.map((s) => subHtml(state, s)).join("")}</ul>
      <button type="button" class="todo-sub-add" data-act="sub-add">${PLUS}<span>Sub-to-do</span></button>
      ${meta}
    </div>
    ${tools}
  </li>`;
}

export function groupHtml(state, g, openId) {
  const items = g.items.map((t) => itemHtml(state, t, { open: t.id === openId })).join("");
  return `<section class="todo-group" data-desk-id="${escHtml(g.deskId)}">
    <div class="todo-group-head">
      <span class="todo-group-name">${escHtml(g.name)}</span>
      ${g.deskId ? `<button type="button" class="todo-group-add" data-act="add-here" data-tooltip="New To-Do" aria-label="New To-Do on ${escHtml(g.name)}">${PLUS}</button>` : ""}
    </div>
    <ul class="todo-items">${items || `<li class="todo-empty" data-act="add-here">No to-dos</li>`}</ul>
  </section>`;
}

/** Completed to-dos, the most recently completed first. */
export function completedItems(state, skipId = null) {
  return readTodos(state).filter((t) => t.id !== skipId && statusOf(t) === "complete")
    .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
}

/** The foot of the list: "Completed · n", and — while open — the
 *  completed to-dos, each tagged with its desk. Nothing when there are
 *  none. */
export function completedHtml(state, openId, shown, skipId = null) {
  const items = completedItems(state, skipId);
  if (!items.length) return "";
  return `<section class="todo-completed${shown ? " shown" : ""}">
    <button type="button" class="todo-completed-toggle" data-act="toggle-completed" aria-expanded="${shown}">Completed · ${items.length}</button>
    ${shown ? `<ul class="todo-items">${items.map((t) => itemHtml(state, t, { open: t.id === openId, showDesk: true })).join("")}</ul>` : ""}
  </section>`;
}

/** The whole body: the top block, the desks, Completed. */
export function bodyHtml(state, openId, showCompleted, skipId = null) {
  const now = nowItems(state, skipId);
  return (now.length
    ? `<ul class="todo-items todo-now">${now.map((t) => itemHtml(state, t, { open: t.id === openId, showDesk: true })).join("")}</ul>`
    : "") + groups(state, skipId).map((g) => groupHtml(state, g, openId)).join("")
    + completedHtml(state, openId, showCompleted, skipId);
}

/**
 * The file section, over the composer when the panel is opened over a
 * file (todo-file-context.js): the file's name, and under it the file's
 * to-do — `pinned`, the newest open one linked to it — or, without one,
 * the draft (`{ title }`).
 */
export function fileSectionHtml(state, ctx, pinned, draft) {
  const row = pinned
    ? itemHtml(state, pinned, { pinned: true })
    : itemHtml(state, { id: DRAFT_ID, title: draft.title, notes: "", status: "inactive", checklist: [] }, { draft: true });
  return `<section class="todo-file-ctx" aria-label="To-do for ${escHtml(ctx.name)}">
    <div class="todo-file-ctx-head">${leafIcon(ctx.node)}<span class="todo-file-ctx-name">${escHtml(ctx.name)}</span></div>
    <ul class="todo-items">${row}</ul>
  </section>`;
}
