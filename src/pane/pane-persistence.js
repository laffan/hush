/**
 * Pane persistence — serialise the open pane set into AppSettings on a
 * short debounce, restore them at app start.
 *
 * Restore takes a `buildPaneDOM` factory + `onContextChange` callback as
 * deps so this module doesn't have to import pane-manager.js (which
 * would be circular).
 */
import {
  appState,
  panes,
  containerEl,
  zForPane,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  TITLEBAR_HEIGHT,
} from "./pane-state.js";
import { loadPaneContent } from "./pane-content.js";
import { applyPaneFontSize } from "./pane-size-popover.js";

let _persistTimer = null;

// Panes that are saved but not built. A pane is only turned into DOM,
// an editor and a loaded file when its context is the one on screen
// (its owning doc / notebook / PDF / stack / Desktop is open, or it is
// pinned) and that context's panes aren't hidden. Every other entry of
// `settings.persistedPanes` waits here in its serialized form until
// `wakeDormantPanes` is asked for its context.
//
// Restore used to build the whole list — every pane of every document
// on every desk — visible, one after another, and only hide the
// strangers once the last had loaded. That was a pile of other desks'
// panes on screen for the length of the restore, and a launch cost that
// grew with the number of panes anywhere in the library.
//
// `_waking` holds the records between leaving `_dormant` and joining the
// live `panes` map, so a persist that lands mid-restore still writes
// them back.
let _dormant = [];
let _waking = [];

/** Would the serialized pane `s` be on screen in context `ctx`? Mirrors
 *  the participation rule in pane-manager's `onContextChange`. */
function participates(s, ctx) {
  return !!s.pinned || (s.ownerContext || "") === ctx;
}
// Suppression depth — incremented by `applyRemotePanes` while it's
// merging incoming pane state, decremented when done. Prevents the
// apply path from re-uploading the same payload it just consumed.
let _persistSuppressDepth = 0;

export function suppressPersist(on) {
  if (on) _persistSuppressDepth++;
  else _persistSuppressDepth = Math.max(0, _persistSuppressDepth - 1);
}

export function schedulePersist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    persistPanesNow();
  }, 300);
}

/** Serialize the live pane set to the persistable shape. Shared by the
 *  settings persist below and the History journal's workspace capture. */
export function serializePanes() {
  const serialized = [];
  for (const [, p] of panes) {
    serialized.push({
      fileId: p.fileId,
      fileName: p.fileName,
      fileType: p.fileType,
      collapsed: !!p.collapsed,
      attached: !!p.attached,
      pinned: !!p.pinned,
      // Opened from a Desktop thumbnail — needs the `.desktop-pane`
      // visibility opt-in again on restore.
      desktopPane: !!p.desktopPane,
      gutter: !!p.gutter,
      gutterSide: p.gutterSide || null,
      gutterPrev: p._gutterPrev || null,
      docked: !!p.docked,
      dockEdge: p.dockEdge || null,
      dockUserSize: typeof p.dockUserSize === "number" ? p.dockUserSize : null,
      dockPrev: p._dockPrev || null,
      width: p.width,
      height: p.height,
      x: p.x,
      y: p.y,
      ownerContext: p.ownerContext || "",
      canvasX: p._canvasX ?? null,
      canvasY: p._canvasY ?? null,
      scrollRelY: p._scrollRelY ?? null,
      // Geometry the ⌘-double-click vertical stretch replaced, so the
      // second ⌘-double-click still puts the pane back after a restart.
      // Without it a pane restored mid-stretch has nothing to return to
      // and the gesture reads as dead until the pane is moved by hand.
      stretchRestore: p._stretchRestore
        ? { y: p._stretchRestore.y, height: p._stretchRestore.height }
        : null,
      // Editor scroll position inside doc panes — restored on next mount
      // so reopening a pane lands the reader where they left off.
      editorScrollTop: typeof p.editorScrollTop === "number" ? p.editorScrollTop : null,
      // PDF viewport — `pdfZoomLevel` is the encoded zoom mode (see
      // pdf-viewer.getZoom: -1/-2 for fits, -3/-4 for fit2/fit3, positive
      // for fixed zoom). `pdfScrollLeft` covers horizontal-scroll PDFs
      // where the editorScrollTop above stays 0.
      pdfZoomLevel: typeof p.pdfZoomLevel === "number" ? p.pdfZoomLevel : null,
      pdfScrollLeft: typeof p.pdfScrollLeft === "number" ? p.pdfScrollLeft : null,
      // Per-pane notebook camera (pan + zoom). Stored separately from the
      // notebook file's own camera so the same notebook open in the main
      // canvas and as a pane each keep their own viewport.
      notebookCamera: p.notebookCamera
        ? { x: p.notebookCamera.x, y: p.notebookCamera.y, zoom: p.notebookCamera.zoom }
        : null,
      localSync: p.localSync || null,
      // Per-pane font-size override. Keyed implicitly by the pane's
      // (ownerContext, fileId) pair, so the same file opened as a pane
      // in another doc is unaffected.
      fontSize: typeof p.fontSize === "number" ? p.fontSize : null,
      // Zotero highlight pane: persist the chosen attachment so the pane
      // restores straight into the annotations view. When unset, the
      // restored pane re-enters its search step.
      zotero: p.zotero
        ? {
            itemKey: p.zotero.itemKey || null,
            attKey: p.zotero.attKey || null,
            title: p.zotero.title || "",
            authors: p.zotero.authors || "",
            year: p.zotero.year || "",
          }
        : null,
      // Inline (in-doc) pane anchor — { anchorTitle, occurrence } points
      // at the Nth `[[Title]]` wikilink in the owning doc. Height rides
      // alongside so reopening lands at the user's resized size, not
      // the default 500 px.
      inline: p.inline
        ? {
            anchorTitle: p.inline.anchorTitle,
            occurrence: p.inline.occurrence | 0,
            height: p.height,
            wide: !!p.inline.wide,
          }
        : null,
    });
  }
  // Live panes first: the History journal zips this array against the
  // live Map by index. The panes not built yet ride along unchanged so
  // a persist never drops them.
  for (const s of _waking) serialized.push(s);
  for (const s of _dormant) serialized.push(s);
  return serialized;
}

