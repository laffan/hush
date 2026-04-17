/**
 * Floating pane manager — draggable reference panes over the editor/canvas.
 * Attach: anchors to canvas (notebooks) or scroll (docs).
 * Pin: persists across document switches (blue header).
 * Attach and pin are mutually exclusive.
 */

import { createPaneEditor } from "./pane-editor.js";
import { attachEditorTextDrag, attachNotebookTextShapeDrag } from "./text-drag.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

// ── Module state ──────────────────────────────────────────────────────
let panes = new Map();       // id → pane object
let activePaneId = null;
let zCounter = 1000;
let containerEl = null;
let appState = null;
let autosaveTimer = null;
let _syncing = false;        // guard against infinite sync loops

const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 340;
const MIN_WIDTH = 240;
const MIN_HEIGHT = 60;
const TITLEBAR_HEIGHT = 35;

// ── SVG icons ─────────────────────────────────────────────────────────
const ICON_CLOSE = `<svg viewBox="0 0 10 10"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>`;
const ICON_ATTACH = `<svg viewBox="0 0 10 10"><circle cx="5" cy="3.5" r="2"/><line x1="5" y1="5.5" x2="5" y2="9"/></svg>`;
const ICON_PIN = `<svg viewBox="0 0 10 10"><line x1="5" y1="1" x2="5" y2="7"/><line x1="2.5" y1="4" x2="7.5" y2="4"/><line x1="5" y1="7" x2="5" y2="9.5"/></svg>`;

// ── Public API ────────────────────────────────────────────────────────

export function initPaneManager(state) {
  appState = state;
  containerEl = document.getElementById("pane-container");
  autosaveTimer = setInterval(autosaveAllPanes, 2000);
  state.on("theme-changed", syncPaneThemes);
  state.on("style-changed", syncPaneThemes);
  getNotebookBridge().catch(() => {});
  // Deactivate panes when clicking anywhere outside a pane
  window.addEventListener("pointerdown", (e) => {
    if (!activePaneId) return;
    if (e.target instanceof Element && e.target.closest(".floating-pane")) return;
    saveAllPanes();
    deactivateAllPanes();
  }, true);
  // Show/hide panes when the active document changes
  state.on("file-opened", onContextChange);
  state.on("notebook-open", onContextChange);
  state.on("notebook-unmount", onContextChange);

  // Restore any panes that were open when the app last closed
  restorePanes().catch((e) => console.error("Pane restore failed:", e));
}

/** Returns an opaque string identifying the current doc/notebook/project. */
function getCurrentContext() {
  if (appState.currentNotebookFileId) return "nb:" + appState.currentNotebookFileId;
  if (appState.currentProjectId) return "pj:" + appState.currentProjectId;
  if (appState.currentFileId) return "doc:" + appState.currentFileId;
  return "";
}

/** Hide non-pinned panes that don't belong to the new context; show ones that do. */
function onContextChange() {
  const ctx = getCurrentContext();
  for (const [, pane] of panes) {
    if (pane.pinned) {
      // Pinned panes stay visible in every context
      pane.el.style.display = "";
      continue;
    }
    if (pane.ownerContext === ctx) {
      pane.el.style.display = "";
      // Restart attach sync if needed (was stopped when hidden)
      if (pane.attached && !pane._syncFrame && !pane._scrollHandler) {
        if (appState.currentNotebookFileId) startCanvasSync(pane);
        else startScrollSync(pane);
      }
    } else {
      // Hide and deactivate
      pane.el.style.display = "none";
      if (pane.attached) stopAttachSync(pane);
      if (activePaneId === pane.id) {
        pane.el.classList.remove("active");
        if (pane.editor) { pane.editor.blur(); pane.editor.setEditable(false); }
        activePaneId = null;
      }
    }
  }
  notifyLayoutChange();
}

