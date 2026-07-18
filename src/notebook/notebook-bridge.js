/**
 * Notebook bridge — manages the NotesCanvas lifecycle within Hush.
 * Handles mounting/unmounting, loading/saving shapes, and autosave.
 */

let canvasInstance = null;
let currentNotebookFileId = null;
let notebookDirty = false;
// Camera (pan + zoom) changes mark this flag, separate from `notebookDirty`,
// so the autosave still writes the file (preserving the new camera) but we
// can skip snapshot creation for camera-only updates — pan / zoom isn't
// content history, and version-pruning would otherwise burn a slot per pan.
let cameraDirty = false;
let _appState = null;
let _mainDragCleanup = null;
/** Cached per-notebook background overrides for the open notebook. Re-applied
 *  after every `applyNotebookSettings` so a global settings refresh (theme
 *  switch, style change) doesn't wipe the user's per-notebook bg choice. */
let _notebookBackground = null;
/** Last content we successfully wrote to disk for the open notebook.
 *  Compared byte-for-byte against incoming sync-reload payloads so an
 *  echoed pull (a sync layer reporting our own write back to us) is
 *  a no-op rather than a destructive `loadShapes` that re-IDs every
 *  stroke and clobbers the engine's selection / undo state. */
let _lastSavedContent = null;
/** Last envelope BODY fragment (shapes / layers / flowEdges / bookmarks
 *  via `encodeNotebookBody`) this mount encoded. Valid as long as no
 *  content change has been flagged since — camera-only saves reuse it,
 *  so persisting a pan position costs an envelope reassembly instead of
 *  re-serializing every shape (a multi-MB main-thread JSON.stringify on
 *  stroke-heavy notebooks — the felt stall at pan pauses). Invalidated
 *  on mount / unmount / sync reload; content-dirty saves re-encode. */
let _lastEncodedBody = null;

/** Save gating (quiet-moment deferral, snapshot throttle, adaptive
 *  backpressure) lives in NotebookSaveGate — see its module docs.
 *  `_saveInFlight` stays here: saves are async on the Rust side, so
 *  two could overlap and land out of order — the in-flight promise
 *  serializes them. */
const _saveGate = new NotebookSaveGate();
let _saveInFlight = null;

/** Shape count the current mount loaded from disk: 0 = genuinely
 *  new/empty file, N > 0 = loaded content, -1 = load failed or content
 *  didn't decode. The empty-save guard below uses it to refuse to
 *  overwrite a file that had content from a canvas that is empty
 *  without any user edits (a failed load, or a canvas swapped mid-save
 *  by a lifecycle race). */
let _loadedShapeCount = -1;
let _emptySaveGuardTripped = false;

/** Create a version snapshot for `fileId` if the throttle window has
 *  elapsed (or `force` is set). Never throws. Used by the Local Folder
 *  save branch and the unmount pending-flush; the main save path folds
 *  the snapshot into save_file_raw instead. Takes the file id
 *  explicitly (never the mutable module global) so a save spanning a
 *  lifecycle change can't snapshot one notebook's content under
 *  another notebook's id. */
async function _maybeSnapshot(fileId, content, force) {
  if (!IS_TAURI || !fileId) return;
  if (!_saveGate.snapshotDue(force)) {
    _saveGate.snapshotPending = true;
    return;
  }
  try {
    await tauriInvoke("create_snapshot", { documentId: fileId, content });
    _saveGate.markSnapshotTaken();
  } catch (e) {
    console.error("Notebook snapshot failed:", e);
  }
}

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args, options) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args, options);
}

// Loading-overlay + save-gate helpers live in their own modules
// (700-line cap).
import {
  LARGE_NOTEBOOK_SHAPE_COUNT,
  mountLoadingOverlay as _mountLoadingOverlay,
  unmountLoadingOverlay as _unmountLoadingOverlay,
  nextPaint as _nextPaint,
} from "./notebook-loading-overlay.js";
import { NotebookSaveGate } from "./notebook-save-gate.js";
import { loadNotebookSnapshot } from "./notebook-load.js";
import { computeNotebookSettings } from "./notebook-style-settings.js";
export { computeNotebookSettings } from "./notebook-style-settings.js";

