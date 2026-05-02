/**
 * Floating pane manager — draggable reference panes over the editor/canvas.
 * Attach: anchors to canvas (notebooks) or scroll (docs).
 * Pin: persists across document switches (blue header).
 * Attach and pin are mutually exclusive.
 */

import { createPaneEditor } from "./pane-editor.js";
import { attachEditorTextDrag, attachNotebookTextShapeDrag, attachNotebookImageShapeDrag } from "./text-drag.js";
import { isIOS } from "../settings/settings-ui.js";
import {
  IS_TAURI,
  tauriInvoke,
  panes,
  activePaneId, setActivePaneId,
  zForPane,
  containerEl, setContainerEl,
  appState, setAppState,
  autosaveTimer, setAutosaveTimer,
  notebookBridge, getNotebookBridge,
  DEFAULT_WIDTH, DEFAULT_HEIGHT, MIN_WIDTH, MIN_HEIGHT, TITLEBAR_HEIGHT,
  clampPaneAxis,
} from "./pane-state.js";
import {
  loadPaneContent, savePaneContent, autosaveAllPanes,
  syncDocFromPane, syncDocToPane, syncNotebookFromPane, syncNotebookToPane,
  findLockedStyleForFile,
  syncAllPaneWordCounts,
} from "./pane-content.js";
import { applyPaneFontSize, togglePaneSizePopover } from "./pane-size-popover.js";
import { setupPaneDrag, setupPaneResize } from "./pane-drag.js";
import { schedulePersist, persistPanesNow, restorePanes as _restorePanes } from "./pane-persistence.js";
import { screenToCanvas, canvasToScreen, startCanvasSync, startScrollSync, stopAttachSync } from "./pane-attach-sync.js";
import { applyTooltip } from "../tooltips.js";

// Inject local DOM-builder + context handler (avoids pane-persistence → pane-manager cycle).
const restorePanes = () => _restorePanes({ buildPaneDOM, onContextChange });

// ── SVG icons ─────────────────────────────────────────────────────────
const ICON_CLOSE = `<svg viewBox="0 0 10 10"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>`;
const ICON_ATTACH = `<svg viewBox="0 0 10 10"><circle cx="5" cy="3.5" r="2"/><line x1="5" y1="5.5" x2="5" y2="9"/></svg>`;
const ICON_PIN = `<svg viewBox="0 0 10 10"><line x1="5" y1="1" x2="5" y2="7"/><line x1="2.5" y1="4" x2="7.5" y2="4"/><line x1="5" y1="7" x2="5" y2="9.5"/></svg>`;
const ICON_SIZE = `<svg viewBox="0 0 10 10"><polyline points="2,8 5,2 8,8"/><line x1="3.3" y1="6" x2="6.7" y2="6"/></svg>`; // stylised "A"
const ICON_COLLAPSE = `<svg viewBox="0 0 10 10"><polyline points="2.5,4 5,6.5 7.5,4"/></svg>`; // chevron, rotates via CSS

// ── Public API ────────────────────────────────────────────────────────