function notifyLayoutChange() {
  let hasPane = false;
  for (const [, p] of panes) {
    if (p.el.style.display !== "none") { hasPane = true; break; }
  }
  appState._hasVisibleDocPane = hasPane;
  if (appState._columnResizeHandler) appState._columnResizeHandler();
}

export function destroyPaneManager() {
  clearInterval(autosaveTimer);
  for (const [id] of panes) closePane(id);
  panes.clear();
  activePaneId = null;
}

export async function createPane(fileId, fileName, fileType, x, y, opts = {}) {
  // Don't open duplicate panes for the same file in the same context
  // (skip check when explicitly duplicating via opts.allowDuplicate)
  if (!opts.allowDuplicate) {
    const ctx = opts.ownerContext || getCurrentContext();
    for (const [, p] of panes) {
      if (p.fileId === fileId && p.ownerContext === ctx) { focusPane(p.id); return; }
    }
  }

  const id = crypto.randomUUID();
  const pane = {
    id,
    fileId,
    fileName,
    fileType,
    collapsed: false,
    attached: false,  // anchored to canvas (notebook) or scroll (doc)
    pinned: false,    // persists across document switches (blue header)
    dirty: false,
    editor: null,       // CodeMirror wrapper (docs)
    notebook: null,     // NotesCanvas instance (notebooks)
    el: null,           // root DOM element
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    x: Math.max(0, x - DEFAULT_WIDTH / 2),
    y: Math.max(0, y - TITLEBAR_HEIGHT / 2),
    // Owner context: which doc/notebook/project was active when pane was created
    ownerContext: opts.ownerContext || getCurrentContext(),
  };

  buildPaneDOM(pane);
  containerEl.appendChild(pane.el);
  pane.el.style.zIndex = ++zCounter;
  panes.set(id, pane);
  await loadPaneContent(pane);
  if (!opts.skipFocus) focusPane(id);
  notifyLayoutChange();
  schedulePersist();
}

export function closePane(id) {
  const pane = panes.get(id);
  if (!pane) return;
  // Save before closing
  savePaneContent(pane);
  // Remove sync listeners
  if (pane._mainSyncHandler) appState.off("doc-content-changed", pane._mainSyncHandler);
  if (pane._mainNbSyncHandler) appState.off("notebook-shapes-changed", pane._mainNbSyncHandler);
  // Stop attach sync
  if (pane.attached) stopAttachSync(pane);
  // Destroy editor/notebook
  if (pane.editor) pane.editor.destroy();
  if (pane.notebook) pane.notebook.destroy();
  pane.el.remove();
  panes.delete(id);
  if (activePaneId === id) activePaneId = null;
  notifyLayoutChange();
  schedulePersist();
}

export function focusPane(id) {
  // Save, blur, and lock previously focused pane
  if (activePaneId && activePaneId !== id) {
    const prev = panes.get(activePaneId);
    if (prev) {
      savePaneContent(prev);
      prev.el.classList.remove("active");
      if (prev.editor) { prev.editor.blur(); prev.editor.setEditable(false); }
    }
  }
  activePaneId = id;
  const pane = panes.get(id);
  if (!pane) return;
  pane.el.classList.add("active");
  pane.el.style.zIndex = ++zCounter;
  // Unlock and focus the inner editor / re-center notebook toolbar
  if (pane.editor) { pane.editor.setEditable(true); pane.editor.focus(); }
  if (pane.notebook) pane.notebook.state.notify("tool");
}

export function deactivateAllPanes() {
  if (activePaneId) {
    const pane = panes.get(activePaneId);
    if (pane) {
      savePaneContent(pane);
      pane.el.classList.remove("active");
      // Blur + lock the editor so it can't receive keyboard input
      if (pane.editor) { pane.editor.blur(); pane.editor.setEditable(false); }
    }
  }
  activePaneId = null;
}
export function getActivePaneId() { return activePaneId; }
export function hasPanes() { return panes.size > 0; }
export function isPaneActive() { return activePaneId !== null; }