/** Lifecycle serialization. `openNotebook` (and every other file-open
 *  path) fires `notebook-unmount` and the next mount as EVENTS whose
 *  async handlers race on the event loop. Unmount legitimately awaits
 *  in-flight saves now, so an unserialized mount could reset the
 *  module state (fresh empty canvas, new file id) while the previous
 *  unmount was still mid-save — which force-saved an EMPTY canvas
 *  over the newly opened file (with a forced version snapshot), and
 *  could destroy the freshly mounted canvas. Every mount/unmount now
 *  queues behind the previous lifecycle operation, whatever the
 *  caller. */
let _lifecycle = Promise.resolve();
function _serializedLifecycle(fn) {
  const run = _lifecycle.then(fn, fn);
  // Keep the chain alive even when an operation rejects.
  _lifecycle = run.then(() => {}, () => {});
  return run;
}

/**
 * Mount or re-mount the NotesCanvas into the notebook container.
 * If already mounted, destroys the previous instance first.
 * Serialized against unmountNotebook — see _serializedLifecycle.
 */
export function mountNotebook(container, fileId, state) {
  return _serializedLifecycle(() => _mountNotebookImpl(container, fileId, state));
}

async function _mountNotebookImpl(container, fileId, state) {
  // Destroy previous canvas if exists
  if (canvasInstance) {
    canvasInstance.destroy();
    canvasInstance = null;
  }
  if (_mainDragCleanup) { _mainDragCleanup(); _mainDragCleanup = null; }
  _unmountLoadingOverlay();

  currentNotebookFileId = fileId;
  notebookDirty = false;
  cameraDirty = false;
  _lastSavedContent = null;
  _lastEncodedBody = null;
  _notebookBackground = null;
  // Pessimistic until a load succeeds: -1 means "unknown / failed", and
  // the empty-save guard in saveNotebook refuses to overwrite the file
  // from a pristine empty canvas while it's not 0.
  _loadedShapeCount = -1;
  _emptySaveGuardTripped = false;
  _saveGate.reset();

  // Dynamically import the NotesCanvas class (TypeScript, handled by Vite)
  const { NotesCanvas } = await import("./notes-canvas.ts");
  // Pass notebook shortcuts from Hush settings
  const s = state.settings;
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
  canvasInstance = new NotesCanvas(container, shortcuts);

  // Phones default the canvas toolbar to vertical — the horizontal bar
  // doesn't fit the narrow viewport. State is session-only so flipping
  // back to horizontal stays put for the rest of the session.
  try {
    const { isPhone } = await import("../settings/settings-ui.js");
    if (isPhone()) canvasInstance.state.setDrawingToolbarVertical(true);
  } catch (_) {}

  // Load notebook contents (shapes + layers + flowchart edges) from the
  // backing file — see notebook-load.js for the source branches and the
  // loadedShapeCount semantics feeding the empty-save guard.
  const { snapshot, loadedShapeCount } = await loadNotebookSnapshot(fileId);
  _loadedShapeCount = loadedShapeCount;

  if (snapshot) {
    // For a large notebook, `loadShapes` (engine stroke sync) runs long
    // enough to be felt. Show the loading overlay and force a paint before
    // it so the user sees "Loading Notebook…" instead of an empty canvas
    // while the main thread is busy. Small notebooks skip this — they
    // finish in a frame and the overlay would only flash.
    const shapeCount = Array.isArray(snapshot.shapes) ? snapshot.shapes.length : 0;
    if (shapeCount > LARGE_NOTEBOOK_SHAPE_COUNT) {
      _mountLoadingOverlay(container);
      await _nextPaint();
    }
    canvasInstance.loadShapes(snapshot.shapes, snapshot.layers);
    canvasInstance.state.flowchart.deserialize(snapshot.flowEdges);
    if (Array.isArray(snapshot.bookmarks)) {
      canvasInstance.state.bookmarks = snapshot.bookmarks;
      canvasInstance.state.notify("bookmarks");
    }
    // Restore the saved pan / zoom so reopening a notebook lands the
    // user back where they were. Only applied on the initial mount —
    // sync pulls (`reloadNotebookShapes`) deliberately leave the camera
    // alone so a remote device's view doesn't yank this device around.
    if (snapshot.camera) {
      canvasInstance.state.camera = { ...snapshot.camera };
      canvasInstance.state.notify("camera");
      // Saved world positions are already consistent with the saved
      // camera — rebase pinned-box compensation instead of letting the
      // restore read as a giant pan.
      canvasInstance.state.rebasePinAnchor();
    }
  }

  // Apply notebook settings from Hush settings — globals first so a
  // fresh notebook with no saved background picks up the user's default,
  // then overlay any per-notebook background overrides on top.
  if (snapshot?.background) _notebookBackground = { ...snapshot.background };
  applyNotebookSettings(state);

  // Shapes are loaded and the first render is queued — drop the overlay.
  _unmountLoadingOverlay();

  _appState = state;

  // Listen for shape changes to mark dirty + notify panes
  container.addEventListener("notebook-change", () => {
    notebookDirty = true;
    // Feeds the quiet-moment save gate — saves wait for a real pause
    // in writing, not just the gap between two letters.
    _saveGate.noteContentChange();
    if (_appState) _appState.emit("notebook-shapes-changed");
  });

  // Per-notebook background overrides — popup fires on document. Cache
  // the latest values and mark dirty so the next autosave persists them.
  const onBgChange = (e) => {
    const d = e.detail || {};
    // Only main-notebook popup events should snapshot here. Pane-owned
    // popups dispatch the same event but carry their own state ref, so
    // we filter to the main canvas instance.
    if (d.state && d.state !== canvasInstance.state) return;
    _notebookBackground = { pattern: d.pattern, spacing: d.spacing, opacity: d.opacity, rotationEnabled: d.rotationEnabled };
    notebookDirty = true;
  };
  document.addEventListener("notebook-bg-changed", onBgChange);
  // Stash on the instance so unmount can detach.
  canvasInstance._bgChangeListener = onBgChange;
  // Camera (pan / zoom) changes go through a separate dirty flag so the
  // file is rewritten with the new viewport but no version snapshot
  // is created — pan / zoom isn't content history.
  container.addEventListener("notebook-camera-change", () => {
    cameraDirty = true;
    // Feeds the quiet-moment save gate — saves wait out active panning.
    _saveGate.noteCameraChange();
  });

  // Wire cmd-drag of text and image shapes out of the main notebook.
  try {
    const { attachNotebookTextShapeDrag, attachNotebookImageShapeDrag } = await import("../pane/text-drag.js");
    const { findShapeAtPoint, hitTestLink } = await import("./state-helpers.ts");
    const canvasEl = container.querySelector("canvas");
    if (canvasEl) {
      const txtCleanup = attachNotebookTextShapeDrag(
        canvasEl,
        container,
        canvasInstance.state,
        {
          findTextShapeAt: (shapes, pt) => {
            const hit = findShapeAtPoint(pt, shapes, canvasInstance.state.fontFamily);
            return hit && hit.type === "text" ? hit : null;
          },
          hitTestLink,
        },
        () => { notebookDirty = true; },
      );
      const imgCleanup = attachNotebookImageShapeDrag(
        canvasEl,
        container,
        canvasInstance.state,
        {
          findImageShapeAt: (shapes, pt) => {
            const hit = findShapeAtPoint(pt, shapes, canvasInstance.state.fontFamily);
            return hit && hit.type === "image" ? hit : null;
          },
        },
        () => { notebookDirty = true; },
      );
      _mainDragCleanup = () => { txtCleanup && txtCleanup(); imgCleanup && imgCleanup(); };
    }
  } catch (e) {
    console.error("Failed to wire main notebook drag:", e);
  }

  // Initial-load notifications run via queueMicrotask, which means the
  // `notify("camera")` fired by the saved-camera restore above lands on
  // the container listener attached during mount. Flush the microtasks
  // and reset the flags so the just-restored state isn't immediately
  // re-saved on the next autosave tick.
  await Promise.resolve();
  notebookDirty = false;
  cameraDirty = false;

  return canvasInstance;
}

