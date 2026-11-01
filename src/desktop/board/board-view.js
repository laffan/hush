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
 * Takes over the main view as the canvas Desktop does (desktop-view.js
 * routes a project's Desktop here; a desk's Desktop, and the project's
 * free canvas — the header's **Canvas** — stay there): the same
 * `body.desktop-active`, `__hushDesktopOpenId` and `desktop-opened` /
 * `desktop-closed`, so panes, stickies and the return crumb treat both
 * alike. Re-renders on file changes, deferred while anything on the
 * board has the keyboard so typing is never pulled out from under.
 */
import { findNode } from "../../state/tree-helpers.js";
import { escHtml } from "../../sidebar/files-panel-shared.js";
import { getIcon } from "../../sidebar/files-panel-rows.js";
import { armDesktopReturn } from "../desktop-return.js";
import { openLeaf } from "../../state/cross-desk.js";
import {
  boardRows, boardData, materials, EMPTY_OUTLINE, addPlaceholder, updatePlaceholder,
  removePlaceholder, setNotes, createFromPlaceholder,
} from "./board-model.js";
import { buildStack, buildOutline, buildConnector, buildPlaceholderStack } from "./board-render.js";
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
  // Opening a file replaces the board, as it does the canvas Desktop.
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
 *  Desktop") scrolls that document's row into view. */
export async function openProjectBoard(appState, projectId, opts = {}) {
  state = appState;
  wire();
  if (!findNode(state.fileTree || [], projectId)) return;
  if (containerId === projectId) { focusRow(opts.focusKey); return; }
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
  focusRow(opts.focusKey);
  state.emit("desktop-opened", projectId);
}

function focusRow(fileId) {
  if (!fileId || !host) return;
  const row = [...host.querySelectorAll(".board-row-doc")].find((r) => r.dataset.fileId === fileId);
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
  // Hide-completed works as it does anywhere (for this sitting); there
  // is nothing on the board to pin an outline to.
  let hideDone = false;
  m = createOutlineCanvasElement({
    appState: state, text, hideDone, pinned: false, onEdit,
    onToggleHideDone: () => { hideDone = !hideDone; m.setFlags({ hideDone, pinned: false }); },
    onTogglePin: () => {},
  });
  m.el.classList.add("board-outline-module", "editing");
  modules.set(key, m);
  return m;
}

// ── Rendering ──────────────────────────────────────────────────────

const OPEN_ICON = `<svg viewBox="0 0 16 16"><path d="M6 3H3v10h10v-3M9 3h4v4M13 3L7.5 8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PANE_ICON = `<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><line x1="2" y1="5.5" x2="14" y2="5.5" stroke="currentColor" stroke-width="1.4"/></svg>`;

function openFull(leaf) {
  armDesktopReturn(state, containerId);
  void openLeaf(state, leaf);
}

async function openFloating(node) {
  const { createPane } = await import("../../pane/pane-manager.js");
  const type = node.type === "project" ? "desktop" : node.type;
  await createPane(node.type === "project" ? node.id : node.fileId, node.name, type,
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
    + `<div class="board-head-actions"><button type="button" class="board-head-btn" data-act="canvas" title="The project's free canvas — notes, drawings and stickies placed anywhere">Canvas</button>`
    + `<button type="button" class="board-head-btn board-close" data-act="close" title="Close (Esc)" aria-label="Close">×</button></div>`;
  head.querySelector('[data-act="close"]').addEventListener("click", closeProjectBoard);
  head.querySelector('[data-act="canvas"]').addEventListener("click", async () => {
    const id = containerId;
    closeProjectBoard();
    (await import("../desktop-view.js")).openDesktop(state, id, { canvas: true });
  });
  host.appendChild(head);

  const list = document.createElement("div");
  list.className = "board-rows";
  const live = new Set();
  rows.forEach((row, i) => {
    if (i > 0) list.appendChild(connectorAfter(rows[i - 1]));
    list.appendChild(row.kind === "doc" ? docRow(row.node, project, live) : placeholderRow(row.ph, live));
  });
  list.appendChild(connectorAfter(rows[rows.length - 1] || null, true));
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "board-empty";
    empty.textContent = "This project has no documents yet. Add a placeholder to plan the first one.";
    list.prepend(empty);
  }
  host.appendChild(list);
  host.appendChild(materialSection(project));

  for (const [key, m] of modules) if (!live.has(key)) { m.destroy(); modules.delete(key); }
  host.scrollTop = scroll;
}

function connectorAfter(prev, last = false) {
  const afterId = !prev ? null : prev.kind === "doc" ? prev.node.id : (prev.ph.afterId || null);
  // A placeholder's gap is the one it sits in: adding after it keeps it
  // in that gap, behind it.
  return buildConnector({
    last,
    onAdd: async () => {
      if (prev?.kind === "placeholder") {
        await addPlaceholderAfter(prev.ph);
      } else {
        freshId = (await addPlaceholder(state, containerId, afterId))?.id || null;
      }
      render();
      host.querySelector(".board-row-placeholder.fresh .board-ph-title")?.focus();
    },
  });
}

/** A placeholder straight after another in the same gap. */
async function addPlaceholderAfter(ph) {
  const project = projectNode();
  const data = boardData(project);
  const at = data.placeholders.findIndex((p) => p.id === ph.id);
  const made = { id: crypto.randomUUID(), afterId: ph.afterId || null, title: "", outline: EMPTY_OUTLINE };
  data.placeholders.splice(at + 1, 0, made);
  project.board = { placeholders: data.placeholders, notes: data.notes };
  freshId = made.id;
  await state.saveFileTree();
}
let freshId = null;

function docRow(node, project, live) {
  const content = fileContent(node.fileId);
  const row = document.createElement("section");
  row.className = "board-row board-row-doc";
  row.dataset.fileId = node.fileId;

  const slot = document.createElement("div");
  slot.className = "board-pane-slot";
  const openPane = (from) => openRowPane(state, { fileId: node.fileId, name: node.name, slot, containerId, from })
    .then(() => row.classList.add("has-pane"));

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
  title.innerHTML = `<span class="board-row-name">${escHtml(node.name || "Untitled")}</span>`
    + `<button type="button" class="board-icon-btn" data-act="open" title="Open">${OPEN_ICON}</button>`
    + `<button type="button" class="board-icon-btn" data-act="pane" title="Open as a floating pane">${PANE_ICON}</button>`;
  title.querySelector('[data-act="open"]').addEventListener("click", () => openFull(leaf));
  title.querySelector('[data-act="pane"]').addEventListener("click", () => openFloating(node));
  const outline = buildOutline(content, {
    name: node.name,
    onHover: (h) => stack.reveal(h ? stack.pageOfOffset(h.from) : null),
    onPick: (h) => openPane(h.from),
  });
  outlineCol.append(title, outline, notesBlock(node, project, live));

  const paneCol = document.createElement("div");
  paneCol.className = "board-col-pane";
  paneCol.appendChild(slot);
  row.append(stackCol, outlineCol, paneCol);
  if (adoptSlot(node.fileId, slot)) row.classList.add("has-pane");
  return row;
}

/** A document's notes — an outline module once there are any, a quiet
 *  "Add notes" until then. */
function notesBlock(node, project, live) {
  const wrap = document.createElement("div");
  wrap.className = "board-notes";
  const key = "notes:" + node.fileId;
  const text = boardData(project).notes[node.fileId];
  const mount = async (initial, focus) => {
    live.add(key);
    const m = await outlineModule(key, initial, (next) => {
      persistLater(key, () => setNotes(state, containerId, node.fileId, next));
    });
    wrap.innerHTML = `<div class="board-notes-label">Notes</div>`;
    wrap.appendChild(m.el);
    if (focus) m.focusAt();
  };
  if (text || modules.has(key)) {
    live.add(key);
    void mount(modules.get(key)?.getText() ?? text, false);
  } else {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "board-notes-add";
    add.textContent = "+ Notes";
    add.addEventListener("click", () => void mount(EMPTY_OUTLINE, true));
    wrap.appendChild(add);
  }
  return wrap;
}

function placeholderRow(ph, live) {
  const row = document.createElement("section");
  row.className = "board-row board-row-placeholder" + (freshId === ph.id ? " fresh" : "");
  if (freshId === ph.id) freshId = null;
  const stackCol = document.createElement("div");
  stackCol.className = "board-col-stack";
  stackCol.appendChild(buildPlaceholderStack(ph, {
    onTitle: (v) => persistLater("ph-title:" + ph.id, () => updatePlaceholder(state, containerId, ph.id, { title: v })),
    onCreate: async () => {
      flushPersists();
      const m = modules.get("ph:" + ph.id);
      if (m) updatePlaceholder(state, containerId, ph.id, { outline: m.getText() });
      await createFromPlaceholder(state, containerId, ph.id);
      render();
    },
    onRemove: async () => {
      flushPersists();
      await removePlaceholder(state, containerId, ph.id);
      render();
    },
  }));
  const label = document.createElement("div");
  label.className = "board-stack-label";
  label.textContent = "Not written yet";
  stackCol.appendChild(label);

  const outlineCol = document.createElement("div");
  outlineCol.className = "board-col-outline";
  outlineCol.innerHTML = `<div class="board-row-title"><span class="board-row-name muted">Outline</span></div>`;
  const key = "ph:" + ph.id;
  live.add(key);
  void outlineModule(key, ph.outline || EMPTY_OUTLINE, (next) => {
    persistLater(key, () => updatePlaceholder(state, containerId, ph.id, { outline: next }));
  }).then((m) => outlineCol.appendChild(m.el));
  row.append(stackCol, outlineCol);
  return row;
}

function materialSection(project) {
  const items = materials(project);
  const el = document.createElement("section");
  el.className = "board-material";
  if (!items.length) return el;
  el.innerHTML = `<h2 class="board-material-title">Material</h2>`;
  const grid = document.createElement("div");
  grid.className = "board-material-grid";
  for (const node of items) {
    const chip = document.createElement("div");
    chip.className = "board-material-item";
    chip.innerHTML = `${getIcon(node, state)}<span class="board-material-name">${escHtml(node.name || "Untitled")}</span>`
      + `<button type="button" class="board-icon-btn" title="Open as a floating pane">${PANE_ICON}</button>`;
    chip.addEventListener("click", (e) => {
      if (e.target.closest(".board-icon-btn")) { void openFloating(node); return; }
      if (node.type === "project") { armDesktopReturn(state, containerId); void openProjectBoard(state, node.id); return; }
      openFull({ type: node.type, fileId: node.fileId });
    });
    grid.appendChild(chip);
  }
  el.appendChild(grid);
  return el;
}