// ── DOM construction ──────────────────────────────────────────────────
function buildPaneDOM(pane) {
  const el = document.createElement("div");
  el.className = "floating-pane";
  Object.assign(el.style, { left: pane.x + "px", top: pane.y + "px", width: pane.width + "px", height: pane.height + "px" });
  // Title bar
  const titlebar = document.createElement("div");
  titlebar.className = "floating-pane-titlebar";
  const title = document.createElement("span");
  title.className = "floating-pane-title";
  const titleLink = document.createElement("span");
  titleLink.className = "fp-title-link";
  titleLink.textContent = pane.fileName;
  titleLink.addEventListener("click", (e) => { e.stopPropagation(); pane.fileType === "notebook" ? appState.openNotebook(pane.fileId) : appState.openFile(pane.fileId); });
  title.appendChild(titleLink);
  titlebar.appendChild(title);

  const buttons = document.createElement("span");
  buttons.className = "floating-pane-buttons";

  // Attach button: anchor to canvas (notebook) or scroll (doc)
  const attachLabel = appState.currentNotebookFileId ? "Attach to canvas" : "Attach to document";
  const attachBtn = makeBtn("attach", ICON_ATTACH, attachLabel);
  attachBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleAttach(pane); });
  buttons.appendChild(attachBtn);
  const pinBtn = makeBtn("pin", ICON_PIN, "Pin (keep across documents)");
  pinBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePinned(pane); });
  buttons.appendChild(pinBtn);
  const closeBtn = makeBtn("close", ICON_CLOSE, "Close");
  closeBtn.addEventListener("click", (e) => { e.stopPropagation(); closePane(pane.id); });
  buttons.appendChild(closeBtn);

  titlebar.appendChild(buttons);
  el.appendChild(titlebar);

  // Content area
  const content = document.createElement("div");
  content.className = "floating-pane-content";
  el.appendChild(content);

  // Resize handles (8 directions)
  for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
    const handle = document.createElement("div");
    handle.className = `fp-resize fp-resize-${dir}`;
    handle.dataset.dir = dir;
    el.appendChild(handle);
  }

  pane.el = el;
  pane._content = content;
  pane._titlebar = titlebar;
  // Event wiring
  setupPaneDrag(pane);
  setupPaneResize(pane);
  titlebar.addEventListener("dblclick", (e) => { if (!e.target.closest(".floating-pane-btn, .fp-title-link")) toggleCollapse(pane); });
  el.addEventListener("pointerdown", () => focusPane(pane.id));
}

function makeBtn(name, svg, ariaLabel) {
  const btn = document.createElement("button");
  btn.className = `floating-pane-btn fp-btn-${name}`;
  btn.innerHTML = svg;
  btn.title = ariaLabel;
  btn.setAttribute("aria-label", ariaLabel);
  return btn;
}

// ── Drag (title bar) ──────────────────────────────────────────────────

