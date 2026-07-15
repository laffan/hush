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
/** TEMPORARY: stroke-perf harness panel handle (see ui/perf-panel.ts). */
let _perfPanel = null;
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

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Element ref for the active "Loading Notebook…" overlay, if any. */
let _loadingOverlayEl = null;

/** Shape count above which a notebook is treated as "large" enough to
 *  warrant the loading overlay. Below this, `loadShapes` finishes in a
 *  frame or two and showing the overlay would just flash. */
const LARGE_NOTEBOOK_SHAPE_COUNT = 60;

/** Mount the "Loading Notebook…" overlay into the notebook container.
 *  Idempotent. Painted at full opacity so it's visible on the very next
 *  frame — the caller yields a frame (`_nextPaint`) before kicking off the
 *  synchronous `loadShapes` work, which would otherwise block the event
 *  loop (and any paint) until it finished. */
function _mountLoadingOverlay(container) {
  if (_loadingOverlayEl) return;
  const overlay = document.createElement("div");
  overlay.className = "notebook-loading-overlay";
  const label = document.createElement("div");
  label.className = "notebook-loading-label";
  label.textContent = "Loading Notebook…";
  const bar = document.createElement("div");
  bar.className = "notebook-loading-bar";
  overlay.appendChild(label);
  overlay.appendChild(bar);
  container.appendChild(overlay);
  _loadingOverlayEl = overlay;
}

function _unmountLoadingOverlay() {
  if (_loadingOverlayEl && _loadingOverlayEl.parentNode) {
    _loadingOverlayEl.parentNode.removeChild(_loadingOverlayEl);
  }
  _loadingOverlayEl = null;
}

/** Resolve after the browser has had a chance to paint (two rAFs: the
 *  first runs before the next paint, the second after it). Used to
 *  guarantee the loading overlay actually renders before the blocking
 *  `loadShapes` pass starts. */
function _nextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * Mount or re-mount the NotesCanvas into the notebook container.
 * If already mounted, destroys the previous instance first.
 */
