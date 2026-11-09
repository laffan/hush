/**
 * To-do list — the panel. App-wide: it flies in from the right, floating
 * 20 px inside the window's edges with every corner showing, over
 * everything but the modal band (`--z-todo`). ⌘ tapped twice
 * (triple-tap-triggers.js) or "To-do List" in the command palette
 * toggles it; Escape closes it.
 *
 * Modelled on Things: a list grouped under headings — here, desks; the
 * desk in front first, then the others that have something on them — a
 * status toggle and a title per item, and a note under the title for
 * when there is more to say. Clicking an item opens it: the note appears
 * and is typed into.
 *
 * The toggle steps through inactive → primed → active → complete
 * (todo-status.js; ⌘-click steps back). Primed and active to-dos leave
 * their desks for a block at the top of the list — the active one first,
 * inverted — each tagged with its desk; completed ones fade and sink to
 * the bottom of theirs. A title ending in a length (`30m`, `1h33m`)
 * starts the focus timer when its to-do becomes active.
 *
 * In place of a heading, the head is a search across every file on
 * every desk (todo-search.js#mountFileSearch): picking a file adds an
 * empty to-do on that file's desk, linked to it, with the caret in its
 * title. The panel opens with the keyboard in that field.
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
  readTodos, linkedNode, patchInPlace, commitSoon, flushTodos, addTodo, removeTodo, clickTodo, startTimerFor,
  setTodoDesk, linkTodoFile, unlinkTodoFile, createTodoFile,
} from "./todo-store.js";
import { openTodoSearch, mountFileSearch } from "./todo-search.js";
import { statusOf, clickAction, statusIcon, statusLabel, parseDuration, todoTimerRunning } from "./todo-status.js";

const SEARCH = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25 13.5 13.5"/></svg>`;
const PLUS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>`;
const CROSS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>`;

/** How long a just-toggled item stays where it is before it moves (to
 *  the top block, or down its desk). */
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

/** The block at the top: the active to-do, then the primed ones, from
 *  every desk, in list order. */
function nowItems(state) {
  const todos = readTodos(state);
  return [...todos.filter((t) => statusOf(t) === "active"), ...todos.filter((t) => statusOf(t) === "primed")];
}

/** The groups to show, in order: the desk in front (always, so there is
 *  somewhere to add), then every other desk with a to-do, in the user's
 *  desk order, then to-dos whose desk is gone. Only to-dos not yet
 *  started: primed and active ones are in the top block, completed ones
 *  in the Completed section at the foot. */