function setupPaneDrag(pane) {
  let startX, startY, startLeft, startTop, startCanvasX, startCanvasY;

  pane._titlebar.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".floating-pane-btn, .fp-title-link")) return;
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = pane.el.offsetLeft;
    startTop = pane.el.offsetTop;
    // Option+drag: spawn a static duplicate at the source position; the
    // pane being dragged stays on top (skipFocus keeps the duplicate from
    // stealing z-index when its async load finishes).
    if (e.altKey) {
      createPane(pane.fileId, pane.fileName, pane.fileType,
        startLeft + pane.width / 2, startTop + TITLEBAR_HEIGHT / 2,
        { allowDuplicate: true, ownerContext: getCurrentContext(), skipFocus: true });
      pane.el.style.zIndex = ++zCounter;
    }
    // Snapshot canvas coords for attached panes (notebook mode)
    if (pane.attached && appState.currentNotebookFileId) {
      startCanvasX = pane._canvasX;
      startCanvasY = pane._canvasY;
    }
    pane._titlebar.setPointerCapture(e.pointerId);

    const onMove = (me) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      if (pane.attached && appState.currentNotebookFileId) {
        // Convert screen delta to canvas delta (account for zoom)
        const canvas = _notebookBridge?.getCanvasInstance();
        const zoom = canvas ? canvas.state.camera.zoom : 1;
        pane._canvasX = startCanvasX + dx / zoom;
        pane._canvasY = startCanvasY + dy / zoom;
        // Screen position updates via the canvas sync loop
      } else if (pane.attached && !appState.currentNotebookFileId) {
        // Doc-attached: update both screen position and scroll-relative Y
        pane.x = startLeft + dx;
        pane.y = startTop + dy;
        pane._scrollRelY = pane.y + (appState.editor?.view.scrollDOM.scrollTop || 0);
        pane.el.style.left = pane.x + "px";
        pane.el.style.top = pane.y + "px";
      } else {
        pane.x = startLeft + dx;
        pane.y = startTop + dy;
        pane.el.style.left = pane.x + "px";
        pane.el.style.top = pane.y + "px";
      }
    };

    const onUp = () => {
      pane._titlebar.removeEventListener("pointermove", onMove);
      pane._titlebar.removeEventListener("pointerup", onUp);
      schedulePersist();
    };

    pane._titlebar.addEventListener("pointermove", onMove);
    pane._titlebar.addEventListener("pointerup", onUp);
  });
}

// ── Resize (edge/corner handles) ──────────────────────────────────────

