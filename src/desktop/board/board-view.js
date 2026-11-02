/**
 * The Project Desktop — a project's command centre, top to bottom in
 * reading order.
 *
 * Each document of the project's text is a row: its **stack** of pages
 * (a sheet per WORDS_PER_PAGE words, the first page drawn on top), its
 * **outline** of headings beside it, always shown, and — once a heading
 * or the stack is clicked — a **pane** to the right of the outline, the
 * document itself scrolled to that heading (board-pane.js). Pointing at
 * a heading lifts the page it is on out of the stack. Under the outline,
 * **notes** for that document: an outline module, a checklist of what to
 * do to it. Rows are joined by the sidebar's project I-beam, drawn
 * large (board-render.js); halfway down each link a dashed-box button
 * adds a **placeholder** there — a document not written yet, drawn as a
 * dashed stack with a title and a Create button beside an empty outline
 * module. Create makes the document in that place, its title and outline
 * written in as headings (board-model.js). The project's other files —
 * notebooks, stacks, notes, PDFs — sit at the foot as its material.
 *
 * Takes over the main view (desktop-view.js is the entry point every
 * caller uses): `body.desktop-active` hides what is underneath,
 * `__hushDesktopOpenId` makes it the pane context (`dt:<projectId>`) and
 * the project stickies' project, and `desktop-opened` / `desktop-closed`
 * tell the return crumb and the stickies. Re-renders on file changes, deferred while anything on the
 * board has the keyboard so typing is never pulled out from under.
 */
import { findNode } from "../../state/tree-helpers.js";
import { escHtml } from "../../sidebar/files-panel-shared.js";
import { getIcon } from "../../sidebar/files-panel-rows.js";
import { armDesktopReturn } from "../desktop-return.js";
import { openLeaf } from "../../state/cross-desk.js";
import {
  boardRows, boardData, materials, EMPTY_OUTLINE, addPlaceholder, updatePlaceholder,
  removePlaceholder, setNotes, createFromPlaceholder, placeholderOutline, placeholderName,
} from "./board-model.js";
import { buildStack, buildOutline, buildConnector, buildPlaceholderStack, INDENT } from "./board-render.js";
import { openRowPane, adoptSlot, sweepRowPanes, closeRowPanes } from "./board-pane.js";

const PERSIST_MS = 700;

let host = null;
let state = null;
let containerId = null;
let wired = false;
let renderTimer = null;
let pendingRender = false;
// Outline modules (placeholders' outlines, documents' notes), kept
// across re-renders so their editors — caret, undo — survive one.
const modules = new Map();
const persistTimers = new Map();

export const isBoardOpen = () => !!containerId;
export const boardContainerId = () => containerId;

const projectNode = () => (containerId ? findNode(state.fileTree || [], containerId) : null);
const fileContent = (fileId) => (state.files || []).find((f) => f.id === fileId)?.content || "";

function somethingIsOpen() {
  return !!(state.currentFileId || state.currentProjectId || state.currentNotebookFileId
    || state.currentPdfFileId || state.currentStackFileId || state.currentLocalSync);
}

function wire() {
  if (wired) return;
  wired = true;
  // Opening a file replaces the board.
  const close = () => { if (containerId && somethingIsOpen()) closeProjectBoard(); };
  for (const ev of ["file-opened", "notebook-open", "pdf-open", "stack-open"]) state.on(ev, close);
  state.on("multi-select-changed", () => { if ((state.selectedDocIds || []).length >= 2) closeProjectBoard(); });
  state.on("files-changed", scheduleRender);
  state.on("doc-content-changed", scheduleRender);
  state.on("panes-changed", () => { if (containerId && sweepRowPanes().length) scheduleRender(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !containerId || e.defaultPrevented) return;
    const a = document.activeElement;
    if (a && a !== document.body && (host?.contains(a) || a.closest?.(".floating-pane"))) {
      a.blur?.();
      return;
    }
    e.preventDefault();
    closeProjectBoard();
  }, true);
}

/** Open a project's board. `opts.focusKey` (a fileId — "View in
 *  Desktop") or `opts.focusPlaceholder` (a placeholder's id — its row in
 *  the sidebar) scrolls that row into view. */
