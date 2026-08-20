/**
 * Floating pane manager — draggable reference panes over the editor/canvas.
 * Attach: anchors to canvas (notebooks) or scroll (docs).
 * Pin: persists across document switches (blue header).
 * Attach and pin are mutually exclusive.
 */

import {
  panes,
  activePaneId, setActivePaneId,
  zForPane,
  containerEl, setContainerEl,
  appState, setAppState,
  autosaveTimer, setAutosaveTimer,
  getNotebookBridge,
  DEFAULT_WIDTH, DEFAULT_HEIGHT, TITLEBAR_HEIGHT,
  clampPaneAxis,
} from "./pane-state.js";
import {
  loadPaneContent, savePaneContent, autosaveAllPanes,
  syncAllPaneWordCounts,
} from "./pane-content.js";
import { schedulePersist, restorePanes as _restorePanes } from "./pane-persistence.js";
import { startCanvasSync, startScrollSync, startPdfScrollSync, stopAttachSync, anchorPaneToPdf, startStackPinSync, anchorPaneToStackItem, stopStackPinSync } from "./pane-attach-sync.js";
import { buildPaneDOM as _buildPaneDOM } from "./pane-toolbar.js";
import {
  getInitialPanePosition as _getInitialPanePosition,
  fitActivePaneToGap as _fitActivePaneToGap,
  centerPaneInViewport,
} from "./pane-layout.js";
import { measureEditorColumnWidth } from "./pane-inline.js";
import { syncPaneRatchetLock, previewPaneStyle, syncPaneThemes } from "./pane-theme-sync.js";

// Inject local DOM-builder + context handler (avoids pane-persistence → pane-manager cycle).
const restorePanes = () => _restorePanes({ buildPaneDOM, onContextChange });

/** Rebuild the pane set from a serialized layout (History journal
 *  restore). Callers close the existing panes first; this re-hydrates
 *  the recorded ones and re-persists the result as the live layout. */
export async function restorePanesFromList(list) {
  await _restorePanes({ buildPaneDOM, onContextChange }, Array.isArray(list) ? list : []);
  schedulePersist();
}

/** Emit a pane-activity breadcrumb for the History journal. Fire-and-
 *  forget; the journal subscribes on appState. */
function emitPaneActivity(kind, pane) {
  try {
    appState?.emit("pane-activity", { kind, name: pane?.fileName || "", fileType: pane?.fileType || "" });
  } catch (_) {}
}

// pane-toolbar's buttons need close/focus/context handlers — bind once.
function buildPaneDOM(pane) {
  return _buildPaneDOM(pane, {
    closePane, focusPane, createPane, getCurrentContext, onContextChange,
    notifyPaneDragMove: refreshPaneLayoutMetrics,
  });
}

// ── Public API ────────────────────────────────────────────────────────

export function initPaneManager(state) {
  setAppState(state);
  setContainerEl(document.getElementById("pane-container"));
  setAutosaveTimer(setInterval(autosaveAllPanes, 2000));
  state.on("theme-changed", syncPaneThemes);
  state.on("style-changed", syncPaneThemes);
  state.on("style-preview", previewPaneStyle);
  state.on("style-preview-end", syncPaneThemes);
  state.on("mode-changed", syncPaneRatchetLock);
  // Pick up newly-set / cleared `lockedStyleId` on tree nodes.
  state.on("files-changed", syncPaneThemes);
  state.on("settings-changed", syncAllPaneWordCounts);
  import("./pane-dock.js").then((m) => m.installDockReflowListeners());
  getNotebookBridge().catch(() => {});
  // Zen Focus reparents the editor out of `.floating-pane`, so the
  // overlay is whitelisted — otherwise every Zen click would deactivate.
  window.addEventListener("pointerdown", (e) => {
    if (!activePaneId) return;
    if (e.target instanceof Element && e.target.closest(".floating-pane")) return;
    if (document.body.classList.contains("zen-focus-active")) return;
    saveAllPanes();
    deactivateAllPanes();
  }, true);
  state.on("file-opened", onContextChange);
  state.on("notebook-open", onContextChange);
  state.on("notebook-unmount", onContextChange);
  state.on("pdf-open", onContextChange);
  state.on("pdf-unmount", onContextChange);
  state.on("stack-open", onContextChange);
  state.on("stack-unmount", onContextChange);
  // A Desktop takeover is its own pane context (see getCurrentContext):
  // panes opened from a thumbnail belong to the Desktop, hide when you
  // leave it, and come back when you return.
  state.on("desktop-opened", onContextChange);
  state.on("desktop-closed", onContextChange);

  // Restore any panes that were open when the app last closed
  restorePanes().catch((e) => console.error("Pane restore failed:", e));
}