function setupPaneResize(pane) {
  for (const handle of pane.el.querySelectorAll(".fp-resize")) {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dir = handle.dataset.dir;
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = pane.width;
      const startH = pane.height;
      const startLeft = pane.x;
      const startTop = pane.y;

      handle.setPointerCapture(e.pointerId);

      const onMove = (me) => {
        const dx = me.clientX - startX, dy = me.clientY - startY;
        let w = startW, h = startH, nx = startLeft, ny = startTop;
        if (dir.includes("e")) w = Math.max(MIN_WIDTH, startW + dx);
        if (dir.includes("w")) { w = Math.max(MIN_WIDTH, startW - dx); nx = startLeft + (startW - w); }
        if (dir.includes("s")) h = Math.max(MIN_HEIGHT, startH + dy);
        if (dir.includes("n")) { h = Math.max(MIN_HEIGHT, startH - dy); ny = startTop + (startH - h); }
        pane.width = w; pane.height = h; pane.x = nx; pane.y = ny;
        Object.assign(pane.el.style, { width: w + "px", height: h + "px", left: nx + "px", top: ny + "px" });
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
// ── Collapse / Expand ─────────────────────────────────────────────────

function toggleCollapse(pane) {
  pane.collapsed = !pane.collapsed;
  if (pane.collapsed) {
    pane._savedHeight = pane.height;
    pane.el.classList.add("collapsed");
    pane.el.style.height = TITLEBAR_HEIGHT + "px";
  } else {
    pane.el.classList.remove("collapsed");
    pane.height = pane._savedHeight || DEFAULT_HEIGHT;
    pane.el.style.height = pane.height + "px";
  }
  schedulePersist();
}

// ── Attach (anchor to canvas or document scroll) ─────────────────────
async function toggleAttach(pane) {
  if (pane.pinned) {
    if (!confirm("This pane is pinned globally. Attaching will remove the pin. Continue?")) return;
    setPinned(pane, false);
  }

  pane.attached = !pane.attached;
  const btn = pane.el.querySelector(".fp-btn-attach");
  if (btn) btn.classList.toggle("attach-active", pane.attached);

  if (pane.attached) {
    if (appState.currentNotebookFileId) {
      // Notebook: attach to canvas coordinates
      await getNotebookBridge();
      const canvasPos = screenToCanvas(pane.x, pane.y);
      if (canvasPos) { pane._canvasX = canvasPos.x; pane._canvasY = canvasPos.y; }
      startCanvasSync(pane);
    } else {
      // Doc: attach to scroll position
      const scrollTop = appState.editor?.view.scrollDOM.scrollTop || 0;
      pane._scrollRelY = pane.y + scrollTop;
      startScrollSync(pane);
    }
  } else {
    stopAttachSync(pane);
  }
  schedulePersist();
}

// ── Pin (global / cross-document persistence, blue header) ────────────
function togglePinned(pane) {
  if (pane.attached) {
    if (!confirm("This pane is attached. Pinning will remove the attachment. Continue?")) return;
    pane.attached = false;
    stopAttachSync(pane);
    const aBtn = pane.el.querySelector(".fp-btn-attach");
    if (aBtn) aBtn.classList.remove("attach-active");
  }

  setPinned(pane, !pane.pinned);
}

function setPinned(pane, value) {
  pane.pinned = value;
  const btn = pane.el.querySelector(".fp-btn-pin");
  if (btn) btn.classList.toggle("pin-active", pane.pinned);
  pane.el.classList.toggle("pinned", pane.pinned);
  // When unpinning, pane returns to its original context — hide if not current
  if (!value) onContextChange();
  schedulePersist();
}

// Cache the notebook bridge module to avoid async calls in animation loops
let _notebookBridge = null;

async function getNotebookBridge() {
  if (!_notebookBridge) {
    _notebookBridge = await import("../notebook/notebook-bridge.js");
  }
  return _notebookBridge;
}

function screenToCanvas(screenX, screenY) {
  if (!_notebookBridge) return null;
  const canvas = _notebookBridge.getCanvasInstance();
  if (!canvas) return null;
  const cam = canvas.state.camera;
  return {
    x: (screenX - cam.x) / cam.zoom,
    y: (screenY - cam.y) / cam.zoom,
  };
}

function canvasToScreen(canvasX, canvasY) {
  if (!_notebookBridge) return null;
  const canvas = _notebookBridge.getCanvasInstance();
  if (!canvas) return null;
  const cam = canvas.state.camera;
  return {
    x: canvasX * cam.zoom + cam.x,
    y: canvasY * cam.zoom + cam.y,
  };
}

function startCanvasSync(pane) {
  function tick() {
    if (!pane.attached || !panes.has(pane.id)) return;
    const pos = canvasToScreen(pane._canvasX, pane._canvasY);
    if (pos) {
      pane.x = pos.x;
      pane.y = pos.y;
      pane.el.style.left = pos.x + "px";
      pane.el.style.top = pos.y + "px";
    }
    pane._syncFrame = requestAnimationFrame(tick);
  }
  tick();
}

function startScrollSync(pane) {
  const scrollDOM = appState.editor?.view.scrollDOM;
  if (!scrollDOM) return;
  pane._scrollHandler = () => {
    if (!pane.attached || !panes.has(pane.id)) return;
    const scrollTop = scrollDOM.scrollTop;
    pane.y = pane._scrollRelY - scrollTop;
    pane.el.style.top = pane.y + "px";
  };
  scrollDOM.addEventListener("scroll", pane._scrollHandler);
  // Sync once immediately so restored attach positions don't wait for a scroll
  pane._scrollHandler();
}

function stopAttachSync(pane) {
  // Stop canvas sync (notebook)
  if (pane._syncFrame) {
    cancelAnimationFrame(pane._syncFrame);
    pane._syncFrame = null;
  }
  // Stop scroll sync (doc)
  if (pane._scrollHandler) {
    const scrollDOM = appState.editor?.view.scrollDOM;
    if (scrollDOM) scrollDOM.removeEventListener("scroll", pane._scrollHandler);
    pane._scrollHandler = null;
  }
}

// ── Content loading ───────────────────────────────────────────────────

async function loadPaneContent(pane) {
  if (pane.fileType === "document") {
    await loadDocumentPane(pane);
  } else if (pane.fileType === "notebook") {
    await loadNotebookPane(pane);
  }
}

async function loadDocumentPane(pane) {
  const editor = createPaneEditor(pane._content, appState, () => {
    pane.dirty = true;
    syncDocFromPane(pane);
  });
  pane.editor = editor;

  // Load file content
  let content = "";
  try {
    if (IS_TAURI) {
      const file = await tauriInvoke("load_file", { id: pane.fileId });
      content = file.content || "";
    }
  } catch (e) {
    console.error("Failed to load pane file:", e);
  }
  editor.setContent(content);

  // Listen for main editor changes to sync back into this pane
  pane._mainSyncHandler = () => syncDocToPane(pane);
  appState.on("doc-content-changed", pane._mainSyncHandler);

  // Cmd+drag a selection out of this pane to drop into another editor
  // or a notebook canvas.
  attachEditorTextDrag(pane.editor.view, pane._content);
  // Cmd+drag image chips / raw image refs in a pane so they can be moved
  // between panes just like any other markdown text.
  import("../editor/plugins/image-decorator.js").then((m) => {
    if (pane.editor && pane._content) m.attachImageDrag(pane.editor.view, pane._content, appState);
  });
}

async function loadNotebookPane(pane) {
  const { NotesCanvas } = await import("../notebook/notes-canvas.ts");
  const { computeNotebookSettings } = await import("../notebook/notebook-bridge.js");
  const s = appState.settings;
  const shortcuts = {
    shortcutNbSelect: s.shortcutNbSelect,
    shortcutNbText: s.shortcutNbText,
    shortcutNbDragArea: s.shortcutNbDragArea,
    shortcutNbBrainstorm: s.shortcutNbBrainstorm,
    shortcutNbDelete: s.shortcutNbDelete,
    shortcutNbUndo: s.shortcutNbUndo,
    shortcutNbRedo: s.shortcutNbRedo,
    shortcutNbGroup: s.shortcutNbGroup,
    shortcutNbUngroup: s.shortcutNbUngroup,
  };

  const canvas = new NotesCanvas(pane._content, shortcuts);
  pane.notebook = canvas;

  // Inherit the current Hush editor style (appearance/theme/font/grid)
  canvas.applySettings(computeNotebookSettings(appState));

  // Load shapes
  let shapes = [];
  try {
    if (IS_TAURI) {
      const file = await tauriInvoke("load_file", { id: pane.fileId });
      if (file.content && file.content.trim()) {
        shapes = JSON.parse(file.content);
      }
    }
  } catch (e) {
    console.error("Failed to load notebook pane shapes:", e);
  }

  if (Array.isArray(shapes) && shapes.length > 0) {
    canvas.loadShapes(shapes);
  }

  // Center the pane on the same canvas point the notebook would show
  // when opened normally (i.e. the centre of the main notebook viewport
  // with the default camera). Without this the pane shows the canvas
  // origin in its top-left corner. Deferred to the next frame so
  // pane._content has its final layout size.
  requestAnimationFrame(() => {
    if (!canvas.state || !pane._content) return;
    const mainC = document.getElementById("notebook-container");
    const mainW = (mainC && mainC.clientWidth) || window.innerWidth;
    const mainH = (mainC && mainC.clientHeight) || window.innerHeight;
    const paneW = pane._content.clientWidth || pane.width;
    const paneH = pane._content.clientHeight || pane.height;
    canvas.state.camera = { x: (paneW - mainW) / 2, y: (paneH - mainH) / 2, zoom: 1 };
    canvas.state.notify("camera");
  });

  // Mark dirty + propagate shapes to main canvas on changes
  pane._content.addEventListener("notebook-change", () => {
    pane.dirty = true;
    syncNotebookFromPane(pane);
  });

  // Listen for main canvas changes to sync back into this pane
  pane._mainNbSyncHandler = () => syncNotebookToPane(pane);
  appState.on("notebook-shapes-changed", pane._mainNbSyncHandler);

  // Cmd+drag a text shape out of this notebook pane to drop into an editor.
  const nbCanvas = pane._content.querySelector("canvas");
  if (nbCanvas && pane.notebook) {
    try {
      const { findShapeAtPoint, hitTestLink } = await import("../notebook/state-helpers.ts");
      attachNotebookTextShapeDrag(
        nbCanvas,
        pane._content,
        pane.notebook.state,
        {
          findTextShapeAt: (shapes, pt) => {
            const hit = findShapeAtPoint(pt, shapes, pane.notebook.state.fontFamily);
            return hit && hit.type === "text" ? hit : null;
          },
          hitTestLink,
        },
        () => { pane.dirty = true; },
      );
    } catch (e) {
      console.error("Failed to wire notebook pane text-drag:", e);
    }
  }
}

// ── Saving ────────────────────────────────────────────────────────────
async function savePaneContent(pane) {
  if (!pane.dirty) return;
  pane.dirty = false;
  try {
    if (IS_TAURI) {
      let content = "";
      if (pane.fileType === "document" && pane.editor) {
        content = pane.editor.getContent();
      } else if (pane.fileType === "notebook" && pane.notebook) {
        content = JSON.stringify(pane.notebook.getShapes());
      }
      await tauriInvoke("save_file", { id: pane.fileId, content });
    }
  } catch (e) {
    console.error("Failed to save pane content:", e);
  }
}

function autosaveAllPanes() {
  for (const [, pane] of panes) {
    if (pane.dirty) savePaneContent(pane);
  }
}

// ── Theme sync ────────────────────────────────────────────────────────
async function syncPaneThemes() {
  let nbSettings = null;
  for (const [, pane] of panes) {
    if (pane.editor?.reconfigureTheme) pane.editor.reconfigureTheme(appState.settings);
    if (pane.notebook) {
      if (!nbSettings) {
        const bridge = await getNotebookBridge();
        nbSettings = bridge.computeNotebookSettings(appState);
      }
      pane.notebook.applySettings(nbSettings);
    }
  }
}

// ── Persistence (settings.persistedPanes) ─────────────────────────────

let _persistTimer = null;
function schedulePersist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    persistPanesNow();
  }, 300);
}

