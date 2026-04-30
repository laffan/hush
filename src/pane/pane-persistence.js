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

export function persistPanesNow() {
  if (!appState) return;
  if (_persistSuppressDepth > 0) return;
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
      localSync: p.localSync || null,
      // Per-pane font-size override. Keyed implicitly by the pane's
      // (ownerContext, fileId) pair, so the same file opened as a pane
      // in another doc is unaffected.
      fontSize: typeof p.fontSize === "number" ? p.fontSize : null,
    });
  }
  appState.updateSettings({ persistedPanes: serialized });

  // Cross-device pane sync — fire-and-forget; the op log handles retry.
  // Only the platform-stable subset of fields (anchoring + identity, no
  // pixel layout) gets uploaded; see pane-sync.js.
  if (appState.settings?.dropboxEnabled && appState.settings?.dropboxSyncPath) {
    pushPanesToDropbox().catch((e) => console.warn("pane sync upload failed:", e));
  }
}

async function pushPanesToDropbox() {
  const { serializePanesForSync, enqueuePaneUpload } = await import("../sync/pane-sync.js");
  const payload = await serializePanesForSync(panes);
  await enqueuePaneUpload(payload);
}

export async function restorePanes(deps) {
  const { buildPaneDOM, onContextChange } = deps;
  if (!appState) return;
  const list = appState.settings?.persistedPanes;
  if (!Array.isArray(list) || list.length === 0) return;

  for (const s of list) {
    if (!s || !s.fileId || !s.fileType) continue;

    // Local Sync panes are validated against the persisted mount list —
    // if the user removed the mount while the app was closed, drop the
    // pane. Otherwise the fileName saved at persist time is fine.
    let resolvedName = s.fileName || "Untitled";
    if (s.localSync) {
      const folders = appState.settings?.localSyncFolders || [];
      const stillMounted = folders.some((f) => f.id === s.localSync.folderId);
      if (!stillMounted) continue;
    } else {
      // Resolve current file name (may have been renamed since persist)
      const file = (appState.files || []).find((f) => f.id === s.fileId);
      if (!file) continue; // File was deleted — drop pane
      resolvedName = file.name || s.fileName || "Untitled";
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
    };
    if (s.canvasX != null) pane._canvasX = s.canvasX;
    if (s.canvasY != null) pane._canvasY = s.canvasY;
    if (s.scrollRelY != null) pane._scrollRelY = s.scrollRelY;

    buildPaneDOM(pane);
    applyPaneFontSize(pane);
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
  }

  // Hide panes that don't belong in the current context and start sync
  // for those that do.
  onContextChange();
}