export function initPaneManager(state) {
  setAppState(state);
  setContainerEl(document.getElementById("pane-container"));
  setAutosaveTimer(setInterval(autosaveAllPanes, 2000));
  state.on("theme-changed", syncPaneThemes);
  state.on("style-changed", syncPaneThemes);
  // Hover preview: the styles sidebar emits style-preview while a row
  // is hovered and style-preview-end on leave. Panes need to track
  // both so the user gets the same "what will this style look like?"
  // affordance the main editor already has.
  state.on("style-preview", previewPaneStyle);
  state.on("style-preview-end", syncPaneThemes);
  // Ratchet locks every pane to read-only — the forward-only contract
  // doesn't survive if the user can drop into a pane and edit there.
  // Scrolling and panning still work because we only flip the editor's
  // editable flag, not the pane container's pointer events.
  state.on("mode-changed", syncPaneRatchetLock);
  // The file-tree node stores `lockedStyleId`; re-sync whenever the tree
  // changes so panes pick up a newly-set (or cleared) lock without the
  // user having to reopen them.
  state.on("files-changed", syncPaneThemes);
  // Refresh pane word-count chips when the global toggle flips.
  state.on("settings-changed", syncAllPaneWordCounts);
  getNotebookBridge().catch(() => {});
  // Deactivate panes when clicking anywhere outside a pane. Zen Focus
  // reparents the editor out of `.floating-pane` so we whitelist the
  // overlay too — otherwise every click during Zen would deactivate.
  window.addEventListener("pointerdown", (e) => {
    if (!activePaneId) return;
    if (e.target instanceof Element && e.target.closest(".floating-pane")) return;
    if (document.body.classList.contains("zen-focus-active")) return;
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
      if (pane.attached && !pane._syncFrame && !pane._scrollHandler) {
        if (appState.currentNotebookFileId) startCanvasSync(pane);
        else startScrollSync(pane);
      }
    } else {
      pane.el.style.display = "none";
      if (pane.attached) stopAttachSync(pane);
      if (activePaneId === pane.id) {
        pane.el.classList.remove("active");
        if (pane.editor) { pane.editor.blur(); pane.editor.setEditable(false); }
        setActivePaneId(null);
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
  appState.runtime.hasVisibleDocPane = hasPane;
  if (appState.runtime.columnResizeHandler) appState.runtime.columnResizeHandler();
  // Surface pane-set changes to the notebook shelf (and any other
  // listener) so its pane rows can refresh on create/close/show/hide.
  if (appState && typeof appState.emit === "function") appState.emit("notebook-pane-changed");
}

export function destroyPaneManager() {
  clearInterval(autosaveTimer);
  for (const [id] of panes) closePane(id);
  panes.clear();
  setActivePaneId(null);
}

export async function createPane(fileId, fileName, fileType, x, y, opts = {}) {
  // Don't open duplicate panes for the same file in the same context
  // (skip check when explicitly duplicating via opts.allowDuplicate).
  // Local Sync panes use `fileId` composed of folder id + rel path so
  // the check still works without per-type special-casing.
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
    // Clamp to the viewport so callers that pass a hard-coded anchor
    // (the command palette's "Open as pane" uses `62, 60`) never land
    // a pane off-screen on narrow windows. The lower bound also keeps
    // the title bar visible when the requested anchor is well above
    // the document area.
    x: clampPaneAxis(x - DEFAULT_WIDTH / 2, DEFAULT_WIDTH, window.innerWidth),
    y: clampPaneAxis(y - TITLEBAR_HEIGHT / 2, DEFAULT_HEIGHT, window.innerHeight),
    // Owner context: doc/notebook/project active at creation. Nullish-coalesce so callers can pass "" to opt out (zotero panes).
    ownerContext: opts.ownerContext ?? getCurrentContext(),
    // Local Sync coordinates — present only for panes backed by a
    // mounted-folder file. `{ folderId, relPath }`. The load/save path
    // branches on this to hit local_sync_read_file / local_sync_write_file
    // instead of the internal file store.
    localSync: opts.localSync || null,
    zotero: opts.zotero || null,
  };

  buildPaneDOM(pane);
  containerEl.appendChild(pane.el);
  pane.el.style.zIndex = zForPane(pane);
  panes.set(id, pane);
  await loadPaneContent(pane);
  if (!opts.skipFocus) focusPane(id);
  notifyLayoutChange();
  schedulePersist();
  return pane;
}

/** Public alias of `onContextChange` so the sync layer can re-evaluate
 *  pane visibility after merging remote panes from another device. */
export { onContextChange as refreshPaneContextVisibility };

export function closePane(id) {
  const pane = panes.get(id);
  if (!pane) return;
  savePaneContent(pane);
  if (pane._mainSyncHandler) appState.off("doc-content-changed", pane._mainSyncHandler);
  if (pane._mainNbSyncHandler) appState.off("notebook-shapes-changed", pane._mainNbSyncHandler);
  if (pane._scrollListenerCleanup) { try { pane._scrollListenerCleanup(); } catch (_) {} pane._scrollListenerCleanup = null; }
  if (pane.attached) stopAttachSync(pane);
  if (pane.editor) pane.editor.destroy();
  if (pane.notebook) pane.notebook.destroy();
  pane.el.remove();
  panes.delete(id);
  if (activePaneId === id) setActivePaneId(null);
  notifyLayoutChange();
  schedulePersist();
}

export function focusPane(id) {
  // Ratchet locks all panes — clicking into one shouldn't unlock the
  // editor and let the user write outside the ratcheted document.
  if (appState?.ratchetMode) return;
  const wasActive = activePaneId === id;
  // Save, blur, and lock previously focused pane
  if (activePaneId && activePaneId !== id) {
    const prev = panes.get(activePaneId);
    if (prev) {
      savePaneContent(prev);
      prev.el.classList.remove("active");
      if (prev.editor) { prev.editor.blur(); prev.editor.setEditable(false); }
    }
  }
  setActivePaneId(id);
  const pane = panes.get(id);
  if (!pane) return;
  pane.el.classList.add("active");
  pane.el.style.zIndex = zForPane(pane);
  // Skip the notebook notify when the pane was already active — every
  // notify("tool") rebuilds the shelf, eating the click on shelf rows
  // because pointerdown fires this on every press.
  if (pane.editor) { pane.editor.setEditable(true); pane.editor.focus(); }
  if (pane.notebook && !wasActive) pane.notebook.state.notify("tool");
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
  setActivePaneId(null);
}
export function getActivePaneId() { return activePaneId; }
export function hasPanes() { return panes.size > 0; }
export function isPaneActive() { return activePaneId !== null; }

/**
 * Snapshot of panes currently visible on the notebook canvas — used by
 * the shelf so users can browse and search pane content alongside the
 * canvas's own shapes. Each entry includes the live editor content so a
 * shelf rebuild reflects whatever the user is reading right now.
 */
export function getNotebookCanvasPanes() {
  if (!appState || !appState.currentNotebookFileId) return [];
  const out = [];
  for (const [, p] of panes) {
    if (p.el && p.el.style.display === "none") continue;
    // Only canvas-attached panes participate in the shelf — they're the
    // ones anchored to a specific spot on this notebook. Globally-pinned
    // panes float across every document and don't belong to the canvas's
    // outline. Free-floating local panes are also excluded for the same
    // "is this content of the notebook?" reason.
    if (!p.attached) continue;
    let content = "";
    if (p.editor && typeof p.editor.getContent === "function") {
      try { content = p.editor.getContent() || ""; } catch (_) {}
    }
    out.push({
      id: p.id,
      fileName: p.fileName,
      fileType: p.fileType,
      content,
      attached: !!p.attached,
      pinned: !!p.pinned,
    });
  }
  return out;
}

/** Bring the named pane to the foreground (and focus it). */
export function focusPaneById(id) { focusPane(id); }

/** Focus the pane and recentre it in the viewport. Used by the shelf so
 *  clicking a pinned-pane row brings it back into view, mirroring the
 *  centring half of `scrollPaneToMatch` without needing a text range. */
export function focusAndCenterPaneById(id) {
  const pane = panes.get(id);
  if (!pane) return false;
  focusPane(id);
  centerPaneInViewport(pane);
  return true;
}

/** Focus a doc pane, recentre it in the viewport (panning the canvas
 *  for attached panes, repositioning the pane element for free-floating
 *  ones), and scroll its editor so the [from, to] range sits at the
 *  centre. Used by the shelf's search results so a click on a matched
 *  snippet jumps the reader to it. */
export function scrollPaneToMatch(id, from, to) {
  const pane = panes.get(id);
  if (!pane) return false;
  if (!pane.editor || typeof pane.editor.scrollToPosition !== "function") return false;
  focusPane(id);
  centerPaneInViewport(pane);
  pane.editor.scrollToPosition(from, to);
  return true;
}

function centerPaneInViewport(pane) {
  const targetX = Math.max(0, Math.round((window.innerWidth - pane.width) / 2));
  const targetY = Math.max(0, Math.round((window.innerHeight - pane.height) / 2));

  if (pane.attached) {
    const canvas = notebookBridge ? notebookBridge.getCanvasInstance() : null;
    if (canvas && pane._canvasX != null && pane._canvasY != null) {
      // Attached panes live in canvas coords; pan the camera so the
      // pane's anchor lands at the desired screen position. The next
      // canvas-sync tick will reconcile pane.x/y, but we set them now
      // so the pane doesn't visibly snap on the following frame.
      const cam = canvas.state.camera;
      canvas.state.camera = {
        ...cam,
        x: targetX - pane._canvasX * cam.zoom,
        y: targetY - pane._canvasY * cam.zoom,
      };
      canvas.state.notify("camera");
      pane.x = targetX;
      pane.y = targetY;
      pane.el.style.left = targetX + "px";
      pane.el.style.top = targetY + "px";
      return;
    }
  }
  // Free-floating pane — just move the element.
  pane.x = targetX;
  pane.y = targetY;
  pane.el.style.left = targetX + "px";
  pane.el.style.top = targetY + "px";
  schedulePersist();
}

/**
 * Auto-fit the active pane to the empty zone on the left of the writing
 * surface. In a doc the pane fills the gap that the "make space for
 * panes" layout opens up beside the text column; in a notebook there's
 * no text column to anchor against, so the pane takes a flat 1/3 of the
 * window width. In both cases the pane sits flush left (clearing the
 * sidebar / open panel) and stretches to the full vertical viewport.
 */
export function fitActivePaneToLeftGap() {
  if (!activePaneId || !appState) return false;
  const pane = panes.get(activePaneId);
  if (!pane) return false;

  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const sideMargin = 12;
  const topMargin = 35;
  const bottomMargin = 12;
  const sidebarZone = 50;

  // If the files panel is open in inset mode, push past it; otherwise the
  // 50px sidebar trigger is hover-only and transparent, so we can sit
  // flush against the left edge and let the sidebar float over us.
  const panelEl = document.getElementById("panel-overlay");
  const panelOpen = panelEl && !panelEl.classList.contains("hidden");
  const panelInset = panelEl && panelEl.classList.contains("panel-inset");
  const panelW = panelOpen && panelInset
    ? parseInt(getComputedStyle(document.documentElement).getPropertyValue("--panel-width"), 10) || 300
    : 0;
  const leftEdge = sidebarZone + panelW;

  let w;
  if (appState.currentNotebookFileId) {
    w = Math.round(viewportW / 3);
  } else {
    // Doc mode: read the live padding from the scroller so the pane fits
    // exactly the gap that the column shift has opened up.
    const scroller = document.querySelector("#editor-container .cm-scroller");
    const leftPadPx = scroller ? parseFloat(getComputedStyle(scroller).paddingLeft) || 0 : 0;
    w = leftPadPx - leftEdge - sideMargin * 2;
  }
  w = Math.max(MIN_WIDTH, w);

  const x = leftEdge + sideMargin;
  const h = Math.max(MIN_HEIGHT, viewportH - topMargin - bottomMargin);
  const y = topMargin;

  if (pane.collapsed) {
    pane.collapsed = false;
    pane.el.classList.remove("collapsed");
  }
  pane.width = w;
  pane.height = h;
  pane.x = x;
  pane.y = y;
  Object.assign(pane.el.style, {
    width: w + "px",
    height: h + "px",
    left: x + "px",
    top: y + "px",
  });
  schedulePersist();
  return true;
}

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
  titleLink.addEventListener("click", (e) => { if (pane.fileType === "zotero-highlights") return; e.stopPropagation(); pane.fileType === "notebook" ? appState.openNotebook(pane.fileId) : appState.openFile(pane.fileId); });
  title.appendChild(titleLink);
  // Word-count chip (doc panes only) — sits next to the title and is
  // populated by pane-content.js's updatePaneWordCount on every doc
  // change. Stays display:none until the user enables word count.
  if (pane.fileType !== "notebook") {
    const wc = document.createElement("span");
    wc.className = "fp-wordcount";
    wc.style.display = "none";
    title.appendChild(wc);
    pane._wordCountEl = wc;
  }
  titlebar.appendChild(title);

  const buttons = document.createElement("span");
  buttons.className = "floating-pane-buttons";

  // Font-size button — opens a small +/- stepper popover. Cmd-clicking
  // a step inside the popover applies the change to every open pane;
  // a plain click only changes this one. The override is per
  // (host doc, pane file) so the same pane opened in another document
  // keeps its own size. Notebook panes have no text size to adjust, so
  // this button is doc-only.
  if (pane.fileType !== "notebook" && pane.fileType !== "zotero-highlights") {
    const sizeBtn = makeBtn("size", ICON_SIZE, "Pane font size");
    sizeBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePaneSizePopover(pane, sizeBtn, schedulePersist); });
    buttons.appendChild(sizeBtn);
  }

  // Attach button: anchor to canvas (notebook) or scroll (doc)
  const attachLabel = appState.currentNotebookFileId ? "Attach to canvas" : "Attach to document";
  const attachBtn = makeBtn("attach", ICON_ATTACH, attachLabel);
  attachBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleAttach(pane); });
  buttons.appendChild(attachBtn);
  const pinBtn = makeBtn("pin", ICON_PIN, "Pin (keep across documents)");
  pinBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePinned(pane); });
  buttons.appendChild(pinBtn);
  // Collapse button — only on iOS, where the desktop's title-bar
  // double-click gesture isn't reachable. Reuses the existing
  // toggleCollapse() so collapsed-state persistence is shared.
  if (isIOS()) {
    const collapseBtn = makeBtn("collapse", ICON_COLLAPSE, "Collapse");
    collapseBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleCollapse(pane); });
    buttons.appendChild(collapseBtn);
  }
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
  setupPaneDrag(pane, { createPane, getCurrentContext, schedulePersist });
  setupPaneResize(pane, { schedulePersist });
  titlebar.addEventListener("dblclick", (e) => { if (!e.target.closest(".floating-pane-btn, .fp-title-link")) toggleCollapse(pane); });
  el.addEventListener("pointerdown", () => focusPane(pane.id));
}

