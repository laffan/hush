/**
 * To-do list — the panel. App-wide: it flies in from the right, floating
 * 20 px inside the window's edges with every corner showing, over
 * everything but the modal band (`--z-todo`). ⌘ tapped twice
 * (triple-tap-triggers.js) or "To-do List" in the command palette
 * toggles it; Escape closes it.
 *
 * Modelled on Things: a list grouped under headings — here, desks; the
 * desk in front first, then the others that have something on them — a
 * round box and a title per item, and a note under the title for when
 * there is more to say. Clicking an item opens it: the note appears and
 * is typed into. Completed items fade and sink to the bottom of their
 * desk.
 *
 * On hover an item offers the magnifying glass (find a desk or a file —
 * todo-search.js — to move or link it), the "+" when it has no file
 * (make one in its desk's Inbox and link it), and delete. A linked file
 * shows under the title; clicking it opens it on its desk.
 *
 * Keys in a title: Enter adds an item below, Backspace in an empty one
 * removes it, ↑ / ↓ at either end step between items, Tab goes to the
 * note. Escape leaves the field, and a second Escape closes the panel.
 *
 * The model is todo-store.js. Text edits write through `commitSoon`
 * without re-rendering (it would take the field out from under the
 * caret); every structural change renders and puts the focus back.
 */
import { escHtml, leafIcon } from "../sidebar/files-panel-shared.js";
import {
  readTodos, linkedNode, patchInPlace, commitSoon, flushTodos, addTodo, removeTodo, toggleDone,
  setTodoDesk, linkTodoFile, unlinkTodoFile, createTodoFile,
} from "./todo-store.js";
import { openTodoSearch } from "./todo-search.js";

const SEARCH = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25 13.5 13.5"/></svg>`;
const PLUS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>`;
const CROSS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>`;

/** How long a just-checked item stays where it is before sinking. */
const SINK_MS = 650;

let panel = null; // the live handle

export function isTodoPanelOpen() { return !!panel; }

export function toggleTodoPanel(state) {
  if (panel) panel.close();
  else openTodoPanel(state);
}

export function openTodoPanel(state) {
  if (panel) { panel.focusFirst(); return; }
  panel = mountPanel(state);
}

export function closeTodoPanel() { panel?.close(); }

function deskName(state, deskId) {
  return (state.settings?.desks || []).find((d) => d.id === deskId)?.name
    || (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId)?.name
    || "Untitled desk";
}

/** The groups to show, in order: the desk in front (always, so there is
 *  somewhere to add), then every other desk with a to-do, in the user's
 *  desk order, then to-dos whose desk is gone. */
function groups(state) {
  const todos = readTodos(state);
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
  // Open items first, completed below, each in list order.
  for (const g of out) g.items = [...g.items.filter((t) => !t.done), ...g.items.filter((t) => t.done)];
  return out;
}

function itemHtml(state, t, openId) {
  const node = linkedNode(state, t);
  const notes = t.notes || "";
  const cls = ["todo-item"];
  if (t.done) cls.push("done");
  if (t.id === openId) cls.push("open");
  if (notes) cls.push("has-notes");
  const file = node
    ? `<span class="todo-file"><button type="button" class="todo-file-open" data-act="open-file" data-tooltip="Open">${leafIcon({ ...node, type: node.type })}<span class="todo-file-name">${escHtml(node.name)}</span></button><button type="button" class="todo-file-unlink" data-act="unlink" data-tooltip="Unlink" aria-label="Unlink file">${CROSS}</button></span>`
    : "";
  return `<li class="${cls.join(" ")}" data-id="${escHtml(t.id)}">
    <button type="button" class="todo-check" data-act="toggle" role="checkbox" aria-checked="${t.done ? "true" : "false"}" aria-label="Done"></button>
    <div class="todo-main">
      <textarea class="todo-title" rows="1" placeholder="New To-Do" spellcheck="false" aria-label="To-do">${escHtml(t.title || "")}</textarea>
      <textarea class="todo-notes" rows="1" placeholder="Notes" aria-label="Notes">${escHtml(notes)}</textarea>
      ${file}
    </div>
    <span class="todo-tools">
      <button type="button" data-act="search" data-tooltip="Find a desk or file" aria-label="Find a desk or file">${SEARCH}</button>
      ${node ? "" : `<button type="button" data-act="new-file" data-tooltip="New document in the desk's Inbox" aria-label="New document in the desk's Inbox">${PLUS}</button>`}
      <button type="button" data-act="delete" data-tooltip="Delete" aria-label="Delete">${CROSS}</button>
    </span>
  </li>`;
}

function groupHtml(state, g, openId) {
  const items = g.items.map((t) => itemHtml(state, t, openId)).join("");
  return `<section class="todo-group" data-desk-id="${escHtml(g.deskId)}">
    <div class="todo-group-head">
      <span class="todo-group-name">${escHtml(g.name)}</span>
      ${g.deskId ? `<button type="button" class="todo-group-add" data-act="add-here" data-tooltip="New To-Do" aria-label="New To-Do on ${escHtml(g.name)}">${PLUS}</button>` : ""}
    </div>
    <ul class="todo-items">${items || `<li class="todo-empty" data-act="add-here">No to-dos</li>`}</ul>
  </section>`;
}