/** Serialized panes that aren't built yet, owned by `contextId`. */
export function dormantPanesForContext(contextId) {
  return [..._waking, ..._dormant].filter((s) => (s.ownerContext || "") === contextId);
}

/** Is any unbuilt pane waiting to appear in `ctx`? */
export function hasDormantPanesFor(ctx) {
  return _dormant.some((s) => participates(s, ctx));
}

/** Forget the unbuilt panes owned by `contextId` (Clear panes). Returns
 *  how many were dropped. */
export function dropDormantPanes(contextId) {
  const before = _dormant.length;
  _dormant = _dormant.filter((s) => (s.ownerContext || "") !== contextId);
  const n = before - _dormant.length;
  if (n) schedulePersist();
  return n;
}

/** Build the unbuilt panes that belong on screen in `ctx`. Returns how
 *  many were taken off the dormant list (the caller re-runs the
 *  visibility pass when it's non-zero). `force` builds them even when
 *  `ctx` isn't on screen or is hidden — for callers that need the live
 *  panes themselves (Copy panes). */
export async function wakeDormantPanes(deps, ctx, { force = false } = {}) {
  const due = _dormant.filter((s) => participates(s, ctx));
  if (!due.length) return 0;
  _dormant = _dormant.filter((s) => !due.includes(s));
  await materialize(deps, due, force);
  return due.length;
}

export function persistPanesNow() {
  if (!appState) return;
  if (_persistSuppressDepth > 0) return;
  const serialized = serializePanes();
  appState.updateSettings({ persistedPanes: serialized });
}

/** Restore a pane layout: build the panes that belong on screen now and
 *  park the rest as dormant records (see `_dormant`). `deps` carries
 *  pane-manager's DOM builder and context helpers — injected rather
 *  than imported to keep this module out of a cycle with it. */
export async function restorePanes(deps, listOverride) {
  const { onContextChange, getCurrentContext, isContextHidden } = deps;
  if (!appState) return;
  // `listOverride` lets the History journal rebuild a recorded pane set
  // mid-session; without it this is the boot path reading settings.
  const list = listOverride || appState.settings?.persistedPanes;
  // Whatever was waiting belonged to the layout being replaced; a
  // journal entry carries its own dormant panes in `list`.
  _dormant = [];
  if (!Array.isArray(list) || list.length === 0) { onContextChange(); return; }

  const ctx = getCurrentContext();
  const hidden = isContextHidden(ctx);
  const now = [];
  for (const s of list) {
    if (!s || !s.fileId || !s.fileType) continue;
    if (!hidden && participates(s, ctx)) now.push(s);
    else _dormant.push(s);
  }
  await materialize(deps, now, false);

  // Hide panes that don't belong in the current context and start sync
  // for those that do.
  onContextChange();
}

