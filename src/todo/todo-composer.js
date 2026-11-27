/**
 * The To-do list's composer — the new to-do at the top of the list,
 * laid out as a to-do is: a (blank) box, a title, notes (markdown,
 * todo-notes.js) and, under the notes, where it goes:
 *
 *   - a search field that attaches a file, from any desk
 *     (todo-search.js#mountFileSearch — the one that used to be the
 *     list's whole head). A picked file shows in its place, with an ×.
 *   - a desk button at its right, which drops down the desks: a to-do can
 *     go to a desk without a file. A file moves the to-do to the file's
 *     desk; picking another desk lets go of a file on a different one —
 *     a to-do and its file are always on the same desk.
 *
 * Nothing is needed but something to keep: Enter in the title (or ⌘↩
 * in the notes, or Enter in an empty search field) adds the to-do — to
 * the chosen desk, else the file's, else the desk in front — once it has
 * a title, a note or a file. The composer then clears and keeps the
 * keyboard, ready for the next one.
 */
import { escHtml, leafIcon, typeIcons } from "../sidebar/files-panel-shared.js";
import { addTodo } from "./todo-store.js";
import { mountFileSearch } from "./todo-search.js";
import { mountNotes } from "./todo-notes.js";
import { statusIcon } from "./todo-status.js";