// Hush style -> settings derivation lives in notebook-style-settings.js
// (700-line cap); re-exported below so existing importers keep working.

/**
 * Apply Hush settings to the active NotesCanvas.
 * Appearance, theme, and font are derived from the current Hush editor style
 * so that switching styles in the editor carries over to notebooks.
 * Grid settings use their own dedicated notebook fields.
 */
export function applyNotebookSettings(state) {
  if (!canvasInstance) return;
  canvasInstance.applySettings(computeNotebookSettings(state));
  // Per-notebook background overrides win over global defaults so a
  // theme / style swap doesn't quietly reset the canvas pattern.
  if (_notebookBackground) applyNotebookBackground(_notebookBackground);
}

/**
 * Preview a different style on the active NotesCanvas without writing it
 * back to the active style id. Mirrors the doc-side hover-preview path
 * driven from the Styles sidebar / style edit modal: callers re-apply
 * `applyNotebookSettings(state)` on hover-end / modal-cancel to revert.
 *
 * `styleId` accepts a saved style id, `"__default__"` for the no-style
 * baseline, or any id absent from `state.settings.styles` (treated as
 * "no style" by `computeNotebookSettings`).
 */
export function previewNotebookStyle(state, styleId) {
  if (!canvasInstance) return;
  canvasInstance.applySettings(computeNotebookSettings(state, styleId || "__default__"));
}

