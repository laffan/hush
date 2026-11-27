/**
 * To-do list — the list itself, mountable anywhere. Two hosts use it:
 * the floating panel (todo-panel.js — ⌘ tapped twice, or "To-do List"
 * in the command palette) and the Desk Dashboard's sidebar
 * (sidebar/desk-dashboard.js). The host makes the element and places
 * it; `mountTodoList` fills it and wires it, and `destroy` lets go.
 *
 * Modelled on Things. Top to bottom, in one scrolling column:
 *
 *   - the file section (the panel only, opened over a file —
 *     todo-file-context.js): the file's to-do, open, or a draft of one
 *     titled "Changes to <name>", which is kept only once it has a note
 *     or a sub-to-do;
 *   - the composer (todo-composer.js): a new to-do laid out as one —
 *     title, notes, and a file search and desk menu to say where it goes;
 *   - the list (todo-item-html.js): the primed and active block, the
 *     desks, and Completed at the foot.
 *
 * A to-do is a status toggle, a title, a markdown note (todo-notes.js)
 * and sub-to-dos, each with the same toggle and the same Start timer as
 * a to-do (todo-status.js). Clicking a to-do opens it: its note becomes
 * an editor and all its sub-to-dos show. A closed one shows only the
 * sub-to-dos under way — the primed or active ones that put it in the
 * top block.
 *
 * Keys in a title: Enter adds an item below, Backspace in an empty one
 * removes it, ↑ / ↓ at either end step between items, Tab goes to the
 * note. In a note, Tab goes to the sub-to-dos and ⇧Tab back to the
 * title. In a sub-to-do, Enter adds one below, Backspace in an empty one
 * removes it, ↑ / ↓ step between them. Escape leaves a field; an Escape
 * anywhere else in the list is the host's (`onEscape`).
 *
 * The model is todo-store.js. Text edits write through `commitSoon`
 * without re-rendering (it would take the field out from under the
 * caret); every structural change renders and puts the focus back.
 *
 * Only one list is live at a time: the dashboard closes the floating
 * panel when it opens, and while the dashboard's list is mounted the
 * panel's toggle goes to it instead (`embeddedTodoList`). A list ignores
 * the `todos-changed` its own commits fire, so two live lists would not
 * see each other's edits.
 */
import { wireTodoDrag } from "./todo-drag.js";
import {
  readTodos, subsOf, linkedNode, fileTodo, patchInPlace, patchSubInPlace, commitSoon, flushTodos, addTodo,
  removeTodo, addSubs, removeSub, pruneEmptySubs, makeSub, clickTodo, startTimerFor, setTodoDesk, linkTodoFile,
  unlinkTodoFile, createTodoFile,
} from "./todo-store.js";
import { openTodoSearch } from "./todo-search.js";
import { statusOf, clickAction } from "./todo-status.js";
import { CROSS, paintStatus, previewStatus, bodyHtml, fileSectionHtml } from "./todo-item-html.js";
import { mountNotes, notesEditorOf, notesPreviewHtml } from "./todo-notes.js";
import { mountComposer } from "./todo-composer.js";
import { contextFile, draftTitle, DRAFT_ID } from "./todo-file-context.js";

/** How long a just-toggled item stays where it is before it moves (to
 *  the top block, or down its desk). */
const SINK_MS = 650;

let embedded = null; // the Desk Dashboard's list, while it is mounted

/** The Desk Dashboard's list while it is on screen, else null. */
export function embeddedTodoList() { return embedded; }

/** Fit a textarea to its text. */
function fit(el) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/** A field the keyboard writes into: a title, a note's editor, a search. */
const isField = (n) => n instanceof HTMLTextAreaElement || n instanceof HTMLInputElement || !!notesEditorOf(n);

/** A pasted line, without the list or checkbox marks it came with. */
const cleanLine = (s) => s.replace(/^\s*(?:[-*+•]\s+)?(?:\[[ xX]?\]\s*)?/, "").trim();