export async function openProjectBoard(appState, projectId, opts = {}) {
  state = appState;
  wire();
  if (!findNode(state.fileTree || [], projectId)) return;
  if (containerId === projectId) { focusRow(opts.focusKey, opts.focusPlaceholder); return; }
  if (containerId) closeProjectBoard();
  if (state.selectedDocIds?.length) state.clearSelectedDocs();
  import("../../pdf/pdf-shelf.js").then((m) => m.closePdfShelf()).catch(() => {});
  if (state.dirty) await state.saveCurrentFile();
  await state.clearActiveFile();
  containerId = projectId;
  window.__hushDesktopOpenId = projectId;
  document.body.classList.add("desktop-active");
  if (!host) {
    host = document.createElement("div");
    host.className = "desktop-view board-view";
    document.getElementById("app")?.appendChild(host);
    // A deferred render runs once the keyboard leaves the board.
    host.addEventListener("focusout", () => {
      setTimeout(() => { if (pendingRender && !boardHasFocus()) render(); }, 0);
    });
  }
  host.classList.remove("hidden");
  import("../../pane/pane-dock.js").then((m) => m.publishDockCssVars()).catch(() => {});
  render();
  host.scrollTop = 0;
  focusRow(opts.focusKey, opts.focusPlaceholder);
  state.emit("desktop-opened", projectId);
}

function focusRow(fileId, phId) {
  if ((!fileId && !phId) || !host) return;
  const row = [...host.querySelectorAll(".board-row")]
    .find((r) => (fileId && r.dataset.fileId === fileId) || (phId && r.dataset.phId === phId));
  if (!row) return;
  row.scrollIntoView({ block: "center" });
  row.classList.remove("flash");
  void row.offsetWidth;
  row.classList.add("flash");
}

export function closeProjectBoard() {
  if (!containerId) return;
  const closed = containerId;
  flushPersists();
  void closeRowPanes();
  for (const m of modules.values()) m.destroy();
  modules.clear();
  noteFields.clear();
  containerId = null;
  window.__hushDesktopOpenId = null;
  document.body.classList.remove("desktop-active");
  if (host) { host.classList.add("hidden"); host.innerHTML = ""; }
  import("../../pane/pane-dock.js").then((m) => m.publishDockCssVars()).catch(() => {});
  state?.emit("desktop-closed", closed);
}

/** Something on the board is being typed into — a title field, an
 *  outline module, a row's pane. A focused button doesn't count. */
function boardHasFocus() {
  const a = document.activeElement;
  if (!a || !host || !host.contains(a) || a === host) return false;
  return !!(a.closest(".cm-editor") || a.matches("input, textarea, [contenteditable]:not([contenteditable='false'])"));
}

function scheduleRender() {
  if (!containerId) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    renderTimer = null;
    if (!containerId) return;
    if (!projectNode()) { if ((state.fileTree || []).length) closeProjectBoard(); return; }
    if (boardHasFocus()) { pendingRender = true; return; }
    render();
  }, 250);
}

// ── Persisting what is typed on the board ──────────────────────────

function persistLater(key, write) {
  clearTimeout(persistTimers.get(key)?.t);
  const t = setTimeout(() => { persistTimers.delete(key); write(); void state.saveFileTree(); }, PERSIST_MS);
  persistTimers.set(key, { t, write });
}

function flushPersists() {
  if (!persistTimers.size) return;
  for (const { t, write } of persistTimers.values()) { clearTimeout(t); write(); }
  persistTimers.clear();
  void state.saveFileTree();
}

/** An outline module for `key`, made once and kept. */
async function outlineModule(key, text, onEdit) {
  let m = modules.get(key);
  if (m) return m;
  const { createOutlineCanvasElement } = await import("../../outline/outline-canvas-element.js");
  // The board's outlines have no footer (desktop-board.css hides it):
  // no type size of their own, nothing to pin to, nothing hidden.
  m = createOutlineCanvasElement({
    appState: state, text, hideDone: false, pinned: false,
    // An empty item draws no checkbox, so a fresh outline is aligned at
    // its first keystroke.
    onEdit: (next) => { if (!m.aligned) alignModule(m, 2); onEdit(next); },
    onToggleHideDone: () => {}, onTogglePin: () => {},
  });
  m.el.classList.add("board-outline-module", "editing");
  modules.set(key, m);
  return m;
}

/** The item grip sits GRIP_GAP px left of an item's checkbox; a board
 *  outline is shifted so the root items' grip lands on the column's
 *  edge, under the first letter of its label. Measured, since the line's
 *  hanging indent goes with the type size. */