// ── Per-pane font size ────────────────────────────────────────────────


function makeBtn(name, svg, ariaLabel) {
  const btn = document.createElement("button");
  btn.className = `floating-pane-btn fp-btn-${name}`;
  btn.innerHTML = svg;
  applyTooltip(btn, ariaLabel);
  btn.setAttribute("aria-label", ariaLabel);
  return btn;
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
      // Notebook: attach to canvas coordinates. Detached panes store
      // width/height in screen px; once attached, they're interpreted
      // as layout px and rendered through `transform: scale(zoom)`, so
      // we divide by the current zoom on attach to keep the visible
      // size unchanged across the transition.
      await getNotebookBridge();
      const canvas = notebookBridge ? notebookBridge.getCanvasInstance() : null;
      const zoom = canvas ? (canvas.state.camera.zoom || 1) : 1;
      const canvasPos = screenToCanvas(pane.x, pane.y);
      if (canvasPos) { pane._canvasX = canvasPos.x; pane._canvasY = canvasPos.y; }
      pane.width = pane.width / zoom;
      pane.height = pane.height / zoom;
      pane.el.style.width = pane.width + "px";
      pane.el.style.height = pane.height + "px";
      startCanvasSync(pane);
    } else {
      // Doc: attach to scroll position
      const scrollTop = appState.editor?.view.scrollDOM.scrollTop || 0;
      pane._scrollRelY = pane.y + scrollTop;
      startScrollSync(pane);
    }
  } else {
    // Mirror the attach path: panes detaching from canvas convert their
    // layout-px size back to screen px so the visible size carries
    // across the transition.
    const wasCanvasAttached = appState && appState.currentNotebookFileId;
    if (wasCanvasAttached) {
      const canvas = notebookBridge ? notebookBridge.getCanvasInstance() : null;
      const zoom = canvas ? (canvas.state.camera.zoom || 1) : 1;
      pane.width = pane.width * zoom;
      pane.height = pane.height * zoom;
      pane.el.style.width = pane.width + "px";
      pane.el.style.height = pane.height + "px";
    }
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
  // Re-stamp z-index so the pane lifts into (or drops out of) the
  // pinned z-band immediately on toggle.
  pane.el.style.zIndex = zForPane(pane);
  // When unpinning, pane returns to its original context — hide if not current
  if (!value) onContextChange();
  schedulePersist();
}


