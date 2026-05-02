/**
 * Notebook bridge — manages the NotesCanvas lifecycle within Hush.
 * Handles mounting/unmounting, loading/saving shapes, and autosave.
 */

let canvasInstance = null;
let currentNotebookFileId = null;
let notebookDirty = false;
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
  }

  // Apply notebook settings from Hush settings
  applyNotebookSettings(state);

  _appState = state;

  // Listen for shape changes to mark dirty + notify panes
  container.addEventListener("notebook-change", () => {
    notebookDirty = true;
    if (_appState) _appState.emit("notebook-shapes-changed");
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
  // Empty string = no override.
  let canvasBackgroundOverride = "";
  if (s.activeStyleId && s.styles) {
    const style = s.styles.find((st) => st.id === s.activeStyleId);
    if (style) {
      const colors = appearance === "dark"
        ? (style.darkColors || {})
        : (style.lightColors || {});
      if (colors.bg) canvasBackgroundOverride = colors.bg;
    }
  }

  return {
    appearanceMode: appearance,
    themeId: resolveNotebookTheme(overrideState),
    backgroundPattern: s.notebookBackgroundPattern || "dot-grid",
    gridSpacing: s.notebookGridSpacing || 25,
    gridOpacity: s.notebookGridOpacity != null ? s.notebookGridOpacity : 0.15,
    fontFamily,
    fontSize: s.notebookFontSize || 18,
    canvasBackgroundOverride,
    maxTextWidth: s.notebookTextMaxWidth || 350,
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
 * Save the current notebook shapes to the backing file.
 * Called by the autosave interval and on notebook switch.
 * Returns { fileId, content } when a save occurs, or null if nothing to save.
 */
export async function saveNotebook() {
  if (!canvasInstance || !currentNotebookFileId || !notebookDirty) return null;
  notebookDirty = false;
  const { encodeNotebookContent } = await import("./notebook-content.ts");
  const content = encodeNotebookContent({
    shapes: canvasInstance.getShapes(),
    layers: canvasInstance.state.layers,
    flowEdges: canvasInstance.state.flowchart.serialize(),
    bookmarks: canvasInstance.state.bookmarks,
  });
  try {
    if (IS_TAURI) {
      await tauriInvoke("save_file", { id: currentNotebookFileId, content });
      _lastSavedContent = content;
      // Mirror the doc-side cadence: snapshot every successful autosave
      // write. The backend's decay rules (snapshots.rs) keep volume bounded
      // and the JSON envelope is what restore consumes.
      try { await tauriInvoke("create_snapshot", { documentId: currentNotebookFileId, content }); }
      catch (e) { console.error("Notebook snapshot failed:", e); }
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
  if (notebookDirty) {
    saveResult = await saveNotebook();
  }
  if (canvasInstance) {
    canvasInstance.destroy();
    canvasInstance = null;
  }
  if (_mainDragCleanup) { _mainDragCleanup(); _mainDragCleanup = null; }
  currentNotebookFileId = null;
  notebookDirty = false;
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
      _lastSavedContent = jsonContent;
      notebookDirty = false;
    }
  } catch (e) {
    console.error("Failed to reload notebook shapes from sync:", e);
  }
}
