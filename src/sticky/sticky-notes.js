/**
 * Sticky Notes — small square temporary reminders that float above
 * every other surface. Not files: they live in AppSettings
 * (`stickyNotes`), never show in the sidebar, and are deleted forever
 * when closed.
 *
 * Notes start 300×300 and can be resized from any edge or corner up to
 * 300×300 (the default is also the max — a sticky can only shrink).
 *
 * Each note is attached to one of four scopes and only shows while its
 * scope is on screen:
 *   - "file"    → a doc / notebook / PDF / stack (target = "doc:<id>",
 *                 "nb:<id>", "pdf:<id>", "st:<id>") — pale pink
 *   - "project" → a project node id; visible while the project or any
 *                 file inside it is open — pale pink
 *   - "desk"    → a desk node id; visible while that desk is active —
 *                 pale yellow
 *   - "global"  → always visible — pale blue
 *
 * Like panes: draggable by the header, double-click the header to
 * collapse, active note rises to the top of the sticky z-band (which
 * sits above panes / sidebars — see --z-sticky in base.css).
 * Cmd+= / Cmd+- resize the note's text while it has focus.
 */
import {
  findNode,
  findNodeByFileId,
  findAncestorIds,
  nearestAncestorProjectId,
  isRealProjectNode,
} from "../state/tree-helpers.js";

const DEFAULT_SIZE = 300;
const MAX_SIZE = 300;
const MIN_SIZE = 120;
const HEADER_HEIGHT = 35;
const MIN_FONT = 10;
const MAX_FONT = 48;
const FONT_STEP = 2;
const DEFAULT_FONT = 21;

const ICON_CLOSE = `<svg viewBox="0 0 10 10"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>`;

const notes = new Map(); // id → note record
let appState = null;
let containerEl = null;
let zCounter = 1;
let persistTimer = null;

// ── Init / persistence ────────────────────────────────────────────────

export function initStickyNotes(state) {
  appState = state;
  ensureContainer();
  restoreNotes();

  // Every context switch re-evaluates which notes are on screen.
  const refresh = () => refreshVisibility();
  for (const ev of [
    "file-opened", "notebook-open", "notebook-unmount",
    "pdf-open", "pdf-unmount", "stack-open", "stack-unmount",
    "active-desk-changed",
  ]) state.on(ev, refresh);
  // Renames / deletions: refresh labels and prune notes whose target
  // no longer exists in the tree.
  state.on("files-changed", () => { pruneOrphans(); refreshLabels(); refreshVisibility(); });

  // Click anywhere outside a sticky drops the active highlight.
  window.addEventListener("pointerdown", (e) => {
    if (e.target instanceof Element && e.target.closest(".sticky-note")) return;
    for (const [, n] of notes) n.el.classList.remove("active");
  }, true);
}

function ensureContainer() {
  if (containerEl) return containerEl;
  containerEl = document.createElement("div");
  containerEl.id = "sticky-container";
  document.body.appendChild(containerEl);
  return containerEl;
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!appState) return;
    const serialized = [];
    for (const [, n] of notes) {
      serialized.push({
        id: n.id, kind: n.kind, target: n.target,
        x: n.x, y: n.y,
        width: n.width, height: n.height,
        collapsed: !!n.collapsed,
        fontSize: n.fontSize,
        text: n.textarea ? n.textarea.value : (n.text || ""),
        createdAt: n.createdAt || Date.now(),
      });
    }
    appState.updateSettings({ stickyNotes: serialized });
  }, 500);
}

function restoreNotes() {
  const list = appState?.settings?.stickyNotes;
  if (!Array.isArray(list)) return;
  for (const s of list) {
    if (!s || !s.id || !s.kind) continue;
    if (!targetStillExists(s.kind, s.target)) continue; // dropped forever
    const width = clampSize(s.width);
    const height = clampSize(s.height);
    const note = {
      id: s.id,
      kind: s.kind,
      target: s.target ?? null,
      x: clampAxis(s.x ?? 40, width, window.innerWidth),
      y: clampAxis(s.y ?? 40, HEADER_HEIGHT, window.innerHeight),
      width,
      height,
      collapsed: !!s.collapsed,
      fontSize: clampFont(s.fontSize),
      text: typeof s.text === "string" ? s.text : "",
      createdAt: s.createdAt || Date.now(),
    };
    buildNoteDOM(note);
    notes.set(note.id, note);
  }
  refreshVisibility();
  schedulePersist(); // re-persist so pruned orphans stay gone
}

// ── Palette entry points ──────────────────────────────────────────────

/** Context id of the currently-open file surface (mirrors the pane
 *  manager's format), or "" when a project / nothing is open. */
function currentFileContext(s) {
  if (s.currentStackFileId) return "st:" + s.currentStackFileId;
  if (s.currentPdfFileId) return "pdf:" + s.currentPdfFileId;
  if (s.currentNotebookFileId) return "nb:" + s.currentNotebookFileId;
  if (s.currentFileId) return "doc:" + s.currentFileId;
  return "";
}

