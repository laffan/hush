/**
 * Notebook bridge — manages the NotesCanvas lifecycle within Hush.
 * Handles mounting/unmounting, loading/saving shapes, and autosave.
 */

let canvasInstance = null;
let currentNotebookFileId = null;
let notebookDirty = false;
let _appState = null;

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

  currentNotebookFileId = fileId;
  notebookDirty = false;

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

  // Load shapes from the backing file
  let shapes = [];
  try {
    if (IS_TAURI) {
      const file = await tauriInvoke("load_file", { id: fileId });
      if (file.content && file.content.trim()) {
        shapes = JSON.parse(file.content);
      }
    }
  } catch (e) {
    console.error("Failed to load notebook shapes:", e);
  }

  if (Array.isArray(shapes) && shapes.length > 0) {
    canvasInstance.loadShapes(shapes);
  }

  // Apply notebook settings from Hush settings
  applyNotebookSettings(state);

  _appState = state;

  // Listen for shape changes to mark dirty + notify panes
  container.addEventListener("notebook-change", () => {
    notebookDirty = true;
    if (_appState) _appState.emit("notebook-shapes-changed");
  });

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
 * Apply Hush settings to the active NotesCanvas.
 * Appearance, theme, and font are derived from the current Hush editor style
 * so that switching styles in the editor carries over to notebooks.
 * Grid settings use their own dedicated notebook fields.
 */
export function applyNotebookSettings(state) {
  if (!canvasInstance) return;
  const s = state.settings;

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

  canvasInstance.applySettings({
    appearanceMode: appearance,
    themeId: resolveNotebookTheme(state),
    backgroundPattern: s.notebookBackgroundPattern || "dot-grid",
    gridSpacing: s.notebookGridSpacing || 25,
    gridOpacity: s.notebookGridOpacity != null ? s.notebookGridOpacity : 0.15,
    fontFamily,
    fontSize: s.notebookFontSize || 18,
  });
}

/**
 * Save the current notebook shapes to the backing file.
 * Called by the autosave interval and on notebook switch.
 * Returns { fileId, content } when a save occurs, or null if nothing to save.
 */
export async function saveNotebook() {
  if (!canvasInstance || !currentNotebookFileId || !notebookDirty) return null;
  notebookDirty = false;
  const shapes = canvasInstance.getShapes();
  const content = JSON.stringify(shapes);
  try {
    if (IS_TAURI) {
      await tauriInvoke("save_file", { id: currentNotebookFileId, content });
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
export function reloadNotebookShapes(jsonContent) {
  if (!canvasInstance) return;
  try {
    const shapes = JSON.parse(jsonContent);
    if (Array.isArray(shapes)) {
      canvasInstance.loadShapes(shapes);
      notebookDirty = false;
    }
  } catch (e) {
    console.error("Failed to reload notebook shapes from sync:", e);
  }
}