function persistPanesNow() {
  if (!appState) return;
  const serialized = [];
  for (const [, p] of panes) {
    serialized.push({
      fileId: p.fileId,
      fileName: p.fileName,
      fileType: p.fileType,
      collapsed: !!p.collapsed,
      attached: !!p.attached,
      pinned: !!p.pinned,
      width: p.width,
      height: p.height,
      x: p.x,
      y: p.y,
      ownerContext: p.ownerContext || "",
      canvasX: p._canvasX ?? null,
      canvasY: p._canvasY ?? null,
      scrollRelY: p._scrollRelY ?? null,
    });
  }
  appState.updateSettings({ persistedPanes: serialized });
}

async function restorePanes() {
  if (!appState) return;
  const list = appState.settings?.persistedPanes;
  if (!Array.isArray(list) || list.length === 0) return;

  for (const s of list) {
    if (!s || !s.fileId || !s.fileType) continue;

    // Resolve current file name (may have been renamed since persist)
    const file = (appState.files || []).find((f) => f.id === s.fileId);
    if (!file) continue; // File was deleted — drop pane

    const id = crypto.randomUUID();
    const pane = {
      id,
      fileId: s.fileId,
      fileName: file.name || s.fileName || "Untitled",
      fileType: s.fileType,
      collapsed: !!s.collapsed,
      attached: false, // we'll re-apply attach below after content loads
      pinned: !!s.pinned,
      dirty: false,
      editor: null,
      notebook: null,
      el: null,
      width: s.width || DEFAULT_WIDTH,
      height: s.height || DEFAULT_HEIGHT,
      x: s.x || 0,
      y: s.y || 0,
      ownerContext: s.ownerContext || "",
    };
    if (s.canvasX != null) pane._canvasX = s.canvasX;
    if (s.canvasY != null) pane._canvasY = s.canvasY;
    if (s.scrollRelY != null) pane._scrollRelY = s.scrollRelY;

    buildPaneDOM(pane);
    containerEl.appendChild(pane.el);
    pane.el.style.zIndex = ++zCounter;
    panes.set(id, pane);
    await loadPaneContent(pane);

    // Re-apply pinned / collapsed visual state
    if (pane.pinned) {
      pane.el.classList.add("pinned");
      const pinBtn = pane.el.querySelector(".fp-btn-pin");
      if (pinBtn) pinBtn.classList.add("pin-active");
    }
    if (pane.collapsed) {
      pane._savedHeight = pane.height;
      pane.el.classList.add("collapsed");
      pane.el.style.height = TITLEBAR_HEIGHT + "px";
    }
    // Re-apply attach state (starts sync if appropriate context)
    if (s.attached) {
      pane.attached = true;
      const aBtn = pane.el.querySelector(".fp-btn-attach");
      if (aBtn) aBtn.classList.add("attach-active");
    }
  }

  // Hide panes that don't belong in the current context and start sync
  // for those that do.
  onContextChange();
}