function currentFileNode(s) {
  const fileId = s.currentStackFileId || s.currentPdfFileId
    || s.currentNotebookFileId || s.currentFileId;
  return fileId ? findNodeByFileId(s.fileTree || [], fileId) : null;
}

/** The project the user is "in" right now: the open project itself, or
 *  the nearest ancestor project of the open file. Null when neither. */
function activeProjectNodeId(s) {
  if (s.currentProjectId) return s.currentProjectId;
  const node = currentFileNode(s);
  return node ? nearestAncestorProjectId(s.fileTree || [], node.id) : null;
}

export function canAddFileSticky(s) { return !!currentFileContext(s); }
export function canAddProjectSticky(s) { return !!activeProjectNodeId(s); }

export function addSticky(state, kind) {
  appState = appState || state;
  ensureContainer();
  let target = null;
  if (kind === "file") {
    target = currentFileContext(state);
    if (!target) return;
  } else if (kind === "project") {
    target = activeProjectNodeId(state);
    if (!target) return;
  } else if (kind === "desk") {
    target = state.getActiveDesk?.()?.id || null;
    if (!target) return;
  }
  // Cascade new notes from the viewport centre so several stickies
  // don't land in a perfect stack.
  const step = (notes.size % 6) * 26;
  const note = {
    id: crypto.randomUUID(),
    kind,
    target,
    x: clampAxis(Math.round(window.innerWidth / 2 - DEFAULT_SIZE / 2) + step, DEFAULT_SIZE, window.innerWidth),
    y: clampAxis(Math.round(window.innerHeight / 2 - DEFAULT_SIZE / 2) + step, HEADER_HEIGHT, window.innerHeight),
    width: DEFAULT_SIZE,
    height: DEFAULT_SIZE,
    collapsed: false,
    fontSize: DEFAULT_FONT,
    text: "",
    createdAt: Date.now(),
  };
  buildNoteDOM(note);
  notes.set(note.id, note);
  activateNote(note);
  note.textarea.focus();
  schedulePersist();
}

// ── DOM ───────────────────────────────────────────────────────────────

function buildNoteDOM(note) {
  const el = document.createElement("div");
  el.className = `sticky-note sticky-${note.kind}` + (note.collapsed ? " collapsed" : "");
  Object.assign(el.style, {
    left: note.x + "px",
    top: note.y + "px",
    width: note.width + "px",
    height: (note.collapsed ? HEADER_HEIGHT : note.height) + "px",
    zIndex: ++zCounter,
  });

  const titlebar = document.createElement("div");
  titlebar.className = "sticky-note-titlebar";
  const title = document.createElement("span");
  title.className = "sticky-note-title";
  title.textContent = labelFor(note);
  titlebar.appendChild(title);

  const closeBtn = document.createElement("button");
  closeBtn.className = "sticky-note-btn sticky-note-close";
  closeBtn.innerHTML = ICON_CLOSE;
  closeBtn.setAttribute("aria-label", "Close (deletes the note)");
  closeBtn.addEventListener("click", (e) => { e.stopPropagation(); closeNote(note.id); });
  titlebar.appendChild(closeBtn);
  el.appendChild(titlebar);

  const textarea = document.createElement("textarea");
  textarea.className = "sticky-note-text";
  textarea.placeholder = "Note…";
  textarea.spellcheck = false;
  textarea.value = note.text || "";
  textarea.style.fontSize = note.fontSize + "px";
  textarea.addEventListener("input", () => { note.text = textarea.value; schedulePersist(); });
  el.appendChild(textarea);

  // Cmd+= / Cmd+- adjust this note's text size (browser zoom stays put).
  el.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (e.key === "=" || e.key === "+") adjustFont(note, +FONT_STEP, e);
    else if (e.key === "-" || e.key === "_") adjustFont(note, -FONT_STEP, e);
  });

  titlebar.addEventListener("dblclick", (e) => {
    if (e.target.closest(".sticky-note-btn")) return;
    toggleCollapse(note);
  });
  el.addEventListener("pointerdown", () => activateNote(note));
  setupDrag(note, titlebar);

  // Resize handles (8 directions, same layout as panes).
  for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
    const handle = document.createElement("div");
    handle.className = `sn-resize sn-resize-${dir}`;
    handle.dataset.dir = dir;
    el.appendChild(handle);
  }

  note.el = el;
  note.textarea = textarea;
  note._titleEl = title;
  setupResize(note);
  ensureContainer().appendChild(el);
}

function adjustFont(note, delta, e) {
  e.preventDefault();
  e.stopPropagation();
  note.fontSize = clampFont(note.fontSize + delta);
  note.textarea.style.fontSize = note.fontSize + "px";
  schedulePersist();
}

function toggleCollapse(note) {
  note.collapsed = !note.collapsed;
  note.el.classList.toggle("collapsed", note.collapsed);
  note.el.style.height = (note.collapsed ? HEADER_HEIGHT : note.height) + "px";
  schedulePersist();
}

function activateNote(note) {
  for (const [, n] of notes) if (n !== note) n.el.classList.remove("active");
  note.el.classList.add("active");
  note.el.style.zIndex = ++zCounter;
}