/** Returns an opaque string identifying the current doc/notebook/project/pdf.
 *  A Desktop wins outright: it *replaces* the open file (openDesktop
 *  calls clearActiveFile), so while one is up its own `dt:` context owns
 *  pane visibility. */
function getCurrentContext() {
  const desktopId = typeof window !== "undefined" ? window.__hushDesktopOpenId : null;
  if (desktopId) return "dt:" + desktopId;
  if (appState.currentStackFileId) return "st:" + appState.currentStackFileId;
  if (appState.currentPdfFileId) return "pdf:" + appState.currentPdfFileId;
  if (appState.currentNotebookFileId) return "nb:" + appState.currentNotebookFileId;
  if (appState.currentProjectId) return "pj:" + appState.currentProjectId;
  if (appState.currentFileId) return "doc:" + appState.currentFileId;
  return "";
}

/** Hide non-pinned panes that don't belong to the new context; show ones that do.
 *  When the active context is marked hidden via `panesHiddenByContext`,
 *  every pane that would normally participate in it (owned or pinned)
 *  is forced off-screen instead — the **Show panes** command lifts the
 *  flag and re-runs this pass. */
function onContextChange() {
  const ctx = getCurrentContext();
  const hiddenMap = appState?.settings?.panesHiddenByContext || {};
  // Phone viewports are too narrow for floating panes — force-hide every
  // context without touching the persisted map (which persists to disk
  // to other devices, where panes are still wanted).
  const phone = document.documentElement.classList.contains("phone");
  const ctxHidden = phone || !!hiddenMap[ctx];
  for (const [, pane] of panes) {
    const participatesInCtx = pane.pinned || pane.ownerContext === ctx;
    if (ctxHidden && participatesInCtx) {
      pane.el.style.display = "none";
      if (pane.pdfViewer && !pane.pdfViewer.suspended) pane.pdfViewer.suspend();
      if (pane.attached) stopAttachSync(pane);
      if (pane.gutter) {
        import("../project/gutter.js").then(({ teardownGutterListeners }) => teardownGutterListeners(pane));
      }
      if (activePaneId === pane.id) {
        pane.el.classList.remove("active");
        if (pane.editor) { pane.editor.blur(); pane.editor.setEditable(false); }
        setActivePaneId(null);
      }
      continue;
    }
    if (pane.pinned) {
      pane.el.style.display = "";
      if (pane.pdfViewer?.suspended) pane.pdfViewer.resume();
      if (appState.currentStackFileId && !pane._stackSyncFrame) {
        if (!pane._stackPin) anchorPaneToStackItem(pane);
        if (pane._stackPin) startStackPinSync(pane);
      } else if (!appState.currentStackFileId) {
        stopStackPinSync(pane);
      }
      continue;
    }
    if (pane.ownerContext === ctx) {
      pane.el.style.display = "";
      if (pane.pdfViewer?.suspended) pane.pdfViewer.resume();
      if (pane.attached && !pane._syncFrame && !pane._scrollHandler && !pane._pdfScrollHandler) {
        if (appState.currentStackFileId && !pane._stackSyncFrame) {
          if (!pane._stackPin) anchorPaneToStackItem(pane);
          if (pane._stackPin) startStackPinSync(pane);
        } else if (appState.currentPdfFileId) startPdfScrollSync(pane);
        else if (appState.currentNotebookFileId) startCanvasSync(pane);
        else startScrollSync(pane);
      }
      if (pane.gutter) {
        import("../project/gutter.js").then(({ restoreGutterLayout }) => restoreGutterLayout(pane));
      }
    } else {
      pane.el.style.display = "none";
      if (pane.pdfViewer && !pane.pdfViewer.suspended) pane.pdfViewer.suspend();
      if (pane.attached) stopAttachSync(pane);
      if (pane.gutter) {
        import("../project/gutter.js").then(({ teardownGutterListeners }) => teardownGutterListeners(pane));
      }
      if (activePaneId === pane.id) {
        pane.el.classList.remove("active");
        if (pane.editor) { pane.editor.blur(); pane.editor.setEditable(false); }
        setActivePaneId(null);
      }
    }
  }
  notifyLayoutChange();
  // Context switches change which panes are visible — re-publish the
  // dock CSS vars so chrome in the new context stops shifting for a
  // pane that's docked but hidden (owner is a different doc), and
  // re-flex remaining docks so a visible cross-axis sibling reclaims
  // the space the hidden ones had carved out.
  import("./pane-dock.js").then((m) => { m.publishDockCssVars(); m.reflowAllDockedPanes(); }).catch(() => {});
}