/** Apply the per-notebook background override on top of the global settings.
 *  Only the fields present in `bg` are written so a partial override still
 *  inherits the rest from globals. */
function applyNotebookBackground(bg) {
  if (!canvasInstance || !bg) return;
  const s = canvasInstance.state;
  if (bg.pattern) s.backgroundPattern = bg.pattern;
  if (typeof bg.spacing === "number") s.gridSpacing = bg.spacing;
  if (typeof bg.opacity === "number") s.gridOpacity = bg.opacity;
  // Setter no-ops when unchanged; when flipping to off it also snaps
  // any live camera rotation back to 0.
  if (typeof bg.rotationEnabled === "boolean") s.setCanvasRotationEnabled(bg.rotationEnabled);
  s.notify("theme");
}

/**
 * Save the current notebook shapes to the backing file.
 * Called by the autosave interval and on notebook switch.
 * Returns { fileId, content } when a save occurs, or null if nothing to save.
 * `opts.forceSnapshot` bypasses the version-snapshot throttle AND the
 * save backpressure — used by unmount so the session's final state
 * always lands on disk and in history.
 */
export async function saveNotebook(opts = {}) {
  // Serialize with any in-flight save so two async writes of the same
  // file can't land out of order (the older content would win).
  if (_saveInFlight) {
    try { await _saveInFlight; } catch (_) {}
  }
  if (!canvasInstance || !currentNotebookFileId) return null;
  if (!notebookDirty && !cameraDirty) return null;
  // Data-loss guard — checked BEFORE the force bypass so unmount can't
  // skip it either: a canvas that is empty with no user edits in its
  // undo history (pristine) while the file on disk had content (or the
  // load failed outright) must never write. This is the state a failed
  // load — or a mount racing an unmount — leaves behind; saving it
  // overwrites a real notebook with an empty envelope. A user who
  // intentionally deletes everything has undo history (or a redo stack
  // after undoing back to the start), so legitimate empty saves pass.
  const pristine = !canvasInstance.state.canUndo && !canvasInstance.state.canRedo;
  if (pristine && _loadedShapeCount !== 0 && canvasInstance.getShapes().length === 0) {
    if (!_emptySaveGuardTripped) {
      _emptySaveGuardTripped = true;
      console.error(
        `Refusing to save notebook ${currentNotebookFileId}: canvas is empty with no user edits ` +
        `but the file ${_loadedShapeCount === -1 ? "failed to load" : `had ${_loadedShapeCount} shapes`} — blocking to prevent data loss.`,
      );
    }
    return null;
  }
  if (!opts.forceSnapshot) {
    // Quiet-moment gate: never save mid-stroke or mid-pan.
    if (_saveGate.shouldDefer(!!canvasInstance.isStrokeInFlight?.())) return null;
    // Camera-only saves are capped hard — see NotebookSaveGate.
    if (!notebookDirty && _saveGate.cameraOnlyTooSoon()) return null;
    if (_saveGate.backpressureTooSoon()) return null;
  }
  const saveStart = performance.now();
  const p = _saveNotebookInner(opts);
  _saveInFlight = p;
  try {
    return await p;
  } finally {
    if (_saveInFlight === p) _saveInFlight = null;
    _saveGate.noteSaveEnded(performance.now() - saveStart);
  }
}