/** Turn serialized records into live panes, in order. */
async function materialize(deps, records, force) {
  const { buildPaneDOM, getCurrentContext, isContextHidden } = deps;
  _waking.push(...records);
  // Imported once, up front, so each record moves from `_waking` into
  // the live map with no await in between — a persist can't miss it.
  const { findNodeByFileId } = await import("../state/tree-helpers.js");
  for (const s of records) {
    const w = _waking.indexOf(s);
    if (w >= 0) _waking.splice(w, 1);
    // The user may have switched documents while the panes ahead of
    // this one loaded; one that no longer belongs on screen goes back
    // to waiting rather than being built hidden.
    const ctxNow = getCurrentContext();
    if (!force && (!participates(s, ctxNow) || isContextHidden(ctxNow))) { _dormant.push(s); continue; }

    // Local Sync panes are validated against the persisted mount list —
    // if the user removed the mount while the app was closed, drop the
    // pane. Otherwise the fileName saved at persist time is fine.
    let resolvedName = s.fileName || "Untitled";
    if (s.fileType === "zotero-highlights") {
      // No backing tree node — the persisted name is authoritative.
      // Falls back to a placeholder; the pane refines its title once
      // the attachment-mode UI mounts.
      resolvedName = s.zotero?.title || s.fileName || "Zotero highlights";
    } else if (s.localSync) {
      const folders = appState.settings?.localSyncFolders || [];
      const stillMounted = folders.some((f) => f.id === s.localSync.folderId);
      if (!stillMounted) continue;
    } else if (s.fileType === "pdf") {
      const node = findNodeByFileId(appState.fileTree, s.fileId);
      if (!node) continue;
      resolvedName = node.name || s.fileName || "PDF";
    } else if (s.fileType === "stack") {
      const node = findNodeByFileId(appState.fileTree, s.fileId);
      if (!node) continue;
      resolvedName = node.name || s.fileName || "Stack";
    } else {
      const file = (appState.files || []).find((f) => f.id === s.fileId);
      if (!file) continue;
      const node = findNodeByFileId(appState.fileTree, s.fileId);
      resolvedName = node?.name || s.fileName || file.name || "Untitled";
    }

    const id = crypto.randomUUID();
    const pane = {
      id,
      fileId: s.fileId,
      fileName: resolvedName,
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
      localSync: s.localSync || null,
      fontSize: typeof s.fontSize === "number" ? s.fontSize : null,
      zotero: s.zotero ? { ...s.zotero } : null,
      editorScrollTop: typeof s.editorScrollTop === "number" ? s.editorScrollTop : null,
      pdfZoomLevel: typeof s.pdfZoomLevel === "number" ? s.pdfZoomLevel : null,
      pdfScrollLeft: typeof s.pdfScrollLeft === "number" ? s.pdfScrollLeft : null,
      // Restored per-pane notebook camera — consumed in loadNotebookPane
      // (in lieu of the default centring) so the user's pan / zoom
      // survives an app restart.
      notebookCamera: s.notebookCamera
        ? { x: s.notebookCamera.x, y: s.notebookCamera.y, zoom: s.notebookCamera.zoom }
        : null,
      desktopPane: !!s.desktopPane,
      gutter: !!s.gutter,
      gutterSide: s.gutterSide || null,
      docked: !!s.docked,
      dockEdge: s.dockEdge || null,
      dockUserSize: typeof s.dockUserSize === "number" ? s.dockUserSize : null,
      inline: s.inline
        ? {
            anchorTitle: s.inline.anchorTitle,
            occurrence: s.inline.occurrence | 0,
            height: s.inline.height || 500,
            wide: !!s.inline.wide,
          }
        : null,
    };
    if (s.gutterPrev) pane._gutterPrev = s.gutterPrev;
    if (s.dockPrev) pane._dockPrev = s.dockPrev;
    if (s.canvasX != null) pane._canvasX = s.canvasX;
    if (s.canvasY != null) pane._canvasY = s.canvasY;
    if (s.scrollRelY != null) pane._scrollRelY = s.scrollRelY;
    if (s.stretchRestore
        && typeof s.stretchRestore.y === "number"
        && typeof s.stretchRestore.height === "number") {
      pane._stretchRestore = { y: s.stretchRestore.y, height: s.stretchRestore.height };
    }

    buildPaneDOM(pane);
    if (pane.desktopPane) pane.el.classList.add("desktop-pane");
    applyPaneFontSize(pane);
    if (pane.inline) {
      // Park off-screen inside #pane-container so CodeMirror has a real
      // DOM context to measure against during `loadPaneContent`. The
      // inline CM plugin reparents into its widget host the next time
      // the owning doc is the active editor.
      pane.el.style.position = "absolute";
      pane.el.style.left = "-99999px";
      pane.el.style.top = "0px";
      pane.el.style.width = pane.width + "px";
      pane.el.style.height = pane.height + "px";
      // The inline plugin's first build counts as a re-mount from the
      // user's perspective (the pane was "detached" between sessions),
      // so flag it and let the same scroll-reapply path used after a
      // mid-session doc switch put scrollTop / scrollLeft / stack
      // scroll back where they were.
      pane._inlineDetached = true;
    }
    containerEl.appendChild(pane.el);
    pane.el.style.zIndex = zForPane(pane);
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
    // Re-apply gutter geometry after the DOM is in place.
    if (pane.gutter) {
      const { restoreGutterLayout } = await import("../project/gutter.js");
      restoreGutterLayout(pane);
    }
    // Re-apply docked layout (snap edge + user-controlled dimension).
    // Gutter panes are docked too, but restoreGutterLayout above already
    // re-docks them (and re-establishes the scroll-sync), so skip them here
    // to avoid a double-dock.
    if (pane.docked && pane.dockEdge && !pane.gutter) {
      const { dockPane } = await import("./pane-dock.js");
      dockPane(pane, pane.dockEdge);
    }
  }
}