/** Collect pane-layout signals into a single payload. Floating panes
 *  drive make-space (centroid + count); docked panes feed dedicated
 *  fields so the editor column can subtract their footprint without
 *  treating them as something to push the column away from. */
function _collectPaneMetrics() {
  let hasFloatingPane = false;
  let floatingCount = 0;
  let centroidSum = 0;
  let dockedLeftWidth = 0;
  let dockedRightWidth = 0;
  let dockedTopHeight = 0;
  let dockedBottomHeight = 0;
  for (const [, p] of panes) {
    if (p.el?.style.display === "none") continue;
    if (p.inline) continue; // inline panes have their own CM block widget
    if (p.docked) {
      if (p.dockEdge === "left") dockedLeftWidth = Math.max(dockedLeftWidth, p.width || 0);
      if (p.dockEdge === "right") dockedRightWidth = Math.max(dockedRightWidth, p.width || 0);
      if (p.dockEdge === "top") dockedTopHeight = Math.max(dockedTopHeight, p.height || 0);
      if (p.dockEdge === "bottom") dockedBottomHeight = Math.max(dockedBottomHeight, p.height || 0);
      continue;
    }
    hasFloatingPane = true;
    floatingCount++;
    centroidSum += (p.x || 0) + (p.width || 0) / 2;
  }
  return {
    hasFloatingPane, floatingCount, centroidSum,
    dockedLeftWidth, dockedRightWidth, dockedTopHeight, dockedBottomHeight,
  };
}

/** Lighter-weight refresh fired during a pane drag. Recomputes the
 *  pane centroid + docked footprints and triggers the column resize
 *  handler so the editor column shifts live with the moving pane —
 *  without re-emitting `panes-changed` / `notebook-pane-changed`,
 *  which would churn unrelated subscribers on every pointermove. */
export function refreshPaneLayoutMetrics() {
  const m = _collectPaneMetrics();
  appState.runtime.hasVisibleDocPane = m.hasFloatingPane
    || m.dockedLeftWidth > 0 || m.dockedRightWidth > 0
    || m.dockedTopHeight > 0 || m.dockedBottomHeight > 0;
  appState.runtime.visiblePaneCount = m.floatingCount;
  appState.runtime.visiblePaneCentroid = m.floatingCount > 0 ? m.centroidSum / m.floatingCount : null;
  appState.runtime.dockedLeftWidth = m.dockedLeftWidth;
  appState.runtime.dockedRightWidth = m.dockedRightWidth;
  appState.runtime.dockedTopHeight = m.dockedTopHeight;
  appState.runtime.dockedBottomHeight = m.dockedBottomHeight;
  if (appState.runtime.columnResizeHandler) appState.runtime.columnResizeHandler();
}

