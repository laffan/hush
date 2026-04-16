/**
 * Floating pane manager — creates, tracks, and controls draggable panes
 * that appear when files are dragged from the sidebar into the editor
 * or notebook area.
 *
 * Each pane is a resizable, draggable window-within-a-window that holds
 * either a CodeMirror editor (for documents) or a NotesCanvas (for
 * notebooks).  Panes support collapse, close, focus management, and
 * in notebook mode a "pin" action that anchors the pane to the canvas.
 */

import { createPaneEditor } from "./pane-editor.js";

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
const TITLEBAR_HEIGHT = 20;

// ── SVG icons ─────────────────────────────────────────────────────────
const ICON_CLOSE = `<svg viewBox="0 0 10 10"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>`;
const ICON_COLLAPSE = `<svg viewBox="0 0 10 10"><line x1="2" y1="5" x2="8" y2="5"/></svg>`;
const ICON_EXPAND = `<svg viewBox="0 0 10 10"><rect x="2" y="2" width="6" height="6" rx="0.5"/></svg>`;
const ICON_PIN = `<svg viewBox="0 0 10 10"><circle cx="5" cy="3.5" r="2"/><line x1="5" y1="5.5" x2="5" y2="9"/></svg>`;

// ── Public API ────────────────────────────────────────────────────────

export function initPaneManager(state) {
  appState = state;
  containerEl = document.getElementById("pane-container");
  // Start autosave loop for pane editors
  autosaveTimer = setInterval(autosaveAllPanes, 2000);
  // Sync pane themes when the main editor theme changes
  state.on("theme-changed", syncPaneThemes);
  state.on("style-changed", syncPaneThemes);
  // Pre-cache notebook bridge for canvas sync
  getNotebookBridge().catch(() => {});
}

export function destroyPaneManager() {
  clearInterval(autosaveTimer);
  for (const [id] of panes) closePane(id);
  panes.clear();
  activePaneId = null;
}

/**
 * Create a new floating pane for the given file.
 * @param {string} fileId   Backing file UUID
 * @param {string} fileName Display name
 * @param {string} fileType "document" or "notebook"
 * @param {number} x        Initial screen X
 * @param {number} y        Initial screen Y
 */
export async function createPane(fileId, fileName, fileType, x, y) {
  // Don't open duplicate panes for the same file
  for (const [, p] of panes) {
    if (p.fileId === fileId) { focusPane(p.id); return; }
  }

  const id = crypto.randomUUID();
  const pane = {
    id,
    fileId,
    fileName,
    fileType,
    collapsed: false,
    pinned: false,
    dirty: false,
    editor: null,       // CodeMirror wrapper (docs)
    notebook: null,     // NotesCanvas instance (notebooks)
    el: null,           // root DOM element
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    x: Math.max(0, x - DEFAULT_WIDTH / 2),
    y: Math.max(0, y - TITLEBAR_HEIGHT / 2),
  };

  buildPaneDOM(pane);
  containerEl.appendChild(pane.el);
  panes.set(id, pane);

  await loadPaneContent(pane);
  focusPane(id);
}

export function closePane(id) {
  const pane = panes.get(id);
  if (!pane) return;
  // Save before closing
  savePaneContent(pane);
  // Remove sync listeners
  if (pane._mainSyncHandler) appState.off("doc-content-changed", pane._mainSyncHandler);
  if (pane._mainNbSyncHandler) appState.off("notebook-shapes-changed", pane._mainNbSyncHandler);
  // Stop canvas sync
  if (pane.pinned) stopCanvasSync(pane);
  // Destroy editor/notebook
  if (pane.editor) pane.editor.destroy();
  if (pane.notebook) pane.notebook.destroy();
  pane.el.remove();
  panes.delete(id);
  if (activePaneId === id) activePaneId = null;
}

export function focusPane(id) {
  // Save previously focused pane
  if (activePaneId && activePaneId !== id) {
    const prev = panes.get(activePaneId);
    if (prev) {
      savePaneContent(prev);
      prev.el.classList.remove("active");
    }
  }
  activePaneId = id;
  const pane = panes.get(id);
  if (!pane) return;
  pane.el.classList.add("active");
  pane.el.style.zIndex = ++zCounter;
  // Focus the inner editor
  if (pane.editor) pane.editor.focus();
}

