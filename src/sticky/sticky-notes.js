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
  CTX_ICON, CTX_MENU, ctxIconFor, excerptFor, desktopOpenId, desktopZoom,
  clampAxis, clampSize, clampFont,
} from "./sticky-shared.js";
import {
  repositionDesktopNotes as repositionDesktop,
  desktopStickyRows, revealDesktopSticky,
} from "./sticky-desktop.js";

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
    "active-desk-changed", "desktop-opened", "desktop-closed",
  ]) state.on(ev, refresh);
  // Desktop-pinned notes track the canvas camera.
  state.on("desktop-opened", repositionDesktopNotes);
  document.addEventListener("desktop-camera-changed", repositionDesktopNotes);
  // Hooks the notebook shape shelf reads to list desktop-pinned notes
  // (same shape as the Desktop's other window.__hush* bridges).
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
    const width = clampSize(s.width);
    const height = clampSize(s.height);
    const note = {
      id: s.id, kind: s.kind, target: s.target,
      x: clampAxis(s.x ?? 40, width, window.innerWidth),
      y: clampAxis(s.y ?? 40, HEADER_HEIGHT, window.innerHeight),
      width, height,
      collapsed: !!s.collapsed,
      fontSize: clampFont(s.fontSize),
      text: typeof s.text === "string" ? s.text : "",
      createdAt: s.createdAt || Date.now(),
    };
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
    if (typeof s.wx === "number" && typeof s.wy === "number") { note.wx = s.wx; note.wy = s.wy; }
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

  // Context button — replaces the old text label. Shows the current
  // scope's glyph; clicking opens the Document / Desk / App switcher.
  const ctxBtn = document.createElement("button");
  ctxBtn.className = "sticky-note-btn sticky-note-context";
  ctxBtn.innerHTML = ctxIconFor(note.kind);
  ctxBtn.title = labelFor(note);
  ctxBtn.setAttribute("aria-label", "Change context (Document / Desk / App)");
  ctxBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleContextMenu(note, ctxBtn);
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
  note._ctxBtn = ctxBtn;
  note._excerptEl = excerpt;
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
  if (note.collapsed && note._excerptEl) note._excerptEl.textContent = excerptFor(note.text);
  schedulePersist();
}

// ── Context switcher ──────────────────────────────────────────────────

let activeMenu = null;
let activeMenuCleanup = null;

function closeContextMenu() {
  if (activeMenu) { activeMenu.remove(); activeMenu = null; }
  if (activeMenuCleanup) { activeMenuCleanup(); activeMenuCleanup = null; }
}

/** Does scope `key` describe the note's current attachment? Project and
 *  file notes both read as "Document" (they share the pink body). */
function contextKeyMatches(kind, key) {
  if (key === "file") return kind === "file" || kind === "project" || kind === "desktop";
  return kind === key;
}

/** Can the note be switched to scope `key` right now? Document needs a
 *  file on screen to attach to; Desk needs an active desk; App is always
 *  available. */
function contextAvailable(key) {
  if (key === "file") return !!currentFileContext(appState);
  if (key === "desk") return !!(appState?.getActiveDesk?.()?.id);
  return true;
}