function notifyLayoutChange() {
  const m = _collectPaneMetrics();
  appState.runtime.hasVisibleDocPane = m.hasFloatingPane
    || m.dockedLeftWidth > 0 || m.dockedRightWidth > 0
    || m.dockedTopHeight > 0 || m.dockedBottomHeight > 0;
  appState.runtime.visiblePaneCount = m.floatingCount;
  appState.runtime.visiblePaneCentroid = m.floatingCount > 0 ? m.centroidSum / m.floatingCount : null;
  appState.runtime.dockedLeftWidth = m.dockedLeftWidth;
  appState.runtime.dockedRightWidth = m.dockedRightWidth;
  appState.runtime.dockedTopHeight = m.dockedTopHeight;
  appState.runtime.dockedBottomHeight = m.dockedBottomHeight;
  if (appState.runtime.columnResizeHandler) appState.runtime.columnResizeHandler();
  // Surface pane-set changes to the notebook shelf (and any other
  // listener) so its pane rows can refresh on create/close/show/hide.
  if (appState && typeof appState.emit === "function") {
    appState.emit("notebook-pane-changed");
    appState.emit("panes-changed");
  }
}

export function destroyPaneManager() {
  clearInterval(autosaveTimer);
  for (const [id] of panes) closePane(id);
  panes.clear();
  setActivePaneId(null);
}

export async function createPane(fileId, fileName, fileType, x, y, opts = {}) {
  // De-dupe per (fileId, ownerContext) unless the caller explicitly opted in.
  if (!opts.allowDuplicate) {
    const ctx = opts.ownerContext || getCurrentContext();
    for (const [, p] of panes) {
      if (p.fileId === fileId && p.ownerContext === ctx) { focusPane(p.id); return; }
    }
  }

  const id = crypto.randomUUID();
  const inline = opts.inline
    ? { anchorTitle: opts.inline.anchorTitle, occurrence: opts.inline.occurrence | 0, height: opts.inline.height || 500 }
    : null;
  const initW = inline ? (measureEditorColumnWidth() || DEFAULT_WIDTH) : DEFAULT_WIDTH;
  const initH = inline ? inline.height : DEFAULT_HEIGHT;
  const pane = {
    id,
    fileId,
    fileName,
    fileType,
    collapsed: false,
    attached: false,
    pinned: false,
    inline,
    dirty: false,
    editor: null,
    notebook: null,
    el: null,
    width: initW,
    height: initH,
    // Clamp so callers passing a hard-coded anchor (cmd palette uses 62, 60)
    // never land a pane off-screen on narrow windows.
    x: clampPaneAxis(x - DEFAULT_WIDTH / 2, DEFAULT_WIDTH, window.innerWidth),
    y: clampPaneAxis(y - TITLEBAR_HEIGHT / 2, DEFAULT_HEIGHT, window.innerHeight),
    // Nullish-coalesce so callers can pass "" to opt out (zotero panes).
    ownerContext: opts.ownerContext ?? getCurrentContext(),
    localSync: opts.localSync || null,
    zotero: opts.zotero || null,
    // Opened from a Desktop thumbnail: while a Desktop is up every other
    // pane is hidden, and `.desktop-pane` is what exempts this one
    // (desktop.css).
    desktopPane: !!opts.desktopPane,
  };

  buildPaneDOM(pane);
  if (pane.desktopPane) pane.el.classList.add("desktop-pane");
  // Inline panes park off-screen so CM can measure during loadPaneContent;
  // the inline plugin reparents into its widget host next.
  if (pane.inline) Object.assign(pane.el.style, { position: "absolute", left: "-99999px", top: "0px", width: pane.width + "px", height: pane.height + "px" });
  containerEl.appendChild(pane.el);
  pane.el.style.zIndex = zForPane(pane);
  panes.set(id, pane);
  await loadPaneContent(pane);
  emitPaneActivity("opened", pane);
  if (!opts.skipFocus) focusPane(id);
  notifyLayoutChange();
  schedulePersist();
  return pane;
}

/** Public alias of `onContextChange` so the sync layer can re-evaluate
 *  pane visibility after merging remote panes from another device. */
export { onContextChange as refreshPaneContextVisibility };

/** Detach every listener + content instance from a pane without touching
 *  the DOM root. Shared by `closePane` (which then removes pane.el) and
 *  `replacePaneContent` (which rebuilds in place). */