// ── Save all panes (called on focus switch to main editor) ────────────
export function saveAllPanes() {
  for (const [, pane] of panes) {
    savePaneContent(pane);
  }
}

// ── Content sync (pane ↔ main editor) ─────────────────────────────────
function syncDocFromPane(pane) {
  if (_syncing || pane.fileType !== "document" || !pane.editor) return;
  if (pane.fileId !== appState.currentFileId || !appState.editor) return;
  _syncing = true;
  const content = pane.editor.getContent();
  const mainView = appState.editor.view;
  // Preserve main cursor position where possible
  const mainSel = mainView.state.selection.main;
  const anchor = Math.min(mainSel.anchor, content.length);
  const head = Math.min(mainSel.head, content.length);
  appState._syncPulling = true;
  appState.editor.setContent(content);
  try { mainView.dispatch({ selection: { anchor, head } }); } catch (_) {}
  appState._syncPulling = false;
  _syncing = false;
}

function syncDocToPane(pane) {
  if (_syncing || pane.fileType !== "document" || !pane.editor) return;
  if (pane.fileId !== appState.currentFileId) return;
  _syncing = true;
  const content = appState.editor.getContent();
  const paneView = pane.editor.view;
  const paneSel = paneView.state.selection.main;
  const anchor = Math.min(paneSel.anchor, content.length);
  const head = Math.min(paneSel.head, content.length);
  pane.editor.setContent(content);
  try { paneView.dispatch({ selection: { anchor, head } }); } catch (_) {}
  // Don't mark pane dirty — this came from the main editor
  pane.dirty = false;
  _syncing = false;
}