/** Fit a textarea to its text. */
function fit(el) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function mountPanel(state) {
  // Where the keyboard was, to hand it back on close.
  const returnFocus = document.activeElement;
  const el = document.createElement("aside");
  el.className = "todo-panel";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "To-do list");
  el.innerHTML = `<header class="todo-head">
      <span class="todo-heading">To-do</span>
      <button type="button" class="todo-head-btn" data-act="add" data-tooltip="New To-Do" aria-label="New To-Do">${PLUS}</button>
      <button type="button" class="todo-head-btn" data-act="close" data-tooltip="Close" aria-label="Close">${CROSS}</button>
    </header>
    <div class="todo-body"></div>`;
  document.body.appendChild(el);
  const body = el.querySelector(".todo-body");

  let openId = null;     // the item showing its note
  let pending = false;   // a render held off while a field had focus
  let search = null;
  let closing = false;

  const editing = () => !!el.querySelector(".todo-title:focus, .todo-notes:focus") || !!search;

  /** Re-render, then put the focus back: `focus` is `{ id, field, at }`,
   *  `at` a caret offset ("end" for the end). */
  function render(focus = null) {
    pending = false;
    const scroll = body.scrollTop;
    body.innerHTML = groups(state).map((g) => groupHtml(state, g, openId)).join("");
    body.querySelectorAll("textarea").forEach(fit);
    body.scrollTop = scroll;
    if (focus) {
      const f = body.querySelector(`.todo-item[data-id="${CSS.escape(focus.id)}"] .todo-${focus.field || "title"}`);
      if (f) {
        f.focus();
        const at = focus.at === "end" || focus.at == null ? f.value.length : focus.at;
        f.setSelectionRange(at, at);
      }
    }
  }
  const renderSoon = () => { if (editing()) pending = true; else render(); };

  const itemOf = (node) => node?.closest?.(".todo-item");
  const todoOf = (item) => readTodos(state).find((t) => t.id === item?.dataset.id);
  const siblingsTitles = () => [...body.querySelectorAll(".todo-item .todo-title")];

  function setOpen(id) {
    if (openId === id) return;
    openId = id;
    body.querySelectorAll(".todo-item").forEach((li) => li.classList.toggle("open", li.dataset.id === id));
    body.querySelectorAll(".todo-item.open .todo-notes").forEach(fit);
  }

  function add(deskId, afterId = null) {
    if (!deskId) return;
    const t = addTodo(state, deskId, { afterId });
    openId = t.id;
    render({ id: t.id, field: "title" });
  }

  // ── Clicks ──
  el.addEventListener("click", async (e) => {
    const btn = e.target instanceof Element ? e.target.closest("[data-act]") : null;
    const item = itemOf(e.target);
    if (!btn) {
      // A click anywhere on an item opens it, title first.
      if (item && !(e.target instanceof HTMLTextAreaElement)) {
        setOpen(item.dataset.id);
        item.querySelector(".todo-title")?.focus();
      }
      return;
    }
    const act = btn.dataset.act;
    const todo = todoOf(item);
    if (act === "close") { close(); return; }
    if (act === "add") { add(state.settings?.activeDeskId || groups(state)[0]?.deskId); return; }
    if (act === "add-here") { add(btn.closest(".todo-group")?.dataset.deskId); return; }
    if (!todo) return;
    if (act === "toggle") {
      item.classList.toggle("done");
      btn.setAttribute("aria-checked", item.classList.contains("done") ? "true" : "false");
      void toggleDone(state, todo.id);
      setTimeout(renderSoon, SINK_MS);
    } else if (act === "delete") {
      void removeTodo(state, todo.id);
      render();
    } else if (act === "new-file") {
      btn.disabled = true;
      await createTodoFile(state, todo.id);
      render();
    } else if (act === "open-file") {
      const node = linkedNode(state, todo);
      if (!node) return;
      const { openLeafOnItsDesk } = await import("../state/cross-desk.js");
      await openLeafOnItsDesk(state, { fileId: node.fileId, type: node.type, deskId: todo.deskId });
    } else if (act === "unlink") {
      void unlinkTodoFile(state, todo.id);
      render();
    } else if (act === "search") {
      search?.close();
      search = openTodoSearch(state, el, item, todo, (pick) => {
        if (pick.kind === "desk") void setTodoDesk(state, todo.id, pick.deskId);
        else void linkTodoFile(state, todo.id, pick);
        render({ id: todo.id, field: "title" });
      }, () => {
        search = null;
        // Closed without a pick (Escape, a press outside): run a held render.
        if (pending && !editing()) render();
      });
    }
  });

  // ── Typing ──
  el.addEventListener("input", (e) => {
    const f = e.target;
    if (!(f instanceof HTMLTextAreaElement)) return;
    const item = itemOf(f);
    if (!item) return;
    fit(f);
    const field = f.classList.contains("todo-notes") ? "notes" : "title";
    // A title is one line: a pasted break becomes a space.
    if (field === "title" && f.value.includes("\n")) {
      const at = f.selectionStart;
      f.value = f.value.replace(/\n+/g, " ");
      f.setSelectionRange(at, at);
    }
    patchInPlace(state, item.dataset.id, { [field]: f.value });
    item.classList.toggle("has-notes", field === "notes" ? !!f.value : item.classList.contains("has-notes"));
    commitSoon(state);
  });

  el.addEventListener("focusin", (e) => {
    const item = itemOf(e.target);
    if (item && e.target instanceof HTMLTextAreaElement) setOpen(item.dataset.id);
  });
  el.addEventListener("focusout", () => {
    // After the focus has landed: on another item's field, nothing to do.
    setTimeout(() => {
      if (el.contains(document.activeElement) && document.activeElement instanceof HTMLTextAreaElement) return;
      if (search) return;
      setOpen(null);
      if (pending) render();
    }, 0);
  });

  el.addEventListener("keydown", (e) => {
    const f = e.target;
    if (e.key === "Escape") {
      if (search) return; // the search takes its own
      e.preventDefault();
      e.stopPropagation();
      if (f instanceof HTMLTextAreaElement) f.blur();
      else close();
      return;
    }
    if (!(f instanceof HTMLTextAreaElement)) return;
    const item = itemOf(f);
    const todo = todoOf(item);
    if (!todo) return;
    const isTitle = f.classList.contains("todo-title");
    const mods = e.metaKey || e.ctrlKey || e.altKey;
    if (isTitle && e.key === "Enter" && !mods && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      add(todo.deskId, todo.id);
    } else if (isTitle && e.key === "Backspace" && !mods && !f.value && !(todo.notes || "")) {
      e.preventDefault();
      const titles = siblingsTitles();
      const i = titles.indexOf(f);
      const prev = titles[i - 1] || titles[i + 1];
      const prevId = itemOf(prev)?.dataset.id;
      void removeTodo(state, todo.id);
      openId = prevId || null;
      render(prevId ? { id: prevId, field: "title" } : null);
    } else if (isTitle && (e.key === "ArrowUp" || e.key === "ArrowDown") && !mods && !e.shiftKey) {
      const atEdge = e.key === "ArrowUp" ? f.selectionStart === 0 && f.selectionEnd === 0
        : f.selectionStart === f.value.length;
      if (!atEdge) return;
      const titles = siblingsTitles();
      const next = titles[titles.indexOf(f) + (e.key === "ArrowUp" ? -1 : 1)];
      if (!next) return;
      e.preventDefault();
      next.focus();
      const at = e.key === "ArrowUp" ? next.value.length : 0;
      next.setSelectionRange(at, at);
    } else if (isTitle && e.key === "Tab" && !e.shiftKey && !mods) {
      e.preventDefault();
      setOpen(todo.id);
      const n = item.querySelector(".todo-notes");
      n?.focus();
      n?.setSelectionRange(n.value.length, n.value.length);
    } else if (!isTitle && e.key === "Tab" && e.shiftKey && !mods) {
      e.preventDefault();
      item.querySelector(".todo-title")?.focus();
    }
  });

  // ── Outside changes ──
  // A local commit has already been drawn by whoever made it; a pull from
  // another device, a sibling window, a desk renamed or a file renamed
  // has not.
  const onTodos = (info) => { if (!info?.local) renderSoon(); };
  const EVENTS = ["desks-changed", "active-desk-changed", "files-changed", "remote-settings-merged"];
  state.on("todos-changed", onTodos);
  for (const ev of EVENTS) state.on(ev, renderSoon);

  function close() {
    if (closing) return;
    closing = true;
    search?.close();
    state.off("todos-changed", onTodos);
    for (const ev of EVENTS) state.off(ev, renderSoon);
    void flushTodos(state);
    el.classList.remove("shown");
    const done = () => el.remove();
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) done();
    else { el.addEventListener("transitionend", done, { once: true }); setTimeout(done, 400); }
    if (panel?.el === el) panel = null;
    // Give the keyboard back to what was being written in, if it is
    // still there — never to the main editor by default: behind a
    // notebook that is a hidden document.
    if (el.contains(document.activeElement) && returnFocus instanceof HTMLElement && returnFocus.isConnected) {
      returnFocus.focus();
    }
  }

  function focusFirst() {
    const first = body.querySelector(".todo-item:not(.done) .todo-title");
    if (first) first.focus();
  }

  el.tabIndex = -1;
  render();
  // Fly in: one frame at the parked position, then the shown one.
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("shown")));
  // Take the keyboard, so typing stops going into the document and
  // Escape reaches the panel.
  el.focus({ preventScroll: true });

  return { el, close, render, focusFirst };
}