function teardownPaneContent(pane) {
  if (pane._mainSyncHandler) appState.off("doc-content-changed", pane._mainSyncHandler);
  if (pane._mainNbSyncHandler) appState.off("notebook-shapes-changed", pane._mainNbSyncHandler);
  if (pane._bgChangeListener) { document.removeEventListener("notebook-bg-changed", pane._bgChangeListener); pane._bgChangeListener = null; }
  if (pane._cameraChangeListener && pane._content) {
    pane._content.removeEventListener("notebook-camera-change", pane._cameraChangeListener);
    pane._cameraChangeListener = null;
  }
  if (pane._scrollListenerCleanup) { try { pane._scrollListenerCleanup(); } catch (_) {} pane._scrollListenerCleanup = null; }
  if (pane.attached) stopAttachSync(pane);
  if (pane.editor) { try { pane.editor.destroy(); } catch (_) {} pane.editor = null; }
  if (pane.notebook) { try { pane.notebook.destroy(); } catch (_) {} pane.notebook = null; }
  if (pane.pdfViewer) { try { pane.pdfViewer.destroy(); } catch (_) {} pane.pdfViewer = null; }
  if (pane.stackInstance) { try { pane.stackInstance.destroy(); } catch (_) {} pane.stackInstance = null; }
  if (pane._stackSaveInterval) { clearInterval(pane._stackSaveInterval); pane._stackSaveInterval = null; }
}

/** Swap the file currently displayed in `paneId` for a different one,
 *  preserving the pane's position, size, attach, pin, and ownerContext. */
export async function replacePaneContent(paneId, fileId, fileName, fileType) {
  const pane = panes.get(paneId);
  if (!pane) return;
  await savePaneContent(pane);
  teardownPaneContent(pane);
  if (pane._content) pane._content.replaceChildren();

  pane.fileId = fileId;
  pane.fileName = fileName;
  pane.fileType = fileType;
  pane.dirty = false;
  pane.editorScrollTop = 0;
  pane.notebookCamera = null;
  pane.localSync = null;
  pane.zotero = null;

  const titleLink = pane._titlebar?.querySelector(".fp-title-link");
  if (titleLink) titleLink.textContent = fileName;

  await loadPaneContent(pane);
  schedulePersist();
}