export function deactivateAllPanes() {
  if (activePaneId) {
    const pane = panes.get(activePaneId);
    if (pane) {
      savePaneContent(pane);
      pane.el.classList.remove("active");
    }
  }
  activePaneId = null;
}

export function getActivePaneId() { return activePaneId; }
export function hasPanes() { return panes.size > 0; }

/**
 * If a pane is active its editor should receive keyboard events.
 * Returns true if the active pane consumed the event.
 */
export function isPaneActive() { return activePaneId !== null; }

// ── DOM construction ──────────────────────────────────────────────────

function buildPaneDOM(pane) {
  const el = document.createElement("div");
  el.className = "floating-pane";
  el.style.left = pane.x + "px";
  el.style.top = pane.y + "px";
  el.style.width = pane.width + "px";
  el.style.height = pane.height + "px";

  // Title bar
  const titlebar = document.createElement("div");
  titlebar.className = "floating-pane-titlebar";

  const title = document.createElement("span");
  title.className = "floating-pane-title";
  title.textContent = pane.fileName;
  titlebar.appendChild(title);

  const buttons = document.createElement("span");
  buttons.className = "floating-pane-buttons";

  // Notebook-only pin button
  if (appState.currentNotebookFileId) {
    const pinBtn = makeBtn("pin", ICON_PIN, "Pin to canvas");
    pinBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePin(pane); });
    buttons.appendChild(pinBtn);
  }

  const collapseBtn = makeBtn("collapse", ICON_COLLAPSE, "Collapse");
  collapseBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleCollapse(pane, collapseBtn); });
  buttons.appendChild(collapseBtn);

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

  // Click anywhere on pane → focus it
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
  let startX, startY, startLeft, startTop;

  pane._titlebar.addEventListener("pointerdown", (e) => {
    // Only drag from titlebar itself, not buttons
    if (e.target.closest(".floating-pane-btn")) return;
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = pane.el.offsetLeft;
    startTop = pane.el.offsetTop;
    pane._titlebar.setPointerCapture(e.pointerId);

    const onMove = (me) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      pane.x = startLeft + dx;
      pane.y = startTop + dy;
      pane.el.style.left = pane.x + "px";
      pane.el.style.top = pane.y + "px";
    };

    const onUp = () => {
      pane._titlebar.removeEventListener("pointermove", onMove);
      pane._titlebar.removeEventListener("pointerup", onUp);
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
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;
        let newW = startW, newH = startH, newX = startLeft, newY = startTop;

        if (dir.includes("e")) newW = Math.max(MIN_WIDTH, startW + dx);
        if (dir.includes("w")) { newW = Math.max(MIN_WIDTH, startW - dx); newX = startLeft + (startW - newW); }
        if (dir.includes("s")) newH = Math.max(MIN_HEIGHT, startH + dy);
        if (dir.includes("n")) { newH = Math.max(MIN_HEIGHT, startH - dy); newY = startTop + (startH - newH); }

        pane.width = newW;
        pane.height = newH;
        pane.x = newX;
        pane.y = newY;
        pane.el.style.width = newW + "px";
        pane.el.style.height = newH + "px";
        pane.el.style.left = newX + "px";
        pane.el.style.top = newY + "px";
      };

      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
      };

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
  }
}

// ── Collapse / Expand ─────────────────────────────────────────────────

function toggleCollapse(pane, btn) {
  pane.collapsed = !pane.collapsed;
  if (pane.collapsed) {
    pane._savedHeight = pane.height;
    pane.el.classList.add("collapsed");
    pane.el.style.height = TITLEBAR_HEIGHT + "px";
    btn.innerHTML = ICON_EXPAND;
    btn.title = "Expand";
  } else {
    pane.el.classList.remove("collapsed");
    pane.height = pane._savedHeight || DEFAULT_HEIGHT;
    pane.el.style.height = pane.height + "px";
    btn.innerHTML = ICON_COLLAPSE;
    btn.title = "Collapse";
  }
}

// ── Pin (notebook only) ───────────────────────────────────────────────