/**
 * Fill `el` with the list and wire it. The host has made `el` and placed
 * it (it must be a positioned box: the item search hangs inside it).
 *
 * @param {object} state
 * @param {HTMLElement} el
 * @param {object} [opts]
 * @param {() => void} [opts.onClose]   Shows a × in the corner that calls it.
 * @param {() => void} [opts.onEscape]  An Escape that isn't a field's.
 * @param {(fileId: string) => void} [opts.onOpenFile]  Before a linked
 *   file opens (the dashboard closes first).
 * @param {boolean} [opts.embedded]  The Desk Dashboard's list — the one
 *   `embeddedTodoList` answers with while it is mounted.
 * @param {boolean} [opts.fileContext]  Show the file section for the
 *   file in front (the floating panel).
 * @returns {{ el, render, focusFirst, focusInput, destroy }}
 */
export function mountTodoList(state, el, {
  onClose = null, onEscape = null, onOpenFile = null, embedded: isEmbedded = false, fileContext = false,
} = {}) {
  el.classList.add("todo-list");
  el.innerHTML = `${onClose ? `<button type="button" class="todo-head-btn todo-close" data-act="close" data-tooltip="Close" aria-label="Close">${CROSS}</button>` : ""}
    <div class="todo-scroll">
      <div class="todo-file-slot"></div>
      <div class="todo-composer-slot"></div>
      <div class="todo-body"></div>
    </div>`;
  const scroller = el.querySelector(".todo-scroll");
  const fileSlot = el.querySelector(".todo-file-slot");
  const body = el.querySelector(".todo-body");

  let openId = null;     // the list item that is open
  let pending = false;   // a render held off while a field had focus
  let search = null;
  let destroyed = false;
  let moveTimer = 0;
  let showCompleted = false; // the Completed section, shut on every open
  let dragging = false;
  let ctx = null;        // the file in front (file section), as last drawn
  let draft = null;      // its draft: { fileId, title }
  const editors = new Map(); // row → its note's editor

  const focusedField = () => {
    const a = document.activeElement;
    return isField(a) && (fileSlot.contains(a) || body.contains(a)) ? a : null;
  };
  const editing = () => dragging || !!search || !!focusedField();

  const itemOf = (node) => node?.closest?.(".todo-item");
  const todoOf = (item) => readTodos(state).find((t) => t.id === item?.dataset.id);
  const rowById = (id) => el.querySelector(`.todo-item[data-id="${CSS.escape(id)}"]`);
  const isDraft = (item) => item?.dataset.id === DRAFT_ID;

  // ── Notes editors: one on each open row ──
  function mountRowNotes(li) {
    const host = li.querySelector(":scope > .todo-main > .todo-notes-field");
    if (!host || editors.has(li)) return;
    const ed = mountNotes(host, {
      value: todoOf(li)?.notes || "",
      placeholder: "Notes",
      onChange: (text) => onNotes(li, text),
    });
    editors.set(li, ed);
  }
  function unmountRowNotes(li) {
    editors.get(li)?.destroy();
    editors.delete(li);
  }
  function unmountAll() {
    for (const ed of editors.values()) ed.destroy();
    editors.clear();
  }

  /** Re-render, then put the focus back: `focus` is `{ id, field, subId,
   *  at }` — `field` "title", "notes" or "sub", `at` a caret offset
   *  ("end" for the end). */
  function render(focus = null) {
    pending = false;
    const scroll = scroller.scrollTop;
    // A button of a row that has the keyboard (Tab onto "Sub-to-do", say)
    // gets it back in the new markup.
    const keep = focus ? null : focusedButton();
    unmountAll();
    ctx = fileContext ? contextFile(state) : null;
    if (!ctx) draft = null;
    else if (draft?.fileId !== ctx.fileId) draft = { fileId: ctx.fileId, title: draftTitle(ctx.name) };
    const pinned = ctx ? fileTodo(state, ctx.fileId) : null;
    fileSlot.innerHTML = ctx ? fileSectionHtml(state, ctx, pinned, draft) : "";
    body.innerHTML = bodyHtml(state, openId, showCompleted, pinned?.id || null);
    for (const t of el.querySelectorAll(".todo-item textarea")) fit(t);
    for (const li of el.querySelectorAll(".todo-item.open")) mountRowNotes(li);
    scroller.scrollTop = scroll;
    if (focus) restoreFocus(focus);
    else if (keep) refocusButton(keep);
  }

  function focusedButton() {
    const a = document.activeElement;
    const li = a instanceof HTMLButtonElement && a.dataset.act ? itemOf(a) : null;
    if (!li || !(fileSlot.contains(li) || body.contains(li))) return null;
    return { id: li.dataset.id, act: a.dataset.act, subId: a.closest(".todo-sub")?.dataset.subId || null };
  }
  function refocusButton({ id, act, subId }) {
    const li = rowById(id);
    const scope = subId ? li?.querySelector(`.todo-sub[data-sub-id="${CSS.escape(subId)}"]`) : li;
    scope?.querySelector(`[data-act="${CSS.escape(act)}"]`)?.focus({ preventScroll: true });
  }
  const renderSoon = () => { if (editing()) pending = true; else render(); };

  function restoreFocus({ id, field = "title", subId = null, at = "end" }) {
    const li = rowById(id);
    if (!li) return;
    if (field === "notes") { editors.get(li)?.focus(at); return; }
    const f = field === "sub"
      ? li.querySelector(`.todo-sub[data-sub-id="${CSS.escape(subId || "")}"] .todo-sub-title`)
      : li.querySelector(":scope > .todo-main > .todo-title");
    if (!f) return;
    f.focus();
    const pos = at === "end" || at == null ? f.value.length : at;
    f.setSelectionRange(pos, pos);
  }

  /** Open a row of the list (the file section's is always open): its
   *  note becomes an editor, its sub-to-dos all show. The row that was
   *  open closes — its preview redrawn, any sub-to-do never written in
   *  dropped. Classes only; nothing re-renders. */
  function setOpen(id) {
    if (openId === id) return;
    const prev = openId ? body.querySelector(`.todo-item[data-id="${CSS.escape(openId)}"]`) : null;
    const prevId = openId;
    openId = id;
    if (prev) {
      prev.classList.remove("open");
      unmountRowNotes(prev);
      const notes = todoOf(prev)?.notes || "";
      prev.querySelector(":scope > .todo-main > .todo-notes-preview").innerHTML = notesPreviewHtml(notes);
      if (pruneEmptySubs(state, prevId)) {
        prev.querySelectorAll(".todo-sub").forEach((r) => { if (!r.querySelector(".todo-sub-title").value.trim()) r.remove(); });
      }
    }
    const li = id ? body.querySelector(`.todo-item[data-id="${CSS.escape(id)}"]`) : null;
    if (li) {
      li.classList.add("open");
      mountRowNotes(li);
      li.querySelectorAll("textarea").forEach(fit);
    }
  }

  /** The file section's draft becomes a to-do — its title, the note
   *  typed so far, and `checklist` — on the file's desk. Returns it. */
  function materialize(li, { notes = "", checklist = [] } = {}) {
    const title = li.querySelector(":scope > .todo-main > .todo-title")?.value.trim() || "";
    const t = addTodo(state, ctx.deskId, { title, notes, fileId: ctx.fileId, fileType: ctx.type, checklist });
    li.dataset.id = t.id;
    li.classList.remove("is-draft");
    paintStatus(li, "inactive");
    return t;
  }

  function onNotes(li, text) {
    if (isDraft(li)) {
      if (!text.trim() || !ctx) return;
      materialize(li, { notes: text });
      // Its tools and toggle are the draft's until the next render; run
      // one as soon as the keyboard leaves it.
      pending = true;
    } else patchInPlace(state, li.dataset.id, { notes: text });
    li.classList.toggle("has-notes", !!text);
    commitSoon(state);
  }

  function add(deskId, afterId = null) {
    if (!deskId) return;
    const t = addTodo(state, deskId, { afterId });
    openId = t.id;
    render({ id: t.id, field: "title" });
  }

  /** A sub-to-do added to a row — to the draft, which that makes a
   *  to-do — after `afterSubId`, with the caret in it. */
  function addSub(li, afterSubId = null) {
    let id = li.dataset.id;
    let subId;
    if (isDraft(li)) {
      if (!ctx) return;
      const sub = makeSub("");
      id = materialize(li, { notes: editors.get(li)?.value() || "", checklist: [sub] }).id;
      subId = sub.id;
    } else subId = addSubs(state, id, [""], afterSubId)[0]?.id;
    if (!subId) return;
    if (body.contains(li)) openId = id;
    render({ id, field: "sub", subId });
  }

  const composer = mountComposer(state, el.querySelector(".todo-composer-slot"), {
    onCreated: () => render(),
  });

  // Buttons on an open row keep the keyboard where it is, so a press on
  // one doesn't close the row out from under the click (WebKit moves the
  // focus off a field on a button press; Chromium onto the button). Not
  // the toggles: a status clicked is the end of an edit, and the row
  // closes and moves as it always has.
  el.addEventListener("mousedown", (e) => {
    const b = e.target instanceof Element ? e.target.closest("button") : null;
    if (b && !b.classList.contains("todo-status") && itemOf(b)?.classList.contains("open") && focusedField()) {
      e.preventDefault();
    }
  });

  // ── Clicks ──
  el.addEventListener("click", async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const btn = t?.closest("[data-act]");
    const item = itemOf(t);
    if (!btn || !el.contains(btn)) {
      // A click anywhere on a row opens it: on a sub-to-do, into that
      // one; on the note, into the note; anywhere else, the title.
      if (!item || isField(t)) return;
      if (body.contains(item)) setOpen(item.dataset.id);
      const sub = t.closest(".todo-sub");
      if (sub) sub.querySelector(".todo-sub-title")?.focus();
      else if (t.closest(".todo-notes-preview, .todo-notes-field")) editors.get(item)?.focus();
      else item.querySelector(":scope > .todo-main > .todo-title")?.focus();
      return;
    }
    const act = btn.dataset.act;
    const todo = todoOf(item);
    const subId = btn.closest(".todo-sub")?.dataset.subId || null;
    if (act === "drag") return; // the grip's press is the drag's (todo-drag.js)
    if (act === "close") { onClose?.(); return; }
    if (act === "toggle-completed") { showCompleted = !showCompleted; render(); return; }
    if (act === "add-here") { add(btn.closest(".todo-group")?.dataset.deskId); return; }
    if (act === "sub-add" && item) { addSub(item); return; }
    if (!todo) return; // the draft has nothing else to act on
    if (act === "cycle") {
      // ⌘-click steps back (⇧-click too). A ⌘-click can't count toward
      // the double-⌘ that toggles the panel: ui/triple-tap.js resets
      // on any pointer press.
      const back = e.metaKey || e.shiftKey;
      const target = subId ? subsOf(todo).find((s) => s.id === subId) : todo;
      const action = target ? clickAction(statusOf(target), back) : null;
      if (!action) return;
      if (action === "delete") {
        // For good — and gone at once: there is nothing left to watch.
        void clickTodo(state, todo.id, back, subId);
        render();
        return;
      }
      // Shown at once where it is (the real state, not the next click's
      // preview, until the pointer leaves); it moves — to the top block,
      // back to its desk, or down into Completed — a moment later.
      paintStatus(btn.closest(".todo-sub") || item, action);
      hover.settled = btn;
      void clickTodo(state, todo.id, back, subId);
      clearTimeout(moveTimer);
      moveTimer = setTimeout(renderSoon, SINK_MS);
    } else if (act === "start-timer") {
      btn.disabled = true;
      btn.textContent = "Timer running";
      await startTimerFor(state, todo.id, subId);
    } else if (act === "sub-delete" && subId) {
      void removeSub(state, todo.id, subId);
      render();
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
      onOpenFile?.(node.fileId);
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

  // ── Reordering ──
  wireTodoDrag(state, body, (on) => {
    dragging = on;
    if (!on && pending) render();
  });

  // ── The toggle's hover preview ──
  // `btn` the toggle under the pointer, `back` whether ⌘ / ⇧ is held,
  // `settled` a toggle just clicked, which shows its new state rather
  // than the next click's until the pointer leaves it.
  const hover = { btn: null, back: false, settled: null };
  const rowOfToggle = (b) => b?.closest(".todo-sub") || itemOf(b);
  /** The to-do or sub-to-do a toggle belongs to (none for the draft's). */
  const itemOfToggle = (b) => {
    const todo = todoOf(itemOf(b));
    const sub = b?.closest(".todo-sub");
    return sub ? subsOf(todo).find((s) => s.id === sub.dataset.subId) : todo;
  };
  const showHover = () => {
    const b = hover.btn;
    const it = itemOfToggle(b);
    if (!b || !it) return;
    if (hover.settled === b) paintStatus(rowOfToggle(b), statusOf(it));
    else previewStatus(b, statusOf(it), hover.back);
  };
  el.addEventListener("pointerover", (e) => {
    const b = e.target instanceof Element ? e.target.closest(".todo-item .todo-status") : null;
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
    const it = itemOfToggle(b);
    if (it && b.isConnected) paintStatus(rowOfToggle(b), statusOf(it));
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

  // ── Typing (titles; the notes write through `onNotes`) ──
  el.addEventListener("input", (e) => {
    const f = e.target;
    if (!(f instanceof HTMLTextAreaElement)) return;
    const item = itemOf(f);
    if (!item) return;
    if (f.classList.contains("todo-sub-title")) { onSubInput(item, f); return; }
    if (!f.classList.contains("todo-title")) return;
    // A title is one line: a pasted break becomes a space.
    if (f.value.includes("\n")) {
      const at = f.selectionStart;
      f.value = f.value.replace(/\n+/g, " ");
      f.setSelectionRange(at, at);
    }
    fit(f);
    if (isDraft(item)) { if (draft) draft.title = f.value; return; }
    patchInPlace(state, item.dataset.id, { title: f.value });
    commitSoon(state);
  });

  /** Typing in a sub-to-do. Pasted lines become a sub-to-do each, as a
   *  list pasted into a Things checklist does. */
  function onSubInput(item, f) {
    const row = f.closest(".todo-sub");
    const id = item.dataset.id;
    const subId = row?.dataset.subId;
    if (!subId) return;
    if (f.value.includes("\n")) {
      const [first, ...rest] = f.value.split(/\r?\n/).map(cleanLine);
      f.value = first;
      patchSubInPlace(state, id, subId, { title: first });
      const more = rest.filter(Boolean);
      if (more.length) {
        const made = addSubs(state, id, more, subId);
        render({ id, field: "sub", subId: made[made.length - 1].id });
        return;
      }
    } else patchSubInPlace(state, id, subId, { title: f.value });
    fit(f);
    commitSoon(state);
  }

  el.addEventListener("focusin", (e) => {
    const item = itemOf(e.target);
    if (item && body.contains(item) && isField(e.target)) setOpen(item.dataset.id);
  });
  el.addEventListener("focusout", () => {
    // After the focus has landed: on a field of a row in the list, that
    // row's focusin has opened it; anywhere else, the open row closes.
    setTimeout(() => {
      if (destroyed || search) return;
      const a = document.activeElement;
      const inList = isField(a) && body.contains(itemOf(a));
      if (!inList) setOpen(null);
      if (pending && !editing()) render();
    }, 0);
  });

  el.addEventListener("keydown", (e) => {
    const f = e.target;
    if (e.key === "Escape") {
      if (search) return; // the search takes its own
      e.preventDefault();
      e.stopPropagation();
      // Out of a title or a note, the keyboard stays in the list (not
      // on <body>, out of its reach), so the next Escape is the host's.
      if (f instanceof HTMLTextAreaElement || notesEditorOf(f)) el.focus({ preventScroll: true });
      else onEscape?.();
      return;
    }
    const item = itemOf(f);
    if (!item) return; // the composer's fields are its own
    const mods = e.metaKey || e.ctrlKey || e.altKey;
    if (notesEditorOf(f)) { onNotesKey(e, item, mods); return; }
    if (!(f instanceof HTMLTextAreaElement)) return;
    if (f.classList.contains("todo-sub-title")) { onSubKey(e, item, f, mods); return; }
    if (f.classList.contains("todo-title")) onTitleKey(e, item, f, mods);
  });

  function onTitleKey(e, item, f, mods) {
    const inList = body.contains(item);
    const todo = todoOf(item);
    if (e.key === "Enter" && !mods && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      // In the list, a new to-do below; in the file section, the note.
      if (inList && todo) add(todo.deskId, todo.id);
      else editors.get(item)?.focus();
    } else if (inList && todo && e.key === "Backspace" && !mods && !f.value && !(todo.notes || "") && !subsOf(todo).length) {
      e.preventDefault();
      const titles = [...body.querySelectorAll(".todo-item .todo-title")];
      const i = titles.indexOf(f);
      const prevId = itemOf(titles[i - 1] || titles[i + 1])?.dataset.id;
      void removeTodo(state, todo.id);
      openId = prevId || null;
      render(prevId ? { id: prevId, field: "title" } : null);
    } else if (inList && (e.key === "ArrowUp" || e.key === "ArrowDown") && !mods && !e.shiftKey) {
      const atEdge = e.key === "ArrowUp" ? f.selectionStart === 0 && f.selectionEnd === 0
        : f.selectionStart === f.value.length;
      if (!atEdge) return;
      const titles = [...body.querySelectorAll(".todo-item .todo-title")];
      const next = titles[titles.indexOf(f) + (e.key === "ArrowUp" ? -1 : 1)];
      if (!next) return;
      e.preventDefault();
      next.focus();
      const at = e.key === "ArrowUp" ? next.value.length : 0;
      next.setSelectionRange(at, at);
    } else if (e.key === "Tab" && !e.shiftKey && !mods) {
      e.preventDefault();
      if (inList) setOpen(item.dataset.id);
      editors.get(item)?.focus();
    }
  }

  function onNotesKey(e, item, mods) {
    if (e.key !== "Tab" || mods) return;
    e.preventDefault();
    if (e.shiftKey) { item.querySelector(":scope > .todo-main > .todo-title")?.focus(); return; }
    const first = item.querySelector(".todo-sub-title");
    if (first) { first.focus(); first.setSelectionRange(first.value.length, first.value.length); }
    else item.querySelector(".todo-sub-add")?.focus();
  }

  function onSubKey(e, item, f, mods) {
    const id = item.dataset.id;
    const row = f.closest(".todo-sub");
    const subId = row?.dataset.subId;
    if (!subId) return;
    const titles = [...item.querySelectorAll(".todo-sub-title")];
    const i = titles.indexOf(f);
    if (e.key === "Enter" && !mods && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      addSub(item, subId);
    } else if (e.key === "Backspace" && !mods && !f.value) {
      e.preventDefault();
      const prev = titles[i - 1]?.closest(".todo-sub")?.dataset.subId;
      void removeSub(state, id, subId);
      render(prev ? { id, field: "sub", subId: prev } : { id, field: "notes" });
    } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !mods && !e.shiftKey) {
      const up = e.key === "ArrowUp";
      const atEdge = up ? f.selectionStart === 0 && f.selectionEnd === 0 : f.selectionStart === f.value.length;
      if (!atEdge) return;
      const next = titles[i + (up ? -1 : 1)];
      if (!next && !up) return;
      e.preventDefault();
      if (!next) { editors.get(item)?.focus(); return; }
      next.focus();
      const at = up ? next.value.length : 0;
      next.setSelectionRange(at, at);
    }
  }

  // ── Outside changes ──
  // A local commit has already been drawn by whoever made it; a pull from
  // another device, a sibling window, a desk renamed or a file renamed
  // has not. Over a file, so has another file coming to the front.
  const onTodos = (info) => { if (!info?.local) renderSoon(); };
  const EVENTS = ["desks-changed", "active-desk-changed", "files-changed", "remote-settings-merged",
    ...(fileContext ? ["file-opened", "notebook-open", "stack-open", "pdf-open", "no-file-state"] : [])];
  state.on("todos-changed", onTodos);
  for (const ev of EVENTS) state.on(ev, renderSoon);

  /** Let go: listeners off, the last typing written. The host takes
   *  the element away. */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    search?.close();
    clearTimeout(moveTimer);
    window.removeEventListener("keydown", onModifier, true);
    window.removeEventListener("keyup", onModifier, true);
    state.off("todos-changed", onTodos);
    for (const ev of EVENTS) state.off(ev, renderSoon);
    if (openId) pruneEmptySubs(state, openId);
    unmountAll();
    composer.destroy();
    void flushTodos(state);
    if (embedded?.el === el) embedded = null;
  }

  function focusFirst() {
    const first = body.querySelector(".todo-item:not(.done) .todo-title");
    if (first) first.focus();
  }

  /** The keyboard into the list's input: over a file, the file's to-do
   *  (its note); else the composer's title. */
  function focusInput() {
    const pinned = fileSlot.querySelector(".todo-item");
    const ed = pinned ? editors.get(pinned) : null;
    if (ed) ed.focus();
    else composer.focus();
  }

  el.tabIndex = -1;
  render();
  const handle = { el, render, focusFirst, focusInput, destroy };
  if (isEmbedded) embedded = handle;
  return handle;
}