export async function mountNotebook(container, fileId, state) {
  // Destroy previous canvas if exists
  if (canvasInstance) {
    canvasInstance.destroy();
    canvasInstance = null;
  }
  if (_mainDragCleanup) { _mainDragCleanup(); _mainDragCleanup = null; }
  if (_perfPanel) { _perfPanel.destroy(); _perfPanel = null; }
  _unmountLoadingOverlay();

  currentNotebookFileId = fileId;
  notebookDirty = false;
  cameraDirty = false;
  _lastSavedContent = null;
  _notebookBackground = null;

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
  // backing file. The envelope format is parsed by `decodeNotebookContent`,
  // which tolerates the legacy bare-Shape[] form for older notebooks.
  let snapshot = null;
  try {
    const { parseLocalSentinel } = await import("../sync/local-sync.js");
    const local = parseLocalSentinel(fileId);
    if (local) {
      // Local Sync notebook — read the `.hushnote` zip straight off disk,
      // unpack it to the JSON envelope, then decode like any notebook.
      const { readFileBytes } = await import("../sync/local-sync.js");
      const bytes = await readFileBytes(local.folderId, local.relPath);
      if (bytes) {
        const { unpackNotebook } = await import("../sync/notebook-sync.js");
        const json = await unpackNotebook(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
        const { decodeNotebookContent } = await import("./notebook-content.ts");
        snapshot = decodeNotebookContent(json);
      } else {
        const { decodeNotebookContent } = await import("./notebook-content.ts");
        snapshot = decodeNotebookContent(null);
      }
    } else if (IS_TAURI) {
      const file = await tauriInvoke("load_file", { id: fileId });
      const { decodeNotebookContent } = await import("./notebook-content.ts");
      snapshot = decodeNotebookContent(file.content);
    }
  } catch (e) {
    console.error("Failed to load notebook shapes:", e);
  }

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
    _notebookBackground = { pattern: d.pattern, spacing: d.spacing, opacity: d.opacity };
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

  // TEMPORARY: stroke-perf harness — collapsed "PERF" pill in the
  // top-left; main canvas only (panes don't mount it). Remove with
  // ui/perf-panel.ts + perf-harness.ts when the perf work lands.
  try {
    const { createPerfPanel } = await import("./ui/perf-panel.ts");
    _perfPanel = createPerfPanel(canvasInstance.state);
    container.appendChild(_perfPanel.el);
  } catch (e) {
    console.error("Failed to mount perf panel:", e);
  }

  return canvasInstance;
}

// Map Hush camelCase theme IDs to notebook kebab-case IDs.
// Keys that are identical (amy, barf, bespin, cobalt, dracula, clouds) are
// still listed for clarity.
const HUSH_TO_NOTEBOOK_THEME = {
  ayuLight: "ayu-light",
  clouds: "clouds",
  noctisLilac: "noctis-lilac",
  rosePineDawn: "rose-pine-dawn",
  solarizedLight: "solarized-light",
  smoothy: "default",          // no Smoothy in notebook — fall back
  amy: "amy",
  barf: "barf",
  bespin: "bespin",
  birdsOfParadise: "birds-of-paradise",
  boysAndGirls: "boys-and-girls",
  cobalt: "cobalt",
  coolGlow: "cool-glow",
  dracula: "dracula",
  espresso: "espresso",
  tomorrow: "tomorrow",
};

/**
 * Resolve the notebook theme ID from the current Hush style settings.
 * Uses the active Hush theme (respecting appearance + styles) and maps
 * it to the corresponding notebook canvas theme.
 */
function resolveNotebookTheme(state) {
  const s = state.settings;

  // Determine effective appearance
  let appearance = s.appearance || "dark";
  if (appearance === "auto") {
    appearance = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  // Check if an active style overrides the theme
  let hushThemeId = appearance === "dark" ? s.darkTheme : s.lightTheme;
  if (s.activeStyleId && s.styles) {
    const style = s.styles.find(st => st.id === s.activeStyleId);
    if (style) {
      if (style.lightThemeId || style.darkThemeId) {
        const resolved = appearance === "dark" ? style.darkThemeId : style.lightThemeId;
        if (resolved) hushThemeId = resolved;
      } else if (style.themeId) {
        hushThemeId = style.themeId;
      }
    }
  }

  return HUSH_TO_NOTEBOOK_THEME[hushThemeId] || "default";
}

/**
 * Compute the NotesCanvas settings bundle derived from the current Hush
 * editor style. Exported so notebook panes can adopt the same style.
 * When `lockedStyleId` is provided, the pane's notebook uses that style
 * instead of whichever style is currently session-active.
 */
export function computeNotebookSettings(state, lockedStyleId) {
  let s = state.settings;
  if (lockedStyleId) {
    if (lockedStyleId === "__default__") {
      s = { ...s, activeStyleId: null };
    } else if ((s.styles || []).some(st => st.id === lockedStyleId)) {
      s = { ...s, activeStyleId: lockedStyleId };
    }
  }

  // Derive appearance from Hush settings
  let appearance = s.appearance || "dark";
  if (appearance === "auto") {
    appearance = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  // Font: use active style font if set, otherwise editor default
  let fontFamily = s.fontFamily || "Inter";
  if (s.activeStyleId && s.styles) {
    const style = s.styles.find(st => st.id === s.activeStyleId);
    if (style?.fontFamily) fontFamily = style.fontFamily;
  }

  const overrideState = s === state.settings ? state : { ...state, settings: s };

  // Style background override — when the active style has a `bg` set,
  // pipe it through so the canvas paints the user-chosen background
  // instead of the resolved notebook theme's stock canvasBackground.
  // Empty string = no override. The Default style's `bg` lives on
  // AppSettings.defaultLight/DarkColors instead of a style entry, so
  // handle that branch explicitly.
  let canvasBackgroundOverride = "";
  let bgColors = null;
  let styleBackgroundImage = null;
  if (s.activeStyleId && s.styles) {
    const style = s.styles.find((st) => st.id === s.activeStyleId);
    if (style) {
      bgColors = appearance === "dark" ? style.darkColors : style.lightColors;
      styleBackgroundImage = style.backgroundImage || null;
    }
  } else {
    bgColors = appearance === "dark" ? s.defaultDarkColors : s.defaultLightColors;
  }
  // Resolve the background image's per-appearance opacity + invert so the
  // canvas matches the editor. Light/dark each carry their own opacity and
  // invert flag; the legacy single `opacity` is the fallback for both.
  let resolvedBackgroundImage = null;
  if (styleBackgroundImage && styleBackgroundImage.enabled && styleBackgroundImage.src) {
    const isDark = appearance === "dark";
    const legacy = styleBackgroundImage.opacity != null ? styleBackgroundImage.opacity : 1;
    const opacity = isDark
      ? (styleBackgroundImage.darkOpacity != null ? styleBackgroundImage.darkOpacity : legacy)
      : (styleBackgroundImage.lightOpacity != null ? styleBackgroundImage.lightOpacity : legacy);
    const invert = isDark ? !!styleBackgroundImage.darkInvert : !!styleBackgroundImage.lightInvert;
    resolvedBackgroundImage = { ...styleBackgroundImage, opacity, invert };
  }
  if (bgColors?.bg) canvasBackgroundOverride = bgColors.bg;
  // Foreground override — same source as the bg override. Lets default /
  // auto-coloured text shapes and the toolbar icons follow the style's
  // text colour instead of the notebook theme's stock foreground.
  const foregroundOverride = bgColors?.fg || "";
  // Header override — markdown headings inside text shapes track it.
  const headingColorOverride = bgColors?.header || "";
  // Link override — text-shape links track it; defaults to the text colour.
  const linkColorOverride = bgColors?.links || "";

  return {
    appearanceMode: appearance,
    themeId: resolveNotebookTheme(overrideState),
    backgroundPattern: s.notebookBackgroundPattern || "dot-grid",
    gridSpacing: s.notebookGridSpacing || 25,
    gridOpacity: s.notebookGridOpacity != null ? s.notebookGridOpacity : 0.20,
    fontFamily,
    fontSize: s.notebookFontSize || 16,
    canvasBackgroundOverride,
    backgroundImage: resolvedBackgroundImage,
    foregroundOverride,
    headingColorOverride,
    linkColorOverride,
    maxTextWidth: s.notebookTextMaxWidth || 350,
    flowConnectMode: s.flowConnectMode === "horizontal" ? "horizontal" : "closest",
  };
}

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
  s.notify("theme");
}

/**
 * Save the current notebook shapes to the backing file.
 * Called by the autosave interval and on notebook switch.
 * Returns { fileId, content } when a save occurs, or null if nothing to save.
 */
export async function saveNotebook() {
  if (!canvasInstance || !currentNotebookFileId) return null;
  if (!notebookDirty && !cameraDirty) return null;
  const wasContentDirty = notebookDirty;
  notebookDirty = false;
  cameraDirty = false;
  const { encodeNotebookContent } = await import("./notebook-content.ts");
  // TEMPORARY perf instrumentation — consumed by ui/perf-panel.ts.
  const _perfEnc0 = performance.now();
  const content = encodeNotebookContent({
    shapes: canvasInstance.getShapes(),
    layers: canvasInstance.state.layers,
    flowEdges: canvasInstance.state.flowchart.serialize(),
    bookmarks: canvasInstance.state.bookmarks,
    camera: canvasInstance.state.camera,
    background: {
      pattern: canvasInstance.state.backgroundPattern,
      spacing: canvasInstance.state.gridSpacing,
      opacity: canvasInstance.state.gridOpacity,
    },
  });
  const _perf = { encodeMs: performance.now() - _perfEnc0, bytes: content.length, saveMs: 0, snapshotMs: 0 };
  const _emitSavePerf = () => {
    try {
      document.dispatchEvent(new CustomEvent("hush-notebook-save-perf", { detail: _perf }));
    } catch (_) {}
  };
  try {
    const { parseLocalSentinel } = await import("../sync/local-sync.js");
    const local = parseLocalSentinel(currentNotebookFileId);
    if (local) {
      // Local Sync notebook — pack the JSON envelope into a `.hushnote`
      // zip and overwrite the file on disk. No sync push.
      const { packNotebook } = await import("../sync/notebook-sync.js");
      const { writeFileBytes } = await import("../sync/local-sync.js");
      const bytes = await packNotebook(content);
      // Flag our own write so the desktop fs watcher skips the echo event
      // (and its sidebar repaint) for the next ~500 ms.
      if (_appState?.runtime) _appState.runtime.localSyncWriteFlag = Date.now();
      const _perfSave0 = performance.now();
      await writeFileBytes(local.folderId, local.relPath, Array.from(bytes), true);
      _perf.saveMs = performance.now() - _perfSave0;
      _lastSavedContent = content;
      // Version snapshots key on the `ls:` sentinel id, so Local Folder
      // notebooks get the same content history internal ones do.
      if (IS_TAURI && wasContentDirty) {
        const _perfSnap0 = performance.now();
        try { await tauriInvoke("create_snapshot", { documentId: currentNotebookFileId, content }); }
        catch (e) { console.error("Notebook snapshot failed:", e); }
        _perf.snapshotMs = performance.now() - _perfSnap0;
      }
      _emitSavePerf();
      return null;
    }
    if (IS_TAURI) {
      const _perfSave0 = performance.now();
      await tauriInvoke("save_file", { id: currentNotebookFileId, content });
      _perf.saveMs = performance.now() - _perfSave0;
      _lastSavedContent = content;
      // Mirror the doc-side cadence: snapshot every successful autosave
      // write — but only when the write covers a real content change.
      // Camera-only saves don't earn a version slot.
      if (wasContentDirty) {
        const _perfSnap0 = performance.now();
        try { await tauriInvoke("create_snapshot", { documentId: currentNotebookFileId, content }); }
        catch (e) { console.error("Notebook snapshot failed:", e); }
        _perf.snapshotMs = performance.now() - _perfSnap0;
      }
      _emitSavePerf();
      return { fileId: currentNotebookFileId, content };
    }
  } catch (e) {
    console.error("Failed to save notebook:", e);
  }
  _emitSavePerf();
  return null;
}

/**
 * Destroy the current NotesCanvas and save if dirty.
 * Returns { fileId, content } if a save occurred, or null otherwise.
 */
export async function unmountNotebook() {
  let saveResult = null;
  if (notebookDirty || cameraDirty) {
    saveResult = await saveNotebook();
  }
  if (_perfPanel) { _perfPanel.destroy(); _perfPanel = null; }
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
      notebookDirty = false;
      cameraDirty = false;
    }
  } catch (e) {
    console.error("Failed to reload notebook shapes from sync:", e);
  }
}
