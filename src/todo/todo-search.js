/**
 * The to-do's magnifying glass: find a desk or a file, across every
 * desk, and pick it. A desk moves the to-do there; a file links it (and
 * moves the to-do to the file's desk). Mounted inside the panel, under
 * the row it was opened from; ↑ / ↓ and Enter, or a click, pick;
 * Escape or a press outside closes it.
 */
import { escHtml, leafIcon, typeIcons } from "../sidebar/files-panel-shared.js";
import { allDeskLeaves } from "../state/cross-desk.js";

const MAX_ROWS = 40;

/** Desks first, then files; every word of the query must appear in the
 *  name (files also match on their desk's name). An empty query lists
 *  the desks, then the files on `deskId`. */
function results(state, query, deskId) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (text) => words.every((w) => text.toLowerCase().includes(w));
  const deskNames = new Map((state.settings?.desks || []).map((d) => [d.id, d.name || "Untitled desk"]));
  const desks = (state.fileTree || []).filter((n) => n.type === "desk")
    .map((n) => ({ kind: "desk", deskId: n.id, name: deskNames.get(n.id) || n.name || "Untitled desk" }))
    .filter((d) => !words.length || hit(d.name));
  const leaves = allDeskLeaves(state)
    .filter((f) => f.fileId && f.type !== "pdf")
    .filter((f) => (words.length ? hit(`${f.name} ${f.deskName}`) : f.deskId === deskId))
    .map((f) => ({ kind: "file", ...f }));
  return [...desks, ...leaves].slice(0, MAX_ROWS);
}

/**
 * @param {object} state
 * @param {HTMLElement} host   Positioned container (the panel).
 * @param {HTMLElement} row    The to-do's row, to sit under.
 * @param {object} todo
 * @param {(pick: object) => void} onPick  `{ kind: "desk", deskId }` or a file leaf.
 * @param {() => void} [onClose]  Called once it is gone, picked or not.
 * @returns {{ close(): void }}
 */
export function openTodoSearch(state, host, row, todo, onPick, onClose = () => {}) {
  const box = document.createElement("div");
  box.className = "todo-search";
  box.innerHTML = `<input class="todo-search-input" type="search" placeholder="Desk or file…" spellcheck="false" autocomplete="off" aria-label="Find a desk or file" />
    <div class="todo-search-results" role="listbox"></div>`;
  host.appendChild(box);
  const input = box.querySelector("input");
  const list = box.querySelector(".todo-search-results");
  // Under the row, inside the panel's scroll box.
  const hr = host.getBoundingClientRect();
  const rr = row.getBoundingClientRect();
  box.style.top = `${rr.bottom - hr.top + 2}px`;

  let rows = [];
  let picked = 0;
  const draw = () => {
    rows = results(state, input.value.trim(), todo.deskId);
    picked = Math.min(picked, Math.max(0, rows.length - 1));
    list.innerHTML = rows.length
      ? rows.map((r, i) => `<button type="button" class="todo-search-row${i === picked ? " picked" : ""}" data-i="${i}">
          ${r.kind === "desk" ? typeIcons.desk : leafIcon(r)}
          <span class="todo-search-name">${escHtml(r.name)}</span>
          ${r.kind === "file" ? `<span class="todo-search-desk">${escHtml(r.deskName)}</span>` : ""}
        </button>`).join("")
      : `<div class="todo-search-empty">Nothing found</div>`;
    list.querySelector(".picked")?.scrollIntoView({ block: "nearest" });
  };
  const choose = (i) => {
    const r = rows[i];
    if (!r) return;
    close();
    onPick(r);
  };

  input.addEventListener("input", () => { picked = 0; draw(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); picked = Math.min(rows.length - 1, picked + 1); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); picked = Math.max(0, picked - 1); draw(); }
    else if (e.key === "Enter") { e.preventDefault(); choose(picked); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  });
  // pointerdown, not click: the input's blur would otherwise come first.
  list.addEventListener("pointerdown", (e) => {
    const b = e.target instanceof Element ? e.target.closest(".todo-search-row") : null;
    if (!b) return;
    e.preventDefault();
    choose(Number(b.dataset.i));
  });
  const onOutside = (e) => { if (!box.contains(e.target)) close(); };
  document.addEventListener("pointerdown", onOutside, true);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("pointerdown", onOutside, true);
    box.remove();
    onClose();
  }

  draw();
  input.focus();
  return { close };
}