export function closePane(id) {
  const pane = panes.get(id);
  if (!pane) return;
  emitPaneActivity("closed", pane);
  // Deliberately not awaited — closing a pane has to feel instant, so
  // the save runs to completion on its own. That means `savePaneContent`
  // must read the editor / canvas synchronously, before its first
  // `await`, because the teardown on the next line takes both away. It
  // does; see the note there before changing either side.
  savePaneContent(pane);
  teardownPaneContent(pane);
  if (pane.gutter) {
    import("../project/gutter.js").then(({ teardownGutterListeners }) => teardownGutterListeners(pane));
  }
  // Inline-pane host gets dropped on the next `panes-changed` build.
  if (pane._inlineHost) pane._inlineHost = null;
  pane.el.remove();
  panes.delete(id);
  if (activePaneId === id) setActivePaneId(null);
  notifyLayoutChange();
  // Reset dock CSS vars + re-flex remaining docks so a sibling on the
  // perpendicular axis reclaims the cross-axis space the closed pane
  // had carved out.
  import("./pane-dock.js").then((m) => { m.publishDockCssVars(); m.reflowAllDockedPanes(); }).catch(() => {});
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
  if (!wasActive) emitPaneActivity("focused", pane);
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

/** Toggle the active pane's pinned (cross-document) state. Used by
 *  the command palette since the toolbar's pin button was retired in
 *  favour of the Gutter toggle. */
export function setActivePanePinned(value) {
  const pane = panes.get(activePaneId);
  if (!pane) return;
  pane.pinned = !!value;
  pane.el.classList.toggle("pinned", pane.pinned);
  pane.el.style.zIndex = zForPane(pane);
  if (!value) onContextChange();
  schedulePersist();
}

/** Build the context id that a pane owned by the given file/project
 *  would use — mirrors `getCurrentContext`'s format. */
export function contextIdForFile(fileId, fileType) {
  if (!fileId) return "";
  if (fileType === "stack") return "st:" + fileId;
  if (fileType === "pdf") return "pdf:" + fileId;
  if (fileType === "notebook") return "nb:" + fileId;
  if (fileType === "project") return "pj:" + fileId;
  return "doc:" + fileId;
}

/** Return the pane summaries (id, fileName, fileType) for every pane
 *  whose `ownerContext` matches the given context id. Used by the
 *  sidebar to paint a row of squares under a file's name. */
export function getPanesForContext(contextId) {
  if (!contextId) return [];
  const out = [];
  for (const [, p] of panes) {
    if (p.ownerContext !== contextId) continue;
    out.push({
      id: p.id,
      fileId: p.fileId,
      fileName: p.fileName || "Untitled",
      fileType: p.fileType,
      pinned: !!p.pinned,
      gutter: !!p.gutter,
    });
  }
  return out;
}

/** Close every pane in the given context. Used by **Clear panes**. */
export function clearPanesForContext(contextId) {
  if (!contextId) return 0;
  const victims = [];
  for (const [id, p] of panes) if (p.ownerContext === contextId) victims.push(id);
  for (const id of victims) closePane(id);
  return victims.length;
}

/** Re-create every pane currently owned by `sourceContextId` under
 *  `targetContextId`, preserving layout (size, position, anchoring,
 *  pinned, collapsed). Existing panes in the target context are left
 *  alone — the copies stack onto whatever is already there. */
export async function copyPanesBetweenContexts(sourceContextId, targetContextId) {
  if (!sourceContextId || !targetContextId || sourceContextId === targetContextId) return 0;
  const originals = [];
  for (const [, p] of panes) if (p.ownerContext === sourceContextId) originals.push(p);
  let n = 0;
  for (const src of originals) {
    const created = await createPane(
      src.fileId,
      src.fileName,
      src.fileType,
      src.x + DEFAULT_WIDTH / 2,
      src.y + TITLEBAR_HEIGHT / 2,
      { ownerContext: targetContextId, allowDuplicate: true, skipFocus: true },
    );
    if (!created) continue;
    created.width = src.width;
    created.height = src.height;
    if (created.el) {
      created.el.style.width = src.width + "px";
      created.el.style.height = src.height + "px";
    }
    if (src.attached) {
      created.attached = true;
      const aBtn = created.el?.querySelector(".fp-btn-attach");
      if (aBtn) aBtn.classList.add("attach-active");
    }
    if (src.pinned) {
      created.pinned = true;
      created.el?.classList.add("pinned");
      const pBtn = created.el?.querySelector(".fp-btn-pin");
      if (pBtn) pBtn.classList.add("pin-active");
    }
    if (src.collapsed) {
      created.collapsed = true;
      created._savedHeight = created.height;
      created.el?.classList.add("collapsed");
      if (created.el) created.el.style.height = TITLEBAR_HEIGHT + "px";
    }
    n++;
  }
  if (n > 0) schedulePersist();
  return n;
}

/**
 * Snapshot of panes currently visible on the notebook canvas — used by
 * the shelf so users can browse and search pane content alongside the
 * canvas's own shapes. Each entry includes the live editor content so a
 * shelf rebuild reflects whatever the user is reading right now.
 */
/** CodeMirror views of every open doc pane showing `fileId`. Lets
 *  app-level rewrites (the YOUAREHERE enforcement) land as real editor
 *  transactions instead of stale-buffer disk writes. */
export function getDocPaneViewsForFile(fileId) {
  const out = [];
  if (!fileId) return out;
  for (const [, p] of panes) {
    if (p.fileType === "document" && p.fileId === fileId && p.editor?.view) {
      out.push(p.editor.view);
    }
  }
  return out;
}

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

// Layout helpers — re-exported so existing call sites
// (command-palette, zotero highlight pane) keep working.
export const getInitialPanePosition = _getInitialPanePosition;
export function fitActivePaneToGap() { return _fitActivePaneToGap(activePaneId); }
/** @deprecated kept for any external caller; new code should use
 *  {@link fitActivePaneToGap}, which is direction-aware. */
export const fitActivePaneToLeftGap = fitActivePaneToGap;

export function saveAllPanes() {
  for (const [, pane] of panes) {
    savePaneContent(pane);
  }
}
