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
  findLockedStyleForFile,
  syncAllPaneWordCounts,
} from "./pane-content.js";
import { schedulePersist, restorePanes as _restorePanes } from "./pane-persistence.js";
import { startCanvasSync, startScrollSync, stopAttachSync } from "./pane-attach-sync.js";
import { buildPaneDOM as _buildPaneDOM } from "./pane-toolbar.js";
import {
  getInitialPanePosition as _getInitialPanePosition,
  fitActivePaneToGap as _fitActivePaneToGap,
  centerPaneInViewport,
} from "./pane-layout.js";

// Inject local DOM-builder + context handler (avoids pane-persistence → pane-manager cycle).
const restorePanes = () => _restorePanes({ buildPaneDOM, onContextChange });

// pane-toolbar's buttons need close/focus/context handlers — bind once.
function buildPaneDOM(pane) {
  return _buildPaneDOM(pane, {
    closePane, focusPane, createPane, getCurrentContext, onContextChange,
  });
}

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

/** Hide non-pinned panes that don't belong to the new context; show ones that do.
 *  When the active context is marked hidden via `panesHiddenByContext`,
 *  every pane that would normally participate in it (owned or pinned)
 *  is forced off-screen instead — the **Show panes** command lifts the
 *  flag and re-runs this pass. */
function onContextChange() {
  const ctx = getCurrentContext();
  const hiddenMap = appState?.settings?.panesHiddenByContext || {};
  // Phone viewports are too narrow for floating panes — force-hide every
  // context without touching the persisted map (which rides Dropbox sync
  // to other devices, where panes are still wanted).
  const phone = document.documentElement.classList.contains("phone");
  const ctxHidden = phone || !!hiddenMap[ctx];
  for (const [, pane] of panes) {
    const participatesInCtx = pane.pinned || pane.ownerContext === ctx;
    if (ctxHidden && participatesInCtx) {
      pane.el.style.display = "none";
      if (pane.attached) stopAttachSync(pane);
      if (activePaneId === pane.id) {
        pane.el.classList.remove("active");
        if (pane.editor) { pane.editor.blur(); pane.editor.setEditable(false); }
        setActivePaneId(null);
      }
      continue;
    }
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

/** Swap the file currently displayed in `paneId` for a different one,
 *  preserving the pane's position, size, attach, pin, and ownerContext.
 *  Called from the command palette's "Replace pane content" entry. */
export async function replacePaneContent(paneId, fileId, fileName, fileType) {
  const pane = panes.get(paneId);
  if (!pane) return;
  // Persist whatever is in the pane right now before tearing it down.
  await savePaneContent(pane);
  // Detach listeners + the canvas/scroll attach loop. Rebuilt by loadPaneContent.
  if (pane._mainSyncHandler) appState.off("doc-content-changed", pane._mainSyncHandler);
  if (pane._mainNbSyncHandler) appState.off("notebook-shapes-changed", pane._mainNbSyncHandler);
  if (pane._scrollListenerCleanup) { try { pane._scrollListenerCleanup(); } catch (_) {} pane._scrollListenerCleanup = null; }
  if (pane.attached) stopAttachSync(pane);
  if (pane.editor) { try { pane.editor.destroy(); } catch (_) {} pane.editor = null; }
  if (pane.notebook) { try { pane.notebook.destroy(); } catch (_) {} pane.notebook = null; }
  // Reset content area so the new editor/notebook mounts into a clean DOM.
  if (pane._content) pane._content.replaceChildren();

  pane.fileId = fileId;
  pane.fileName = fileName;
  pane.fileType = fileType;
  pane.dirty = false;
  pane.editorScrollTop = 0;
  pane.localSync = null;
  pane.zotero = null;

  // Update the title bar text without rebuilding the toolbar.
  const titleLink = pane._titlebar?.querySelector(".fp-title-link");
  if (titleLink) titleLink.textContent = fileName;

  await loadPaneContent(pane);
  schedulePersist();
}

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

/** Build the context id that a pane owned by the given file/project
 *  would use — mirrors `getCurrentContext`'s format. */
export function contextIdForFile(fileId, fileType) {
  if (!fileId) return "";
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

// ── Ratchet lock + theme/style sync ──────────────────────────────────

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

async function syncPaneThemes() {
  const { findNodeByFileId } = await import("../state/tree-helpers.js");
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
    // Track tree-side renames in the pane title — covers both manual
    // sidebar renames and the auto-rename-from-first-line that fires for
    // freshly-created "Untitled" docs.
    if (pane.fileType === "document" || pane.fileType === "notebook") {
      const node = findNodeByFileId(appState.fileTree, pane.fileId);
      if (node && node.name && node.name !== pane.fileName) {
        pane.fileName = node.name;
        const titleLink = pane._titlebar?.querySelector(".fp-title-link");
        if (titleLink) titleLink.textContent = node.name;
      }
    }
  }
}

// ── Save all panes (called on focus switch to main editor) ────────────
export function saveAllPanes() {
  for (const [, pane] of panes) {
    savePaneContent(pane);
  }
}