// ── Content loading ───────────────────────────────────────────────────


/** When ratchet flips on, blur + lock every pane editor so keystrokes
 *  bounce off. When it flips off, leave panes locked — the user has to
 *  click into one to re-activate it (matches the normal focus model).
 *  Notebook panes don't have an `editable` toggle on their own, so we
 *  just deactivate the active pane to clear focus. */
function syncPaneRatchetLock() {
  if (!appState?.ratchetMode) return;
  for (const [, pane] of panes) {
    if (pane.editor && typeof pane.editor.setEditable === "function") {
      pane.editor.blur();
      pane.editor.setEditable(false);
    }
    pane.el?.classList.remove("active");
  }
  setActivePaneId(null);
}

/** Apply a hovered-style preview to every non-locked pane. The styles
 *  sidebar emits the hovered style as `{ ...style, themeId, colorOverrides }`;
 *  we synthesise a settings object with that style as activeStyleId
 *  and route it through the existing reconfigureTheme path so the
 *  pane uses the same theme + colour-override pipeline the real
 *  selection does. Locked panes are skipped — they're pinned to a
 *  specific style and shouldn't flicker on hover. style-preview-end
 *  invokes syncPaneThemes() which restores the real session style. */
async function previewPaneStyle(styleObj) {
  if (!appState || !styleObj || !styleObj.id) return;
  // Splice the previewed style into the styles list (or update it in
  // place if already present) so reconfigureTheme can resolve the id.
  const baseStyles = appState.settings.styles || [];
  const styles = baseStyles.some((s) => s.id === styleObj.id)
    ? baseStyles.map((s) => (s.id === styleObj.id ? { ...s, ...styleObj } : s))
    : [...baseStyles, styleObj];
  const synthSettings = { ...appState.settings, activeStyleId: styleObj.id, styles };
  let bridge = null;
  for (const [, pane] of panes) {
    const lockedStyleId = findLockedStyleForFile(pane.fileId);
    if (lockedStyleId) continue; // locked → ignore session previews
    if (pane.editor?.reconfigureTheme) {
      pane.editor.reconfigureTheme(synthSettings, null);
    }
    if (pane.notebook) {
      if (!bridge) bridge = await getNotebookBridge();
      // computeNotebookSettings reads `state.settings`; pass a state
      // shim so we don't disturb the real appState.
      pane.notebook.applySettings(
        bridge.computeNotebookSettings({ ...appState, settings: synthSettings }, null),
      );
    }
  }
}

// ── Theme sync ────────────────────────────────────────────────────────
async function syncPaneThemes() {
  let bridge = null;
  for (const [, pane] of panes) {
    const lockedStyleId = findLockedStyleForFile(pane.fileId);
    if (pane.editor?.reconfigureTheme) {
      pane.editor.reconfigureTheme(appState.settings, lockedStyleId);
    }
    if (pane.notebook) {
      if (!bridge) bridge = await getNotebookBridge();
      pane.notebook.applySettings(bridge.computeNotebookSettings(appState, lockedStyleId));
    }
  }
}


// ── Persistence (settings.persistedPanes) ─────────────────────────────

// ── Save all panes (called on focus switch to main editor) ────────────
export function saveAllPanes() {
  for (const [, pane] of panes) {
    savePaneContent(pane);
  }
}