function syncNotebookFromPane(pane) {
  if (_syncing || pane.fileType !== "notebook" || !pane.notebook) return;
  if (pane.fileId !== appState.currentNotebookFileId || !_notebookBridge) return;
  const mainCanvas = _notebookBridge.getCanvasInstance();
  if (!mainCanvas) return;

  _syncing = true;
  const shapes = pane.notebook.getShapes();
  mainCanvas.loadShapes(JSON.parse(JSON.stringify(shapes)));
  // Defer reset: loadShapes triggers change events via queueMicrotask,
  // so _syncing must stay true until those microtasks have fired.
  queueMicrotask(() => queueMicrotask(() => { _syncing = false; }));
}

function syncNotebookToPane(pane) {
  if (_syncing || pane.fileType !== "notebook" || !pane.notebook) return;
  if (pane.fileId !== appState.currentNotebookFileId || !_notebookBridge) return;
  const mainCanvas = _notebookBridge.getCanvasInstance();
  if (!mainCanvas) return;

  _syncing = true;
  const shapes = mainCanvas.getShapes();
  pane.notebook.loadShapes(JSON.parse(JSON.stringify(shapes)));
  pane.dirty = false;
  // Defer reset: same microtask timing issue as above
  queueMicrotask(() => queueMicrotask(() => { _syncing = false; }));
}