const GRIP_GAP = 16;
function alignModule(m, tries = 10) {
  requestAnimationFrame(() => {
    if (!m.el.isConnected) return;
    // The checkboxes are decorations, drawn a frame or two after mount
    // (and not at all for an empty item — see outlineModule).
    const box = m.el.querySelector(".cm-task-checkbox");
    if (!box) { if (tries > 0) alignModule(m, tries - 1); return; }
    const current = parseFloat(m.el.style.getPropertyValue("--board-outline-shift")) || 0;
    const offset = box.getBoundingClientRect().left - m.el.getBoundingClientRect().left + current;
    m.el.style.setProperty("--board-outline-shift", Math.max(0, offset - GRIP_GAP) + "px");
    m.aligned = true;
  });
}

// ── Rendering ──────────────────────────────────────────────────────

const OPEN_ICON = `<svg viewBox="0 0 16 16"><path d="M6 3H3v10h10v-3M9 3h4v4M13 3L7.5 8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PANE_ICON = `<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><line x1="2" y1="5.5" x2="14" y2="5.5" stroke="currentColor" stroke-width="1.4"/></svg>`;

function openFull(leaf) {
  armDesktopReturn(state, containerId);
  void openLeaf(state, leaf);
}

/** A material file in a floating pane (a document's own pane is its
 *  row's). */
async function openFloating(node) {
  const { createPane } = await import("../../pane/pane-manager.js");
  await createPane(node.fileId, node.name, node.type,
    window.innerWidth * 0.7, window.innerHeight * 0.35, { desktopPane: true, ownerContext: "dt:" + containerId });
}

function render() {
  pendingRender = false;
  const project = projectNode();
  if (!host || !project) return;
  const scroll = host.scrollTop;
  const rows = boardRows(project);
  const docs = rows.filter((r) => r.kind === "doc");
  const words = docs.reduce((n, r) => n + (fileContent(r.node.fileId).match(/\S+/g)?.length || 0), 0);
  host.innerHTML = "";

  const head = document.createElement("header");
  head.className = "board-head";
  head.innerHTML = `<div class="board-head-titles"><h1 class="board-title">${escHtml(project.name || "Project")}</h1>`
    + `<div class="board-stats">${docs.length} document${docs.length === 1 ? "" : "s"} · ${words.toLocaleString()} words</div></div>`
    + `<div class="board-head-actions">`
    + `<button type="button" class="board-head-btn board-close" data-act="close" title="Close (Esc)" aria-label="Close">×</button></div>`;
  head.querySelector('[data-act="close"]').addEventListener("click", closeProjectBoard);
  host.appendChild(head);

  const list = document.createElement("div");
  list.className = "board-rows";
  const live = new Set();
  liveNotes.clear();
  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    if (prev) list.appendChild(connector(prev, row));
    else if (row.groups.length) list.appendChild(groupHead(row));
    list.appendChild(indent(rowFor(row, project, live), row.depth));
  });
  list.appendChild(lastConnector(project, rows[rows.length - 1]));
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "board-empty";
    empty.textContent = "This project has no documents yet. Add a placeholder to plan the first one.";
    list.prepend(empty);
  }
  host.appendChild(list);
  host.appendChild(materialSection(project, live));

  for (const [key, m] of modules) if (!live.has(key)) { m.destroy(); modules.delete(key); }
  for (const key of noteFields.keys()) if (!liveNotes.has(key)) noteFields.delete(key);
  host.scrollTop = scroll;
}

const indent = (el, depth) => { if (depth) el.style.marginLeft = depth * INDENT + "px"; return el; };

function rowFor(row, project, live) {
  if (row.kind === "doc") return docRow(row.node, project, live);
  if (row.kind === "placeholder") return placeholderRow(row.ph, live);
  return groupRow(row.node);
}

const openGroup = (node) => { armDesktopReturn(state, containerId); void openProjectBoard(state, node.id); };

/** Add a placeholder, open it, and put the caret in its outline. */
async function addAndFocus(where) {
  freshId = (await addPlaceholder(state, containerId, where))?.id || null;
  render();
}

/** Where a placeholder added just above `row` goes: into `row`'s own
 *  gap, ahead of it. */
function gapBefore(row) {
  if (row.kind === "placeholder") {
    return { afterId: row.ph.afterId || null, parentId: row.ph.parentId || row.containerId, beforePhId: row.ph.id };
  }
  if (row.kind === "group") return { afterId: null, parentId: row.node.id };
  return { afterId: row.gap, parentId: row.containerId };
}

function connector(prev, row) {
  return buildConnector({
    from: prev.depth, to: row.depth, groups: row.groups,
    onAdd: () => addAndFocus(gapBefore(row)), onGroup: openGroup,
  });
}

/** The stem out of the last row, back to the board's own depth: adds at
 *  the end of the project. */
function lastConnector(project, last) {
  const tail = [...(project.children || [])].reverse()
    .find((n) => (n.type === "document" && n.fileId && !n.useAsNote) || n.type === "project");
  return buildConnector({
    from: last?.depth || 0, to: 0, last: true,
    onAdd: () => addAndFocus({ afterId: tail?.id || null, parentId: project.id }),
  });
}

/** A nested project's name over its first row, when the board starts
 *  inside one (there is no connector above to carry it). */
function groupHead(row) {
  const el = buildConnector({ from: row.depth, to: row.depth, groups: row.groups, onGroup: openGroup, onAdd: () => addAndFocus(gapBefore(row)) });
  el.classList.add("head");
  return indent(el, 0);
}

/** A nested project with nothing in it yet: its name, and room to plan. */
function groupRow(node) {
  const row = document.createElement("section");
  row.className = "board-row board-row-group";
  row.innerHTML = `<div class="board-col-stack"><div class="board-group-empty">No documents yet</div></div>`;
  return row;
}

let freshId = null;

function docRow(node, project, live) {
  const content = fileContent(node.fileId);
  const row = document.createElement("section");
  row.className = "board-row board-row-doc";
  row.dataset.fileId = node.fileId;

  const slot = document.createElement("div");
  slot.className = "board-pane-slot";
  const openPane = (from) => openRowPane(state, { fileId: node.fileId, name: node.name, slot, containerId, from });

  const stackCol = document.createElement("div");
  stackCol.className = "board-col-stack";
  const leaf = { type: "document", fileId: node.fileId };
  const stack = buildStack(content, { onClick: () => openPane(0), onOpen: () => openFull(leaf) });
  stack.el.title = "Click to open beside the outline; double-click to open";
  const label = document.createElement("div");
  label.className = "board-stack-label";
  label.textContent = `${stack.words.toLocaleString()} words · ${stack.pages} page${stack.pages === 1 ? "" : "s"}`;
  stackCol.append(stack.el, label);

  const outlineCol = document.createElement("div");
  outlineCol.className = "board-col-outline";
  const title = document.createElement("div");
  title.className = "board-row-title";
  // The name is the outline's first item: it points at page 1 and opens
  // the pane at the top, as a heading does at its place.
  title.innerHTML = `<button type="button" class="board-row-name board-outline-head">${escHtml(node.name || "Untitled")}</button>`
    + `<button type="button" class="board-icon-btn" data-act="open" title="Open">${OPEN_ICON}</button>`;
  title.querySelector('[data-act="open"]').addEventListener("click", () => openFull(leaf));
  const head = title.querySelector(".board-outline-head");
  head.addEventListener("pointerenter", () => stack.reveal(null));
  head.addEventListener("click", () => openPane(0));
  const outline = buildOutline(content, {
    name: node.name,
    onHover: (h) => stack.reveal(h ? stack.pageOfOffset(h.from) : null),
    onPick: (h) => openPane(h.from),
  });
  outlineCol.append(title, outline, notesBlock(node, project));

  const paneCol = document.createElement("div");
  paneCol.className = "board-col-pane";
  paneCol.appendChild(slot);
  row.append(stackCol, outlineCol, paneCol);
  adoptSlot(node.fileId, slot);
  return row;
}

/** A document's notes — plain text under its outline, once there are
 *  any; a quiet "+ Notes" until then. The field is kept across
 *  re-renders (`noteFields`), so its caret and undo survive one, and
 *  grows with what is written in it. */
function notesBlock(node, project) {
  const wrap = document.createElement("div");
  wrap.className = "board-notes";
  const key = node.fileId;
  liveNotes.add(key);
  const text = notesText(boardData(project).notes[key]);
  const mount = (focus) => {
    let field = noteFields.get(key);
    if (!field) {
      field = document.createElement("textarea");
      field.className = "board-notes-text";
      field.rows = 1;
      field.spellcheck = true;
      field.placeholder = "Notes on this document…";
      field.value = text;
      field.addEventListener("input", () => {
        grow(field);
        persistLater("notes:" + key, () => setNotes(state, containerId, key, field.value));
      });
      noteFields.set(key, field);
    }
    wrap.innerHTML = `<label class="board-notes-label">Notes</label>`;
    wrap.appendChild(field);
    requestAnimationFrame(() => grow(field));
    if (focus) field.focus();
  };
  if (text || noteFields.has(key)) mount(false);
  else {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "board-notes-add";
    add.textContent = "+ Notes";
    add.addEventListener("click", () => mount(true));
    wrap.appendChild(add);
  }
  return wrap;
}

const noteFields = new Map();
const liveNotes = new Set();
const grow = (field) => { field.style.height = "auto"; field.style.height = field.scrollHeight + "px"; };

/** Notes as text. Notes written while they were an outline arrive as a
 *  checklist; their boxes are dropped, the words and indents kept. */
function notesText(stored) {
  const t = String(stored || "");
  return t.split("\n").map((l) => l.replace(/^(\s*)[-*+]\s+\[[ xX]\]\s?/, "$1")).join("\n").replace(/\s+$/, "");
}

function placeholderRow(ph, live) {
  const row = document.createElement("section");
  const fresh = freshId === ph.id;
  row.className = "board-row board-row-placeholder" + (fresh ? " fresh" : "");
  row.dataset.phId = ph.id;
  if (fresh) freshId = null;
  const key = "ph:" + ph.id;
  const stackCol = document.createElement("div");
  stackCol.className = "board-col-stack";
  const stack = buildPlaceholderStack(placeholderName({ outline: modules.get(key)?.getText() ?? placeholderOutline(ph) }), {
    onCreate: async () => {
      flushPersists();
      const m = modules.get(key);
      if (m) updatePlaceholder(state, containerId, ph.id, { outline: m.getText() });
      if (await createFromPlaceholder(state, containerId, ph.id)) render();
    },
    onRemove: async () => {
      flushPersists();
      await removePlaceholder(state, containerId, ph.id);
      render();
    },
  });
  const label = document.createElement("div");
  label.className = "board-stack-label";
  label.textContent = "Not written yet";
  stackCol.append(stack.el, label);

  const outlineCol = document.createElement("div");
  outlineCol.className = "board-col-outline";
  outlineCol.innerHTML = `<div class="board-row-title"><span class="board-section-label">Outline</span></div>`;
  live.add(key);
  void outlineModule(key, placeholderOutline(ph), (next) => {
    stack.setName(placeholderName({ outline: next }));
    persistLater(key, () => updatePlaceholder(state, containerId, ph.id, { outline: next }));
  }).then((m) => {
    outlineCol.appendChild(m.el);
    alignModule(m);
    if (fresh) m.focusAt();
  });
  row.append(stackCol, outlineCol);
  return row;
}

/** The project's supporting material: notes as document rows (stack,
 *  outline, pane, as the text's documents), notebooks open inline as
 *  panes, the way a wikilink peeks one, and stacks and PDFs as items to
 *  open. */
function materialSection(project, live) {
  const items = materials(project);
  const el = document.createElement("section");
  el.className = "board-material";
  if (!items.length) return el;
  el.innerHTML = `<h2 class="board-material-title">Supporting material</h2>`;
  const chips = document.createElement("div");
  chips.className = "board-material-grid";
  for (const node of items) {
    if (node.type === "document") { el.appendChild(docRow(node, project, live)); continue; }
    if (node.type === "notebook") { el.appendChild(notebookRow(node)); continue; }
    const chip = document.createElement("div");
    chip.className = "board-material-item";
    chip.innerHTML = `${getIcon(node, state)}<span class="board-material-name">${escHtml(node.name || "Untitled")}</span>`
      + `<button type="button" class="board-icon-btn" title="Open as a floating pane">${PANE_ICON}</button>`;
    chip.addEventListener("click", (e) => {
      if (e.target.closest(".board-icon-btn")) { void openFloating(node); return; }
      openFull({ type: node.type, fileId: node.fileId });
    });
    chips.appendChild(chip);
  }
  if (chips.children.length) el.appendChild(chips);
  return el;
}

/** A notebook among the material: its name, and the notebook itself in
 *  an inline pane across the row. */
function notebookRow(node) {
  const row = document.createElement("section");
  row.className = "board-row board-row-notebook";
  row.dataset.fileId = node.fileId;
  const title = document.createElement("div");
  title.className = "board-row-title";
  title.innerHTML = `${getIcon(node, state)}<span class="board-row-name">${escHtml(node.name || "Untitled")}</span>`
    + `<button type="button" class="board-icon-btn" data-act="open" title="Open">${OPEN_ICON}</button>`;
  title.querySelector('[data-act="open"]').addEventListener("click", () => openFull({ type: "notebook", fileId: node.fileId }));
  const slot = document.createElement("div");
  slot.className = "board-pane-slot";
  row.append(title, slot);
  if (!adoptSlot(node.fileId, slot)) {
    void openRowPane(state, { fileId: node.fileId, name: node.name, slot, containerId, type: "notebook", height: 420, focus: false });
  }
  return row;
}
