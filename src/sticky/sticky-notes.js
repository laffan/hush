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
 *   - "desktop" → pinned to a project Desktop's canvas background
 *                 (world coordinates, rides pan/zoom) — created
 *                 automatically when Add File Sticky runs while a
 *                 Desktop is open; visible only on that Desktop —
 *                 pale pink
 *
 * Like panes: draggable by the header, double-click the header to
 * collapse, active note rises to the top of the sticky z-band (which
 * sits above panes / sidebars — see --z-sticky in base.css).
 * Cmd+= / Cmd+- resize the note's text while it has focus.
 *
 * A scope is not a window, so with several windows open more than one
 * could qualify to show the same note. Exactly one does: the window
 * already showing it keeps it and the rest stand down — see
 * `sticky-window-claims.js`, which `refreshVisibility` consults.
 */
import {
  findNode,
  findNodeByFileId,
  findAncestorIds,
  nearestAncestorProjectId,
  isRealProjectNode,
} from "../state/tree-helpers.js";
import {
  DEFAULT_SIZE, HEADER_HEIGHT, FONT_STEP, DEFAULT_FONT, ICON_CLOSE,
  ctxIconFor, excerptFor, desktopOpenId,
  clampAxis, clampSize, clampFont,
} from "./sticky-shared.js";
import {
  repositionDesktopNotes as repositionDesktop,
  desktopStickyRows, revealDesktopSticky, repaintDesktop, bindDesktopSelection,
  desktopStickiesFor,
} from "./sticky-desktop.js";
import { setupDrag, setupResize } from "./sticky-interact.js";
import { toggleContextMenu } from "./sticky-context-menu.js";
import { initStickyClaims, claimedElsewhere, publishClaims } from "./sticky-window-claims.js";

const notes = new Map(); // id → note record
/** Re-anchor + re-scale desktop-pinned notes against the live camera. */
const repositionDesktopNotes = () => repositionDesktop(notes);
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
    // clearActiveFile ends on "no-file-state" (empty desk, deleted open
    // file, archived desk) — without it a file sticky outlives its file.
    "no-file-state",
    "active-desk-changed", "desktop-opened", "desktop-closed",
  ]) state.on(ev, refresh);
  // Desktop-pinned notes track the canvas camera.
  state.on("desktop-opened", () => {
    repositionDesktopNotes();
    bindDesktopSelection(notes);
  });
  document.addEventListener("desktop-camera-changed", repositionDesktopNotes);
  // Hooks the notebook shape shelf reads to list desktop-pinned notes
  // (same shape as the Desktop's other window.__hush* bridges).
  window.__hushFileStickies = fileStickiesFor;
  window.__hushDesktopStickiesFor = (id) => desktopStickiesFor(notes, id);
  window.__hushDesktopStickies = () => desktopStickyRows(notes);
  window.__hushRevealDesktopSticky = (id) =>
    revealDesktopSticky(notes, id, (n) => { n.el.style.zIndex = ++zCounter; });
  // Renames / deletions: refresh labels and prune notes whose target
  // no longer exists in the tree.
  state.on("files-changed", () => { pruneOrphans(); refreshLabels(); refreshVisibility(); });

  // Desk stickies travel inside `.hushdesk` (sync/desk-meta.js). When a
  // pull lands newer notes for a desk, rebuild that desk's notes from
  // the freshly-merged settings list.
  state.on("desk-meta-pulled", ({ deskId }) => rebuildDeskNotes(deskId));

  // Sibling windows edit the same settings-backed sticky list; this
  // window's notes Map was hydrated at boot, so a sticky added or
  // closed in another window would never materialise here without a
  // rebuild on the cross-window merge pulse.
  state.on("remote-settings-merged", () => rebuildFromSettings());

  // One sticky, one window: a second window opened onto the same scope
  // defers to the one already showing the note (sticky-window-claims.js).
  void initStickyClaims({ refresh });

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
        // Desktop-pinned notes carry canvas world coordinates too.
        ...(typeof n.wx === "number" ? { wx: n.wx, wy: n.wy } : {}),
        width: n.width, height: n.height,
        collapsed: !!n.collapsed,
        fontSize: n.fontSize,
        text: n.textarea ? n.textarea.value : (n.text || ""),
        createdAt: n.createdAt || Date.now(),
      });
    }
    appState.updateSettings({ stickyNotes: serialized }).then(() => {
      // Mirror desk-scoped notes into their desks' .hushdesk so they
      // ride desk handoffs (no-op for desks whose notes didn't change).
      import("../sync/desk-meta.js")
        .then(({ pushAllDeskMeta }) => pushAllDeskMeta(appState))
        .catch(() => {});
    });
  }, 500);
}

/** Build a live note record from its serialized settings shape (shared
 *  by boot restore and both rebuild paths). */