const SEARCH = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25 13.5 13.5"/></svg>`;
const CROSS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>`;

/** The desks a to-do can go to, in the user's order. */
export function deskChoices(state) {
  const onTree = new Set((state.fileTree || []).filter((n) => n.type === "desk").map((n) => n.id));
  return (state.settings?.desks || []).filter((d) => onTree.has(d.id))
    .map((d) => ({ deskId: d.id, name: d.name || "Untitled desk" }));
}

const deskNameOf = (state, id) => deskChoices(state).find((d) => d.deskId === id)?.name || "Untitled desk";

/**
 * Mount the composer into `host`.
 *
 * @param {object} state
 * @param {HTMLElement} host
 * @param {object} [opts]
 * @param {(todo: object) => void} [opts.onCreated]  After a to-do is added.
 * @returns {{ el, focus(): void, destroy(): void }}
 */
export function mountComposer(state, host, { onCreated = null } = {}) {
  const el = document.createElement("section");
  el.className = "todo-composer";
  el.setAttribute("aria-label", "New to-do");
  el.innerHTML = `<span class="todo-status todo-composer-box" aria-hidden="true">${statusIcon("inactive")}</span>
    <div class="todo-main">
      <textarea class="todo-composer-title" rows="1" placeholder="New To-Do" spellcheck="false" aria-label="New to-do"></textarea>
      <div class="todo-composer-notes"></div>
      <div class="todo-attach">
        <span class="todo-find">
          ${SEARCH}
          <input class="todo-find-input" type="search" placeholder="Attach a file…" spellcheck="false" autocomplete="off" aria-label="Attach a file" />
        </span>
        <span class="todo-attach-file" hidden></span>
        <button type="button" class="todo-desk-btn" aria-haspopup="listbox">${typeIcons.desk}<span class="todo-desk-btn-name"></span></button>
        <div class="todo-find-results" role="listbox" hidden></div>
        <div class="todo-desk-menu" role="listbox" hidden></div>
      </div>
    </div>`;
  host.appendChild(el);

  const title = el.querySelector(".todo-composer-title");
  const find = el.querySelector(".todo-find");
  const input = el.querySelector(".todo-find-input");
  const fileChip = el.querySelector(".todo-attach-file");
  const deskBtn = el.querySelector(".todo-desk-btn");
  const deskMenu = el.querySelector(".todo-desk-menu");

  let file = null;   // the attached file: a picker leaf { fileId, type, name, deskId, deskName }
  let deskId = null; // a desk picked from the menu, else null

  const targetDesk = () => file?.deskId || deskId || state.settings?.activeDeskId || deskChoices(state)[0]?.deskId || null;

  const notes = mountNotes(el.querySelector(".todo-composer-notes"), {
    placeholder: "Notes",
    onSubmit: () => submit(),
  });

  function fit() {
    title.style.height = "auto";
    title.style.height = `${title.scrollHeight}px`;
  }

  /** The attach row: the search field, or the attached file in its place;
   *  the desk button names the desk once one is picked. */
  function paint() {
    find.hidden = !!file;
    fileChip.hidden = !file;
    fileChip.innerHTML = file
      ? `<span class="todo-attach-name">${leafIcon(file)}<span class="todo-file-name">${escHtml(file.name)}</span></span>
         <button type="button" class="todo-file-unlink" data-composer="unattach" data-tooltip="Remove" aria-label="Remove file">${CROSS}</button>`
      : "";
    const shown = file?.deskId || deskId;
    deskBtn.querySelector(".todo-desk-btn-name").textContent = shown ? deskNameOf(state, shown) : "";
    deskBtn.classList.toggle("chosen", !!shown);
    const label = `Desk: ${deskNameOf(state, targetDesk())}`;
    deskBtn.dataset.tooltip = label;
    deskBtn.setAttribute("aria-label", label);
  }

  function reset() {
    title.value = "";
    notes.setValue("");
    file = null;
    deskId = null;
    fit();
    paint();
  }

  /** Add the to-do, if there is anything to keep. */
  function submit() {
    const t = title.value.replace(/\s+/g, " ").trim();
    const n = notes.value();
    const desk = targetDesk();
    if (!desk || (!t && !n.trim() && !file)) return false;
    const todo = addTodo(state, desk, {
      title: t, notes: n.trim() ? n : "", fileId: file?.fileId || null, fileType: file?.type || null,
    });
    reset();
    title.focus();
    onCreated?.(todo);
    return true;
  }

  // ── Title ──
  title.addEventListener("input", () => {
    if (title.value.includes("\n")) {
      const at = title.selectionStart;
      title.value = title.value.replace(/\n+/g, " ");
      title.setSelectionRange(at, at);
    }
    fit();
  });
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });

  // ── The file search ──
  // Enter in an empty search field adds, as Enter in the title does.
  // Listening ahead of the search's own handler, which empties the field
  // when Enter picks a file — after it, a pick would read as an add.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing && !input.value.trim()) submit();
  });
  mountFileSearch(state, input, el.querySelector(".todo-find-results"), (leaf) => {
    file = leaf;
    paint();
    title.focus();
    title.setSelectionRange(title.value.length, title.value.length);
  });
  fileChip.addEventListener("click", (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('[data-composer="unattach"]')) return;
    file = null;
    paint();
    input.focus();
  });

  // ── The desk menu ──
  let menuRows = [];
  function openMenu() {
    menuRows = deskChoices(state);
    const current = targetDesk();
    deskMenu.innerHTML = menuRows.map((d, i) => `<button type="button" class="todo-search-row${d.deskId === current ? " picked" : ""}" data-i="${i}" role="option" aria-selected="${d.deskId === current}">
        ${typeIcons.desk}<span class="todo-search-name">${escHtml(d.name)}</span>
      </button>`).join("") || `<div class="todo-search-empty">No desks</div>`;
    deskMenu.hidden = false;
    deskBtn.setAttribute("aria-expanded", "true");
    (deskMenu.querySelector(".picked") || deskMenu.querySelector("button"))?.focus();
    document.addEventListener("pointerdown", onOutside, true);
  }
  function closeMenu(refocus = false) {
    if (deskMenu.hidden) return;
    deskMenu.hidden = true;
    deskBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    if (refocus) deskBtn.focus();
  }
  function onOutside(e) {
    if (!deskMenu.contains(e.target) && !deskBtn.contains(e.target)) closeMenu();
  }
  function pickDesk(i) {
    const d = menuRows[i];
    if (!d) return;
    deskId = d.deskId;
    if (file && file.deskId !== d.deskId) file = null;
    closeMenu();
    paint();
    title.focus();
  }
  deskBtn.addEventListener("click", () => (deskMenu.hidden ? openMenu() : closeMenu()));
  deskMenu.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest(".todo-search-row") : null;
    if (b) pickDesk(Number(b.dataset.i));
  });
  deskMenu.addEventListener("keydown", (e) => {
    const rows = [...deskMenu.querySelectorAll(".todo-search-row")];
    const i = rows.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
    } else if (e.key === "Tab") closeMenu();
  });

  // A desk renamed or removed, or the desk in front changing, shows on
  // the button.
  const EVENTS = ["desks-changed", "active-desk-changed", "files-changed"];
  for (const ev of EVENTS) state.on(ev, paint);

  paint();
  return {
    el,
    focus() { title.focus({ preventScroll: true }); },
    destroy() {
      closeMenu();
      for (const ev of EVENTS) state.off(ev, paint);
      notes.destroy();
      el.remove();
    },
  };
}