function groups(state) {
  const todos = readTodos(state).filter((t) => statusOf(t) === "inactive");
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

/** Draw a to-do's status onto its row (and its toggle). */
function paintStatus(li, status) {
  for (const s of ["inactive", "primed", "active", "complete"]) li.classList.toggle(`is-${s}`, s === status);
  li.classList.toggle("done", status === "complete");
  const btn = li.querySelector(".todo-status");
  if (!btn) return;
  btn.innerHTML = statusIcon(status);
  btn.classList.remove("previewing", "will-delete", "no-action");
  btn.dataset.tooltip = statusLabel(status);
  btn.setAttribute("aria-label", statusLabel(status));
}

/** Hovering a toggle shows what a click will do — the state it would
 *  move to, as ⌘ / ⇧ say (back) or don't (forward); the red trash can
 *  on a completed to-do; the icon dimmed where a click does nothing
 *  (back from inactive). */
function previewStatus(btn, status, back) {
  const action = clickAction(status, back);
  btn.innerHTML = statusIcon(action || status);
  btn.classList.add("previewing");
  btn.classList.toggle("will-delete", action === "delete");
  btn.classList.toggle("no-action", !action);
  btn.dataset.tooltip = statusLabel(status, back);
  btn.setAttribute("aria-label", statusLabel(status, back));
}

function itemHtml(state, t, openId, { showDesk = false } = {}) {
  const node = linkedNode(state, t);
  const notes = t.notes || "";
  const status = statusOf(t);
  const cls = ["todo-item", `is-${status}`];
  if (status === "complete") cls.push("done");
  if (t.id === openId) cls.push("open");
  if (notes) cls.push("has-notes");
  const file = node
    ? `<span class="todo-file"><button type="button" class="todo-file-open" data-act="open-file" data-tooltip="Open">${leafIcon({ ...node, type: node.type })}<span class="todo-file-name">${escHtml(node.name)}</span></button><button type="button" class="todo-file-unlink" data-act="unlink" data-tooltip="Unlink" aria-label="Unlink file">${CROSS}</button></span>`
    : "";
  // In the top block an item is away from its desk's heading, so it
  // says which desk it belongs to.
  const desk = showDesk ? `<span class="todo-desk-tag">${escHtml(deskName(state, t.deskId))}</span>` : "";
  // An active to-do whose title ends in a length offers its timer, at
  // the right of the line under the title.
  const length = status === "active" ? parseDuration(t.title) : null;
  const running = length && todoTimerRunning(state, t);
  const timerBtn = length
    ? `<button type="button" class="todo-timer" data-act="start-timer"${running ? " disabled" : ""}>${running ? "Timer running" : "Start timer"}</button>`
    : "";
  const meta = file || desk || timerBtn ? `<span class="todo-meta">${desk}${file}${timerBtn}</span>` : "";
  return `<li class="${cls.join(" ")}" data-id="${escHtml(t.id)}">
    <button type="button" class="todo-status" data-act="cycle" data-tooltip="${statusLabel(status)}" aria-label="${statusLabel(status)}">${statusIcon(status)}</button>
    <div class="todo-main">
      <textarea class="todo-title" rows="1" placeholder="New To-Do" spellcheck="false" aria-label="To-do">${escHtml(t.title || "")}</textarea>
      <textarea class="todo-notes" rows="1" placeholder="Notes" aria-label="Notes">${escHtml(notes)}</textarea>
      ${meta}
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

/** Completed to-dos, the most recently completed first. */
function completedItems(state) {
  return readTodos(state).filter((t) => statusOf(t) === "complete")
    .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
}

/** The foot of the list: "Completed · n", and — while open — the
 *  completed to-dos, each tagged with its desk. Nothing when there are
 *  none. */
function completedHtml(state, openId, shown) {
  const items = completedItems(state);
  if (!items.length) return "";
  return `<section class="todo-completed${shown ? " shown" : ""}">
    <button type="button" class="todo-completed-toggle" data-act="toggle-completed" aria-expanded="${shown}">Completed · ${items.length}</button>
    ${shown ? `<ul class="todo-items">${items.map((t) => itemHtml(state, t, openId, { showDesk: true })).join("")}</ul>` : ""}
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
      <span class="todo-find">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25 13.5 13.5"/></svg>
        <input class="todo-find-input" type="search" placeholder="New To-Do for a file…" spellcheck="false" autocomplete="off" aria-label="Find a file to make a to-do for" />
      </span>
      <button type="button" class="todo-head-btn" data-act="add" data-tooltip="New To-Do" aria-label="New To-Do">${PLUS}</button>
      <button type="button" class="todo-head-btn" data-act="close" data-tooltip="Close" aria-label="Close">${CROSS}</button>
      <div class="todo-find-results" role="listbox" hidden></div>
    </header>
    <div class="todo-body"></div>`;
  document.body.appendChild(el);
  const body = el.querySelector(".todo-body");
  const find = el.querySelector(".todo-find-input");

  let openId = null;     // the item showing its note
  let pending = false;   // a render held off while a field had focus
  let search = null;
  let closing = false;
  let moveTimer = 0;
  let showCompleted = false; // the Completed section, shut on every open

  const editing = () => !!el.querySelector(".todo-title:focus, .todo-notes:focus") || !!search;

  /** Re-render, then put the focus back: `focus` is `{ id, field, at }`,
   *  `at` a caret offset ("end" for the end). */
  function render(focus = null) {
    pending = false;
    const scroll = body.scrollTop;
    const now = nowItems(state);
    body.innerHTML = (now.length
      ? `<ul class="todo-items todo-now">${now.map((t) => itemHtml(state, t, openId, { showDesk: true })).join("")}</ul>`
      : "") + groups(state).map((g) => groupHtml(state, g, openId)).join("")
      + completedHtml(state, openId, showCompleted);
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

  // The header's search: a file picked there gets an empty to-do, on its
  // desk, linked to it — caret in the title.
  mountFileSearch(state, find, el.querySelector(".todo-find-results"), (leaf) => {
    const t = addTodo(state, leaf.deskId, { fileId: leaf.fileId, fileType: leaf.type });
    openId = t.id;
    render({ id: t.id, field: "title" });
  });

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
    if (act === "toggle-completed") { showCompleted = !showCompleted; render(); return; }
    if (act === "add") { add(state.settings?.activeDeskId || groups(state)[0]?.deskId); return; }
    if (act === "add-here") { add(btn.closest(".todo-group")?.dataset.deskId); return; }
    if (!todo) return;
    if (act === "cycle") {
      // ⌘-click steps back (⇧-click too). A ⌘-click can't count toward
      // the double-⌘ that toggles this panel: ui/triple-tap.js resets
      // on any pointer press.
      const back = e.metaKey || e.shiftKey;
      const action = clickAction(statusOf(todo), back);
      if (!action) return;
      if (action === "delete") {
        // For good — and gone at once: there is nothing left to watch.
        void clickTodo(state, todo.id, back);
        render();
        return;
      }
      // Shown at once where it is (the real state, not the next click's
      // preview, until the pointer leaves); it moves — to the top block,
      // back to its desk, or down into Completed — a moment later.
      paintStatus(item, action);
      hover.settled = btn;
      void clickTodo(state, todo.id, back);
      clearTimeout(moveTimer);
      moveTimer = setTimeout(renderSoon, SINK_MS);
    } else if (act === "start-timer") {
      btn.disabled = true;
      btn.textContent = "Timer running";
      await startTimerFor(state, todo.id);
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

  // ── The toggle's hover preview ──
  // `btn` the toggle under the pointer, `back` whether ⌘ / ⇧ is held,
  // `settled` a toggle just clicked, which shows its new state rather
  // than the next click's until the pointer leaves it.
  const hover = { btn: null, back: false, settled: null };
  const showHover = () => {
    const b = hover.btn;
    const todo = todoOf(itemOf(b));
    if (!b || !todo) return;
    if (hover.settled === b) paintStatus(itemOf(b), statusOf(todo));
    else previewStatus(b, statusOf(todo), hover.back);
  };
  el.addEventListener("pointerover", (e) => {
    const b = e.target instanceof Element ? e.target.closest(".todo-status") : null;
    if (!b || b === hover.btn) return;
    hover.btn = b;
    hover.back = e.metaKey || e.shiftKey;
    showHover();
  });
  el.addEventListener("pointerout", (e) => {
    const b = hover.btn;
    if (!b || (e.relatedTarget instanceof Node && b.contains(e.relatedTarget))) return;
    hover.btn = null;
    if (hover.settled === b) hover.settled = null;
    const todo = todoOf(itemOf(b));
    if (todo && b.isConnected) paintStatus(itemOf(b), statusOf(todo));
  });
  // Pressing or letting go of ⌘ / ⇧ while over a toggle flips its preview.
  const onModifier = (e) => {
    if (e.key !== "Meta" && e.key !== "Shift") return;
    const back = e.metaKey || e.shiftKey;
    if (back === hover.back) return;
    hover.back = back;
    if (hover.settled === hover.btn) hover.settled = null;
    if (hover.btn?.isConnected) showHover();
  };
  window.addEventListener("keydown", onModifier, true);
  window.addEventListener("keyup", onModifier, true);

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
    window.removeEventListener("keydown", onModifier, true);
    window.removeEventListener("keyup", onModifier, true);
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
  // Take the keyboard — into the search, so typing after ⌘ ⌘ finds a
  // file — so it stops going into the document and Escape reaches the
  // panel.
  find.focus({ preventScroll: true });

  return { el, close, render, focusFirst };
}