async function _saveNotebookInner(opts) {
  // Capture the mount this save belongs to. mount/unmount are
  // serialized against each other, but a save promise still spans
  // awaits — if a lifecycle change swaps the module state underneath
  // us, writing would target the WRONG file with the wrong canvas's
  // content. Everything below uses these captures, and each write is
  // preceded by a swap check.
  const canvas = canvasInstance;
  const fileId = currentNotebookFileId;
  const mountSwapped = () => canvas !== canvasInstance || fileId !== currentNotebookFileId;
  const wasContentDirty = notebookDirty;
  notebookDirty = false;
  cameraDirty = false;
  const { encodeNotebookBody, assembleNotebookContent } = await import("./notebook-content.ts");
  if (mountSwapped()) return null;
  // Camera-only saves reuse the cached body — re-serializing every
  // shape just to persist a pan position was a felt main-thread stall
  // at pan pauses on stroke-heavy notebooks. Content-dirty saves (or a
  // cold cache) encode fresh; nothing below this point awaits between
  // the mountSwapped check and the cache write, so the capture is safe.
  let body = !wasContentDirty && _lastEncodedBody != null ? _lastEncodedBody : null;
  if (body == null) {
    body = encodeNotebookBody({
      shapes: canvas.getShapes(),
      layers: canvas.state.layers,
      flowEdges: canvas.state.flowchart.serialize(),
      bookmarks: canvas.state.bookmarks,
    });
    _lastEncodedBody = body;
  }
  const content = assembleNotebookContent(body, canvas.state.camera, {
    pattern: canvas.state.backgroundPattern,
    spacing: canvas.state.gridSpacing,
    opacity: canvas.state.gridOpacity,
    rotationEnabled: canvas.state.canvasRotationEnabled,
  });
  try {
    const { parseLocalSentinel } = await import("../sync/local-sync.js");
    if (mountSwapped()) return null;
    const local = parseLocalSentinel(fileId);
    if (local) {
      // Local Sync notebook — pack the JSON envelope into a `.hushnote`
      // zip and overwrite the file on disk. No sync push.
      const { packNotebook } = await import("../sync/notebook-sync.js");
      const { writeFileBytes } = await import("../sync/local-sync.js");
      const bytes = await packNotebook(content);
      if (mountSwapped()) return null;
      // Flag our own write so the desktop fs watcher skips the echo event
      // (and its sidebar repaint) for the next ~500 ms.
      if (_appState?.runtime) _appState.runtime.localSyncWriteFlag = Date.now();
      await writeFileBytes(local.folderId, local.relPath, Array.from(bytes), true);
      if (!mountSwapped()) _lastSavedContent = content;
      // Version snapshots key on the `ls:` sentinel id, so Local Folder
      // notebooks get the same content history internal ones do.
      // Throttled — see _maybeSnapshot; camera-only saves never earn
      // a version slot.
      if (IS_TAURI && wasContentDirty) {
        await _maybeSnapshot(fileId, content, !!opts.forceSnapshot);
      }
      return null;
    }
    if (IS_TAURI) {
      // Raw-body invoke: JSON-args would JSON.stringify (escape) the
      // whole multi-MB content on this thread — that marshal was a
      // per-save frame stall that dropped stroke points. Bytes ride the
      // IPC protocol untouched; the eligible version snapshot folds
      // into the same invoke so the payload never crosses twice.
      const wantSnapshot = wasContentDirty && _saveGate.snapshotDue(!!opts.forceSnapshot);
      await tauriInvoke("save_file_raw", new TextEncoder().encode(content), {
        headers: {
          "file-id": fileId,
          ...(wantSnapshot ? { "with-snapshot": "1" } : {}),
        },
      });
      if (mountSwapped()) return null;
      _lastSavedContent = content;
      if (wasContentDirty) {
        if (wantSnapshot) _saveGate.markSnapshotTaken();
        else _saveGate.snapshotPending = true;
      }
      return { fileId, content };
    }
  } catch (e) {
    console.error("Failed to save notebook:", e);
    // The dirty flags were cleared optimistically at entry — restore
    // them so the next tick retries instead of stranding unsaved
    // content until the next edit. Skip when the mount was swapped
    // underneath us: the flags belong to the NEW notebook now.
    if (!mountSwapped()) {
      if (wasContentDirty) notebookDirty = true;
      cameraDirty = true;
    }
  }
  return null;
}