function noteFromSerialized(s) {
  const width = clampSize(s.width);
  const note = {
    id: s.id, kind: s.kind, target: s.target ?? null,
    x: clampAxis(s.x ?? 40, width, window.innerWidth),
    y: clampAxis(s.y ?? 40, HEADER_HEIGHT, window.innerHeight),
    width, height: clampSize(s.height),
    collapsed: !!s.collapsed,
    fontSize: clampFont(s.fontSize),
    text: typeof s.text === "string" ? s.text : "",
    createdAt: s.createdAt || Date.now(),
  };
  if (typeof s.wx === "number" && typeof s.wy === "number") { note.wx = s.wx; note.wy = s.wy; }
  return note;
}

/** Reconcile the live notes Map against `settings.stickyNotes` after a
 *  sibling window's write was merged in: remove notes the sibling
 *  closed, create ones it added, and refresh geometry/text on the rest.
 *  A note whose textarea currently has focus is left completely alone —
 *  the merged list may lag this window's own 500 ms-debounced persist,
 *  and clobbering mid-typing text would be worse than a brief skew. */
function rebuildFromSettings() {
  const list = appState?.settings?.stickyNotes;
  if (!Array.isArray(list)) return;
  const byId = new Map(list.filter((s) => s && s.id).map((s) => [s.id, s]));
  let changed = false;
  for (const [id, n] of [...notes]) {
    if (byId.has(id)) continue;
    if (document.activeElement === n.textarea) continue; // mid-edit here
    n.el.remove();
    notes.delete(id);
    changed = true;
  }
  for (const [id, s] of byId) {
    const existing = notes.get(id);
    if (existing) {
      if (document.activeElement === existing.textarea) continue;
      existing.kind = s.kind;
      existing.target = s.target ?? null;
      existing.x = clampAxis(s.x ?? existing.x, clampSize(s.width), window.innerWidth);
      existing.y = clampAxis(s.y ?? existing.y, HEADER_HEIGHT, window.innerHeight);
      existing.width = clampSize(s.width);
      existing.height = clampSize(s.height);
      existing.fontSize = clampFont(s.fontSize);
      existing.collapsed = !!s.collapsed;
      existing.text = typeof s.text === "string" ? s.text : "";
      existing.el.className = `sticky-note sticky-${existing.kind}` + (existing.collapsed ? " collapsed" : "");
      Object.assign(existing.el.style, {
        left: existing.x + "px", top: existing.y + "px",
        width: existing.width + "px",
        height: (existing.collapsed ? HEADER_HEIGHT : existing.height) + "px",
      });
      existing.textarea.value = existing.text;
      existing.textarea.style.fontSize = existing.fontSize + "px";
      if (existing._ctxBtn) {
        existing._ctxBtn.innerHTML = ctxIconFor(existing.kind);
        existing._ctxBtn.title = labelFor(existing);
      }
      if (existing._excerptEl) existing._excerptEl.textContent = excerptFor(existing.text);
      continue;
    }
    if (!targetStillExists(s.kind, s.target)) continue;
    const note = noteFromSerialized(s);
    buildNoteDOM(note);
    notes.set(note.id, note);
    changed = true;
  }
  refreshVisibility();
  if (changed) emitStickiesChanged();
}

/** Drop and re-create one desk's notes from `settings.stickyNotes` —
 *  called after a desk-meta pull replaced that desk's entries. */
function rebuildDeskNotes(deskId) {
  if (!deskId) return;
  for (const [id, n] of [...notes]) {
    if (n.kind === "desk" && n.target === deskId) {
      n.el.remove();
      notes.delete(id);
    }
  }
  const list = appState?.settings?.stickyNotes || [];
  for (const s of list) {
    if (!s || s.kind !== "desk" || s.target !== deskId || notes.has(s.id)) continue;
    const note = noteFromSerialized(s);
    buildNoteDOM(note);
    notes.set(note.id, note);
  }
  refreshVisibility();
}

