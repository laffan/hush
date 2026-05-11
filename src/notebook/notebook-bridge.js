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
/** Last content we successfully wrote to disk for the open notebook.
 *  Compared byte-for-byte against incoming sync-reload payloads so an
 *  echoed pull (Dropbox cursor reporting our own write back to us) is
 *  a no-op rather than a destructive `loadShapes` that re-IDs every
 *  stroke and clobbers the engine's selection / undo state. */
let _lastSavedContent = null;

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
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

  currentNotebookFileId = fileId;
  notebookDirty = false;
  cameraDirty = false;
  _lastSavedContent = null;

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

  // Load notebook contents (shapes + layers + flowchart edges) from the
  // backing file. The envelope format is parsed by `decodeNotebookContent`,
  // which tolerates the legacy bare-Shape[] form for older notebooks.
  let snapshot = null;
  try {
    if (IS_TAURI) {
      const file = await tauriInvoke("load_file", { id: fileId });
      const { decodeNotebookContent } = await import("./notebook-content.ts");
      snapshot = decodeNotebookContent(file.content);
    }
  } catch (e) {
    console.error("Failed to load notebook shapes:", e);
  }

  if (snapshot) {
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
    }
  }

  // Apply notebook settings from Hush settings
  applyNotebookSettings(state);

  _appState = state;

  // Listen for shape changes to mark dirty + notify panes
  container.addEventListener("notebook-change", () => {
    notebookDirty = true;
    if (_appState) _appState.emit("notebook-shapes-changed");
  });
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
  if (s.activeStyleId && s.styles) {
    const style = s.styles.find((st) => st.id === s.activeStyleId);
    if (style) {
      bgColors = appearance === "dark" ? style.darkColors : style.lightColors;
    }
  } else {
    bgColors = appearance === "dark" ? s.defaultDarkColors : s.defaultLightColors;
  }
  if (bgColors?.bg) canvasBackgroundOverride = bgColors.bg;

  return {
    appearanceMode: appearance,
    themeId: resolveNotebookTheme(overrideState),
    backgroundPattern: s.notebookBackgroundPattern || "dot-grid",
    gridSpacing: s.notebookGridSpacing || 25,
    gridOpacity: s.notebookGridOpacity != null ? s.notebookGridOpacity : 0.40,
    fontFamily,
    fontSize: s.notebookFontSize || 18,
    canvasBackgroundOverride,
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
  const content = encodeNotebookContent({
    shapes: canvasInstance.getShapes(),
    layers: canvasInstance.state.layers,
    flowEdges: canvasInstance.state.flowchart.serialize(),
    bookmarks: canvasInstance.state.bookmarks,
    camera: canvasInstance.state.camera,
  });
  try {
    if (IS_TAURI) {
      await tauriInvoke("save_file", { id: currentNotebookFileId, content });
      _lastSavedContent = content;
      // Mirror the doc-side cadence: snapshot every successful autosave
      // write — but only when the write covers a real content change.
      // Camera-only saves don't earn a version slot.
      if (wasContentDirty) {
        try { await tauriInvoke("create_snapshot", { documentId: currentNotebookFileId, content }); }
        catch (e) { console.error("Notebook snapshot failed:", e); }
      }
      return { fileId: currentNotebookFileId, content };
    }
  } catch (e) {
    console.error("Failed to save notebook:", e);
  }
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
  if (canvasInstance) {
    canvasInstance.destroy();
    canvasInstance = null;
  }
  if (_mainDragCleanup) { _mainDragCleanup(); _mainDragCleanup = null; }
  currentNotebookFileId = null;
  notebookDirty = false;
  cameraDirty = false;
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
  // Skipping avoids a destructive `loadShapes` (undo wipe + engine
  // stroke-id churn) for a no-op change.
  if (jsonContent === _lastSavedContent) return;
  try {
    const { decodeNotebookContent } = await import("./notebook-content.ts");
    const snapshot = decodeNotebookContent(jsonContent);
    if (snapshot) {
      canvasInstance.loadShapes(snapshot.shapes, snapshot.layers);
      canvasInstance.state.flowchart.deserialize(snapshot.flowEdges);
      if (Array.isArray(snapshot.bookmarks)) {
        canvasInstance.state.bookmarks = snapshot.bookmarks;
        canvasInstance.state.notify("bookmarks");
      }
      // Deliberately skip applying snapshot.camera here — viewports differ
      // across devices, and an incoming sync nudging the local pan / zoom
      // would feel like the canvas was being yanked around.
      _lastSavedContent = jsonContent;
      notebookDirty = false;
      cameraDirty = false;
    }
  } catch (e) {
    console.error("Failed to reload notebook shapes from sync:", e);
  }
}