/**
 * Destroy the current NotesCanvas and save if dirty.
 * Returns { fileId, content } if a save occurred, or null otherwise.
 * Serialized against mountNotebook — see _serializedLifecycle.
 */
export function unmountNotebook() {
  return _serializedLifecycle(() => _unmountNotebookImpl());
}

async function _unmountNotebookImpl() {
  // Let any in-flight autosave land before deciding what still needs
  // flushing (saveNotebook also self-serializes, but the pending-
  // snapshot branch below reads _lastSavedContent directly).
  if (_saveInFlight) {
    try { await _saveInFlight; } catch (_) {}
  }
  let saveResult = null;
  if (notebookDirty || cameraDirty) {
    // Force a version snapshot past the throttle so the state the user
    // walks away from is always in history.
    saveResult = await saveNotebook({ forceSnapshot: true });
  } else if (_saveGate.snapshotPending && _lastSavedContent && IS_TAURI && currentNotebookFileId) {
    // Everything is already on disk but the last save(s) fell inside
    // the snapshot throttle window — flush the pending version slot
    // from the cached content without re-encoding.
    await _maybeSnapshot(currentNotebookFileId, _lastSavedContent, true);
  }
  if (canvasInstance) {
    if (canvasInstance._bgChangeListener) {
      document.removeEventListener("notebook-bg-changed", canvasInstance._bgChangeListener);
    }
    canvasInstance.destroy();
    canvasInstance = null;
  }
  if (_mainDragCleanup) { _mainDragCleanup(); _mainDragCleanup = null; }
  currentNotebookFileId = null;
  notebookDirty = false;
  cameraDirty = false;
  _lastEncodedBody = null;
  _notebookBackground = null;
  return saveResult;
}

/**
 * Update the left inset for the notebook (sidebar/panel width).
 */
export function setNotebookLeftInset(px) {
  if (canvasInstance) canvasInstance.setLeftInset(px);
}

/**
 * Check if the notebook has unsaved changes.
 */
export function isNotebookDirty() {
  return notebookDirty;
}

/**
 * Get the current NotesCanvas instance (or null if not mounted).
 */
export function getCanvasInstance() {
  return canvasInstance;
}

/**
 * Get the file ID of the currently open notebook.
 */
export function getCurrentNotebookFileId() {
  return currentNotebookFileId;
}

/**
 * Reload shapes into the open notebook from synced content.
 * Used when an external change is pulled for the currently open notebook.
 */
export async function reloadNotebookShapes(jsonContent) {
  if (!canvasInstance) return;
  // Echo guard: if the incoming pull is byte-identical to what we last
  // wrote to disk, it's our own upload coming back through the cursor.
  // Skipping avoids a pointless mirror (engine stroke reconcile + a
  // no-op checkpoint) for content we already have.
  if (jsonContent === _lastSavedContent) return;
  try {
    const { decodeNotebookContent } = await import("./notebook-content.ts");
    const snapshot = decodeNotebookContent(jsonContent);
    if (snapshot) {
      // Mirror (not load): this is new content for the SAME open
      // notebook, so the local undo history survives and the incoming
      // change lands as a checkpoint — ⌘Z can step back over a remote
      // edit instead of finding a freshly wiped history.
      canvasInstance.mirrorContent({
        shapes: snapshot.shapes,
        layers: snapshot.layers,
        flowEdges: snapshot.flowEdges,
        bookmarks: Array.isArray(snapshot.bookmarks) ? snapshot.bookmarks : undefined,
      });
      // Deliberately skip applying snapshot.camera here — viewports differ
      // across devices, and an incoming sync nudging the local pan / zoom
      // would feel like the canvas was being yanked around.
      if (snapshot.background) {
        _notebookBackground = { ...snapshot.background };
        applyNotebookBackground(_notebookBackground);
      }
      _lastSavedContent = jsonContent;
      // The canvas now holds externally-produced content the cached
      // body fragment doesn't match — drop it so the next camera-only
      // save re-encodes instead of persisting the pre-sync shapes.
      _lastEncodedBody = null;
      notebookDirty = false;
      cameraDirty = false;
    }
  } catch (e) {
    console.error("Failed to reload notebook shapes from sync:", e);
  }
}
