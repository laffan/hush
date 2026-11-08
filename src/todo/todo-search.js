/**
 * The to-do's magnifying glass: find a desk or a file, across every
 * desk, and pick it. A desk moves the to-do there; a file links it (and
 * moves the to-do to the file's desk). Mounted inside the panel, under
 * the row it was opened from; ↑ / ↓ and Enter, or a click, pick;
 * Escape or a press outside closes it.
 *
 * Also the panel's header search (`mountFileSearch`): every file on every
 * desk, and picking one starts a to-do linked to it.
 */
import { escHtml, leafIcon, typeIcons } from "../sidebar/files-panel-shared.js";
import { allDeskLeaves } from "../state/cross-desk.js";

const MAX_ROWS = 40;

/** Files a to-do can link to: anything that opens by its fileId. A PDF
 *  opens through its own path and a project is addressed by its node id,
 *  so neither would open from the link. */
const linkable = (f) => f.fileId && f.type !== "pdf" && f.type !== "project";

const matcher = (query) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return { words, hit: (text) => words.every((w) => text.toLowerCase().includes(w)) };
};

/** Every linkable file whose name (or desk's name) holds every word of
 *  the query, the desk in front's first. */
function fileResults(state, query) {
  const { words, hit } = matcher(query);
  if (!words.length) return [];
  return allDeskLeaves(state)
    .filter((f) => linkable(f) && hit(`${f.name} ${f.deskName}`))
    .slice(0, MAX_ROWS)
    .map((f) => ({ kind: "file", ...f }));
}

const rowHtml = (r, i, picked) => `<button type="button" class="todo-search-row${i === picked ? " picked" : ""}" data-i="${i}">
    ${r.kind === "desk" ? typeIcons.desk : leafIcon(r)}
    <span class="todo-search-name">${escHtml(r.name)}</span>
    ${r.kind === "file" ? `<span class="todo-search-desk">${escHtml(r.deskName)}</span>` : ""}
  </button>`;

/**
 * The header's search field: type, and the files that match drop down
 * under it; ↑ / ↓ and Enter, or a click, pick one (`onPick(leaf)`), and
 * the field clears. Escape clears a field with something in it; on an
 * empty one it is left to the panel (which closes).
 *
 * @param {object} state
 * @param {HTMLInputElement} input
 * @param {HTMLElement} list   Where the results go (hidden while empty).
 * @param {(leaf: object) => void} onPick
 */
export function mountFileSearch(state, input, list, onPick) {
  let rows = [];
  let picked = 0;
  const draw = () => {
    rows = fileResults(state, input.value.trim());
    picked = Math.min(picked, Math.max(0, rows.length - 1));
    list.hidden = !input.value.trim();
    list.innerHTML = rows.length
      ? rows.map((r, i) => rowHtml(r, i, picked)).join("")
      : `<div class="todo-search-empty">No files found</div>`;
    list.querySelector(".picked")?.scrollIntoView({ block: "nearest" });
  };
  const clear = () => { input.value = ""; picked = 0; draw(); };
  const choose = (i) => {
    const r = rows[i];
    if (!r) return;
    clear();
    onPick(r);
  };
  input.addEventListener("input", () => { picked = 0; draw(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && rows.length) { e.preventDefault(); picked = Math.min(rows.length - 1, picked + 1); draw(); }
    else if (e.key === "ArrowUp" && rows.length) { e.preventDefault(); picked = Math.max(0, picked - 1); draw(); }
    else if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); choose(picked); }
    else if (e.key === "Escape" && input.value) { e.preventDefault(); e.stopPropagation(); clear(); }
  });
  list.addEventListener("pointerdown", (e) => {
    const b = e.target instanceof Element ? e.target.closest(".todo-search-row") : null;
    if (!b) return;
    e.preventDefault();
    choose(Number(b.dataset.i));
  });
  // Leaving the field (and not for one of its rows) folds the list away.
  input.addEventListener("blur", () => { list.hidden = true; });
  input.addEventListener("focus", () => { if (input.value.trim()) draw(); });
  draw();
}

/** Desks first, then files; every word of the query must appear in the
 *  name (files also match on their desk's name). An empty query lists
 *  the desks, then the files on `deskId`. */
function results(state, query, deskId) {
  const { words, hit } = matcher(query);
  const deskNames = new Map((state.settings?.desks || []).map((d) => [d.id, d.name || "Untitled desk"]));
  const desks = (state.fileTree || []).filter((n) => n.type === "desk")
    .map((n) => ({ kind: "desk", deskId: n.id, name: deskNames.get(n.id) || n.name || "Untitled desk" }))
    .filter((d) => !words.length || hit(d.name));
  const leaves = allDeskLeaves(state)
    .filter(linkable)
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
      ? rows.map((r, i) => rowHtml(r, i, picked)).join("")
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