function restoreNotes() {
  const list = appState?.settings?.stickyNotes;
  if (!Array.isArray(list)) return;
  for (const s of list) {
    if (!s || !s.id || !s.kind) continue;
    if (!targetStillExists(s.kind, s.target)) continue; // dropped forever
    const note = noteFromSerialized(s);
    buildNoteDOM(note);
    notes.set(note.id, note);
  }
  refreshVisibility();
  schedulePersist(); // re-persist so pruned orphans stay gone
  emitStickiesChanged();
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

/** The project the user is "in" right now: the open project itself, the
 *  project whose Desktop is open, or the nearest ancestor project of the
 *  open file. Null when none of those. */
function activeProjectNodeId(s) {
  if (s.currentProjectId) return s.currentProjectId;
  if (desktopOpenId()) return desktopOpenId();
  const node = currentFileNode(s);
  return node ? nearestAncestorProjectId(s.fileTree || [], node.id) : null;
}

/** A Desktop *replaces* the open file (openDesktop calls clearActiveFile),
 *  so there's no currentFileContext to find — but adding a File Sticky is
 *  still valid there (addSticky re-kinds it to "desktop" and pins it), so
 *  the entry has to stay offered or that path is unreachable. */
export function canAddFileSticky(s) { return !!currentFileContext(s) || !!desktopOpenId(); }
export function canAddProjectSticky(s) { return !!activeProjectNodeId(s); }

// fileRef kind → the context prefix currentFileContext() builds.
const CTX_PREFIX = { doc: "doc:", notebook: "nb:", pdf: "pdf:", stack: "st:" };

/** File-level stickies attached to one file, for the Desktop's thumbnail
 *  badges. Read live per frame by the canvas renderer, so the notes ride
 *  on top of the cached thumbnail image instead of being baked into it. */
function fileStickiesFor(kind, fileId) {
  const prefix = CTX_PREFIX[kind];
  if (!prefix || !fileId) return [];
  const target = prefix + fileId;
  const out = [];
  for (const [, n] of notes) {
    if (n.kind !== "file" || n.target !== target) continue;
    out.push({ text: n.textarea ? n.textarea.value : (n.text || "") });
  }
  return out;
}

export function addSticky(state, kind) {
  appState = appState || state;
  ensureContainer();
  let target = null;
  let world = null;
  if (kind === "file" && desktopOpenId()) {
    // A File Sticky added while a Desktop is open pins itself to the
    // Desktop's background automatically.
    kind = "desktop";
    target = desktopOpenId();
    const toWorld = window.__hushDesktopScreenToWorld;
    if (toWorld) {
      world = toWorld({
        x: Math.round(window.innerWidth / 2 - DEFAULT_SIZE / 2) + (notes.size % 6) * 26,
        y: Math.round(window.innerHeight / 2 - DEFAULT_SIZE / 2) + (notes.size % 6) * 26,
      });
    }
  } else if (kind === "file") {
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
  if (world) { note.wx = world.x; note.wy = world.y; }
  buildNoteDOM(note);
  notes.set(note.id, note);
  activateNote(note);
  note.textarea.focus();
  if (note.kind === "desktop") repositionDesktopNotes();
  repaintDesktop(); // shows on its thumbnail badge / on any Desktop pane
  schedulePersist();
  emitStickiesChanged();
}

/** Tell the app a sticky was added / removed / re-scoped so the files
 *  sidebar can repaint its indicator strips (a filled square per File
 *  Sticky rides beside the pane rectangles). */
function emitStickiesChanged() {
  appState?.emit("stickies-changed");
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

  // Context button — replaces the old text label. Shows the current
  // scope's glyph; clicking opens the Document / Desk / App switcher.
  const ctxBtn = document.createElement("button");
  ctxBtn.className = "sticky-note-btn sticky-note-context";
  ctxBtn.innerHTML = ctxIconFor(note.kind);
  ctxBtn.title = labelFor(note);
  ctxBtn.setAttribute("aria-label", "Change context (Document / Desk / App)");
  ctxBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleContextMenu(note, ctxBtn, contextHooks);
  });
  titlebar.appendChild(ctxBtn);

  // Flex spacer that doubles as the collapsed-note content excerpt. Its
  // text is hidden (but still reserves the space) unless the note is
  // collapsed, so the close button always sits flush right.
  const excerpt = document.createElement("span");
  excerpt.className = "sticky-note-excerpt";
  excerpt.textContent = excerptFor(note.text);
  titlebar.appendChild(excerpt);

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
  textarea.addEventListener("input", () => {
    note.text = textarea.value;
    if (note._excerptEl) note._excerptEl.textContent = excerptFor(note.text);
    // Shown by a file's thumbnail badge, and painted verbatim by a pane.
    if (note.kind === "file" || note.kind === "desktop") repaintDesktop();
    schedulePersist();
  });
  el.appendChild(textarea);

  // Cmd+= / Cmd+- adjust this note's text size (browser zoom stays put).
  el.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (e.key === "=" || e.key === "+") adjustFont(note, +FONT_STEP, e);
    else if (e.key === "-" || e.key === "_") adjustFont(note, -FONT_STEP, e);
  });

  titlebar.addEventListener("dblclick", (e) => {
    if (e.target.closest(".sticky-note-btn")) return;
    // WebKit's double-click word-select is the *default action*, and it
    // runs even when the hit element is `user-select: none` — it just
    // widens whatever selection already exists, which for a sticky
    // floating over a pane means the word under that pane's caret gets
    // selected every time the header is double-clicked to collapse.
    e.preventDefault();
    e.stopPropagation();
    toggleCollapse(note);
  });
  // The selection actually starts at `mousedown`, so that is the event
  // that has to be cancelled. Cancelling `pointerdown` (which the drag
  // helper already does) is *supposed* to suppress the compatibility
  // mouse events, but WebKit still delivers mousedown for a mouse
  // pointer — so cancel it here as well. The textarea is exempt: it
  // needs its own caret placement and selection.
  el.addEventListener("mousedown", (e) => {
    if (e.target instanceof Element && e.target.closest(".sticky-note-text")) return;
    e.preventDefault();
  });
  el.addEventListener("pointerdown", () => activateNote(note));
  setupDrag(note, titlebar, interactHooks);

  // Resize handles (8 directions, same layout as panes).
  for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
    const handle = document.createElement("div");
    handle.className = `sn-resize sn-resize-${dir}`;
    handle.dataset.dir = dir;
    el.appendChild(handle);
  }

  note.el = el;
  note.textarea = textarea;
  note._ctxBtn = ctxBtn;
  note._excerptEl = excerpt;
  setupResize(note, interactHooks);
  ensureContainer().appendChild(el);
}