async function togglePin(pane) {
  // Ensure notebook bridge is cached before pin operations
  await getNotebookBridge();

  pane.pinned = !pane.pinned;
  const btn = pane.el.querySelector(".fp-btn-pin");
  if (btn) btn.classList.toggle("pin-active", pane.pinned);

  if (pane.pinned) {
    // Convert screen position to canvas coordinates
    const canvasPos = screenToCanvas(pane.x, pane.y);
    if (canvasPos) {
      pane._canvasX = canvasPos.x;
      pane._canvasY = canvasPos.y;
    }
    startCanvasSync(pane);
  } else {
    stopCanvasSync(pane);
  }
}

// Cache the notebook bridge module to avoid async calls in animation loops
let _notebookBridge = null;

async function getNotebookBridge() {
  if (!_notebookBridge) {
    _notebookBridge = await import("../notebook/notebook-bridge.js");
  }
  return _notebookBridge;
}

/**
 * Convert screen coords to notebook canvas world coords.
 * Uses the active NotesCanvas camera (pan + zoom).
 */
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
    if (!pane.pinned || !panes.has(pane.id)) return;
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

function stopCanvasSync(pane) {
  if (pane._syncFrame) {
    cancelAnimationFrame(pane._syncFrame);
    pane._syncFrame = null;
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
}

async function loadNotebookPane(pane) {
  const { NotesCanvas } = await import("../notebook/notes-canvas.ts");
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

  // Mark dirty + propagate shapes to main canvas on changes
  pane._content.addEventListener("notebook-change", () => {
    pane.dirty = true;
    syncNotebookFromPane(pane);
  });

  // Listen for main canvas changes to sync back into this pane
  pane._mainNbSyncHandler = () => syncNotebookToPane(pane);
  appState.on("notebook-shapes-changed", pane._mainNbSyncHandler);
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

function syncPaneThemes() {
  for (const [, pane] of panes) {
    if (pane.editor && pane.editor.reconfigureTheme) {
      pane.editor.reconfigureTheme(appState.settings);
    }
  }
}

// ── Save all panes (called on focus switch to main editor) ────────────

export function saveAllPanes() {
  for (const [, pane] of panes) {
    savePaneContent(pane);
  }
}

// ── Content sync (pane ↔ main editor) ─────────────────────────────────

/**
 * Push document content from a pane to the main editor if the same file
 * is open.  Called on every doc change in the pane.
 */
function syncDocFromPane(pane) {
  if (_syncing) return;
  if (pane.fileType !== "document" || !pane.editor) return;
  if (pane.fileId !== appState.currentFileId) return;
  if (!appState.editor) return;

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

/**
 * Push document content from the main editor to a pane if matching.
 * Called via the "doc-content-changed" event emitted from main.js.
 */
function syncDocToPane(pane) {
  if (_syncing) return;
  if (pane.fileType !== "document" || !pane.editor) return;
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

/**
 * Push shapes from a pane notebook to the main canvas if same file is open.
 */
function syncNotebookFromPane(pane) {
  if (_syncing) return;
  if (pane.fileType !== "notebook" || !pane.notebook) return;
  if (pane.fileId !== appState.currentNotebookFileId) return;
  if (!_notebookBridge) return;
  const mainCanvas = _notebookBridge.getCanvasInstance();
  if (!mainCanvas) return;

  _syncing = true;
  const shapes = pane.notebook.getShapes();
  mainCanvas.loadShapes(JSON.parse(JSON.stringify(shapes)));
  _syncing = false;
}

/**
 * Push shapes from the main canvas to a matching pane notebook.
 * Called via the "notebook-shapes-changed" event.
 */
function syncNotebookToPane(pane) {
  if (_syncing) return;
  if (pane.fileType !== "notebook" || !pane.notebook) return;
  if (pane.fileId !== appState.currentNotebookFileId) return;
  if (!_notebookBridge) return;
  const mainCanvas = _notebookBridge.getCanvasInstance();
  if (!mainCanvas) return;

  _syncing = true;
  const shapes = mainCanvas.getShapes();
  pane.notebook.loadShapes(JSON.parse(JSON.stringify(shapes)));
  pane.dirty = false;
  _syncing = false;
}