function toggleContextMenu(note, anchorBtn) {
  if (activeMenu && activeMenu._noteId === note.id) { closeContextMenu(); return; }
  closeContextMenu();
  activateNote(note);

  const menu = document.createElement("div");
  menu.className = "sticky-context-menu";
  menu._noteId = note.id;
  for (const opt of CTX_MENU) {
    const isCurrent = contextKeyMatches(note.kind, opt.key);
    const available = contextAvailable(opt.key);
    const row = document.createElement("button");
    row.className = "sticky-context-option" + (isCurrent ? " current" : "");
    row.innerHTML = `<span class="sticky-ctx-ico">${CTX_ICON[opt.key]}</span><span>${opt.label}</span>`;
    if (!available && !isCurrent) row.disabled = true;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      closeContextMenu();
      if (available && !isCurrent) changeContext(note, opt.key);
    });
    menu.appendChild(row);
  }

  // The note itself is overflow:hidden, so the menu lives in the
  // full-screen sticky container and is positioned to the button. It
  // must out-stack the notes too — every note carries an inline
  // z-index from zCounter, and a z:auto sibling would paint *behind*
  // the very note that opened it (the menu overlaps the note body).
  const rect = anchorBtn.getBoundingClientRect();
  menu.style.left = Math.round(rect.left) + "px";
  menu.style.top = Math.round(rect.bottom + 4) + "px";
  menu.style.zIndex = ++zCounter;
  ensureContainer().appendChild(menu);
  activeMenu = menu;
  // Nudge back on screen if it would spill off the right / bottom edge.
  const mrect = menu.getBoundingClientRect();
  if (mrect.right > window.innerWidth - 8) {
    menu.style.left = Math.round(window.innerWidth - 8 - mrect.width) + "px";
  }
  if (mrect.bottom > window.innerHeight - 8) {
    menu.style.top = Math.round(rect.top - 4 - mrect.height) + "px";
  }

  const onDown = (e) => {
    // Clicks inside the menu are handled by the option buttons; clicks on
    // a context button are left for its own handler to toggle the menu.
    if (e.target instanceof Element
        && e.target.closest(".sticky-context-menu, .sticky-note-context")) return;
    closeContextMenu();
  };
  const onKey = (e) => { if (e.key === "Escape") closeContextMenu(); };
  setTimeout(() => {
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
  }, 0);
  activeMenuCleanup = () => {
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
  };
}

/** Re-attach the note to a new scope, repaint its colour + glyph, and
 *  re-evaluate whether it's visible on the current surface. */
function changeContext(note, key) {
  let target = null;
  if (key === "file") {
    target = currentFileContext(appState);
    if (!target) return;
  } else if (key === "desk") {
    target = appState?.getActiveDesk?.()?.id || null;
    if (!target) return;
  }
  note.el.classList.remove("sticky-file", "sticky-project", "sticky-desk", "sticky-global", "sticky-desktop");
  delete note.wx;
  delete note.wy;
  note.kind = key;
  note.target = target;
  note.el.classList.add("sticky-" + key);
  if (note._ctxBtn) {
    note._ctxBtn.innerHTML = ctxIconFor(key);
    note._ctxBtn.title = labelFor(note);
  }
  refreshVisibility();
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
      // Desktop-pinned notes store their position in canvas world
      // coordinates — write the drop point back through the camera.
      if (note.kind === "desktop") {
        const toWorld = window.__hushDesktopScreenToWorld;
        const w = toWorld ? toWorld({ x: note.x, y: note.y }) : null;
        if (w) { note.wx = w.x; note.wy = w.y; }
      }
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
      // A desktop-pinned note is drawn scaled, so a pointer travel of N
      // screen px is only N/zoom of its own (unscaled) size — and when a
      // w/n handle shrinks it, its top-left slides by the *scaled* delta.
      const z = note.kind === "desktop" ? desktopZoom() : 1;
      handle.setPointerCapture(e.pointerId);
      const onMove = (me) => {
        const dx = (me.clientX - startX) / z;
        const dy = (me.clientY - startY) / z;
        let w = startW, h = startH, nx = startLeft, ny = startTop;
        if (dir.includes("e")) w = clampSize(startW + dx);
        if (dir.includes("w")) { w = clampSize(startW - dx); nx = startLeft + (startW - w) * z; }
        if (dir.includes("s")) h = clampSize(startH + dy);
        if (dir.includes("n")) { h = clampSize(startH - dy); ny = startTop + (startH - h) * z; }
        note.width = w; note.height = h; note.x = nx; note.y = ny;
        Object.assign(note.el.style, { width: w + "px", height: h + "px", left: nx + "px", top: ny + "px" });
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        // A w/n handle moves the origin, so re-derive the world anchor —
        // otherwise the next camera change snaps the note back.
        if (note.kind === "desktop") {
          const w = window.__hushDesktopScreenToWorld?.({ x: note.x, y: note.y });
          if (w) { note.wx = w.x; note.wy = w.y; }
        }
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
  if (changed) schedulePersist();
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