// Pointer-interaction callbacks for the extracted drag/resize helpers —
// keeps registry, persistence, and Desktop repaint owned by this module.
const interactHooks = {
  activate: (n) => activateNote(n),
  persist: () => schedulePersist(),
  repaintDesktop: () => repaintDesktop(),
};

// Same arrangement for the Document / Desk / App switcher — see
// sticky-context-menu.js.
const contextHooks = {
  appState: () => appState,
  currentFileContext: () => currentFileContext(appState),
  container: () => ensureContainer(),
  nextZ: () => ++zCounter,
  activate: (n) => activateNote(n),
  labelFor: (n) => labelFor(n),
  refreshVisibility: () => refreshVisibility(),
  persist: () => schedulePersist(),
  stickiesChanged: () => emitStickiesChanged(),
};

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
  if (note.collapsed && note._excerptEl) note._excerptEl.textContent = excerptFor(note.text);
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
  repaintDesktop(); // drop its thumbnail badge, if it had one
  schedulePersist();
  emitStickiesChanged();
}

// ── Visibility / labels / pruning ─────────────────────────────────────

/** Show every note whose scope is on screen — minus the ones another
 *  window got to first. A sticky is scoped to a file / desk / the app,
 *  never to a window, so two windows on the same desk would each draw
 *  their own copy of the same note; `sticky-window-claims.js` settles
 *  which one keeps it (the window that had it, i.e. the lower registry
 *  number) and this pass hides the rest. The claim set is republished
 *  from here because this is the one place that knows what this window
 *  is eligible for. */
function refreshVisibility() {
  if (!appState) return;
  const eligible = [];
  for (const [, note] of notes) {
    const scopeOn = noteVisible(note);
    if (scopeOn) eligible.push(note.id);
    note.el.style.display = scopeOn && !claimedElsewhere(note.id) ? "" : "none";
  }
  publishClaims(eligible);
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
      // A project's Desktop is a view of that project.
      if (desktopOpenId() === note.target) return true;
      const node = currentFileNode(s);
      if (!node) return false;
      const ancestors = findAncestorIds(s.fileTree || [], node.id) || [];
      return ancestors.includes(note.target);
    }
    case "file":
      return currentFileContext(s) === note.target;
    case "desktop":
      // Pinned to a project's Desktop background — visible only while
      // that Desktop is open.
      return desktopOpenId() === note.target;
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
  if (note.kind === "project" || note.kind === "desktop") {
    return findNode(tree, note.target)?.name || "Project";
  }
  const fileId = String(note.target || "").replace(/^(doc|nb|pdf|st):/, "");
  return findNodeByFileId(tree, fileId)?.name || "File";
}

function refreshLabels() {
  // The label now lives as the context button's tooltip (the visible
  // header shows only the scope glyph + collapsed excerpt).
  for (const [, n] of notes) if (n._ctxBtn) n._ctxBtn.title = labelFor(n);
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
  if (changed) { schedulePersist(); emitStickiesChanged(); }
}

function targetStillExists(kind, target) {
  const tree = appState?.fileTree || [];
  if (kind === "global") return true;
  if (!target) return false;
  if (!tree.length) return true; // can't verify yet — keep the note
  if (kind === "desk") return tree.some((n) => n.type === "desk" && n.id === target);
  if (kind === "project" || kind === "desktop") {
    const node = findNode(tree, target);
    return isRealProjectNode(node);
  }
  if (kind === "file") {
    const fileId = String(target).replace(/^(doc|nb|pdf|st):/, "");
    return !!findNodeByFileId(tree, fileId);
  }
  return false;
}