function closeNote(id) {
  const note = notes.get(id);
  if (!note) return;
  note.el.remove();
  notes.delete(id);
  schedulePersist();
}

function setupDrag(note, titlebar) {
  titlebar.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".sticky-note-btn")) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startLeft = note.x, startTop = note.y;
    titlebar.setPointerCapture(e.pointerId);
    const onMove = (me) => {
      note.x = startLeft + (me.clientX - startX);
      note.y = startTop + (me.clientY - startY);
      note.el.style.left = note.x + "px";
      note.el.style.top = note.y + "px";
    };
    const onUp = () => {
      titlebar.removeEventListener("pointermove", onMove);
      titlebar.removeEventListener("pointerup", onUp);
      schedulePersist();
    };
    titlebar.addEventListener("pointermove", onMove);
    titlebar.addEventListener("pointerup", onUp);
  });
}

function setupResize(note) {
  for (const handle of note.el.querySelectorAll(".sn-resize")) {
    handle.addEventListener("pointerdown", (e) => {
      if (note.collapsed) return;
      e.preventDefault();
      e.stopPropagation();
      activateNote(note);
      const dir = handle.dataset.dir;
      const startX = e.clientX, startY = e.clientY;
      const startW = note.width, startH = note.height;
      const startLeft = note.x, startTop = note.y;
      handle.setPointerCapture(e.pointerId);
      const onMove = (me) => {
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;
        let w = startW, h = startH, nx = startLeft, ny = startTop;
        if (dir.includes("e")) w = clampSize(startW + dx);
        if (dir.includes("w")) { w = clampSize(startW - dx); nx = startLeft + (startW - w); }
        if (dir.includes("s")) h = clampSize(startH + dy);
        if (dir.includes("n")) { h = clampSize(startH - dy); ny = startTop + (startH - h); }
        note.width = w; note.height = h; note.x = nx; note.y = ny;
        Object.assign(note.el.style, { width: w + "px", height: h + "px", left: nx + "px", top: ny + "px" });
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        schedulePersist();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
  }
}

// ── Visibility / labels / pruning ─────────────────────────────────────

function refreshVisibility() {
  if (!appState) return;
  for (const [, note] of notes) {
    note.el.style.display = noteVisible(note) ? "" : "none";
  }
}

function noteVisible(note) {
  const s = appState;
  switch (note.kind) {
    case "global":
      return true;
    case "desk":
      return (s.getActiveDesk?.()?.id || null) === note.target;
    case "project": {
      if (s.currentProjectId === note.target) return true;
      const node = currentFileNode(s);
      if (!node) return false;
      const ancestors = findAncestorIds(s.fileTree || [], node.id) || [];
      return ancestors.includes(note.target);
    }
    case "file":
      return currentFileContext(s) === note.target;
    default:
      return false;
  }
}

function labelFor(note) {
  const tree = appState?.fileTree || [];
  if (note.kind === "global") return "Global";
  if (note.kind === "desk") {
    const desk = tree.find((n) => n.type === "desk" && n.id === note.target);
    return desk?.name || "Desk";
  }
  if (note.kind === "project") {
    return findNode(tree, note.target)?.name || "Project";
  }
  const fileId = String(note.target || "").replace(/^(doc|nb|pdf|st):/, "");
  return findNodeByFileId(tree, fileId)?.name || "File";
}

function refreshLabels() {
  for (const [, n] of notes) if (n._titleEl) n._titleEl.textContent = labelFor(n);
}

/** A note whose attachment target was deleted is removed for good —
 *  stickies are temporary by design and have nowhere to re-home. */
function pruneOrphans() {
  const tree = appState?.fileTree || [];
  if (!tree.length) return; // tree not loaded yet — don't mass-delete
  let changed = false;
  for (const [id, n] of notes) {
    if (targetStillExists(n.kind, n.target)) continue;
    n.el.remove();
    notes.delete(id);
    changed = true;
  }
  if (changed) schedulePersist();
}

function targetStillExists(kind, target) {
  const tree = appState?.fileTree || [];
  if (kind === "global") return true;
  if (!target) return false;
  if (!tree.length) return true; // can't verify yet — keep the note
  if (kind === "desk") return tree.some((n) => n.type === "desk" && n.id === target);
  if (kind === "project") {
    const node = findNode(tree, target);
    return isRealProjectNode(node);
  }
  if (kind === "file") {
    const fileId = String(target).replace(/^(doc|nb|pdf|st):/, "");
    return !!findNodeByFileId(tree, fileId);
  }
  return false;
}

// ── Helpers ───────────────────────────────────────────────────────────

function clampAxis(requested, size, viewport) {
  const max = Math.max(0, viewport - size);
  return Math.min(max, Math.max(0, requested));
}

function clampSize(size) {
  const n = typeof size === "number" && isFinite(size) ? size : DEFAULT_SIZE;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n)));
}

function clampFont(size) {
  const n = typeof size === "number" && isFinite(size) ? size : DEFAULT_FONT;
  return Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(n)));
}
