/**
 * Notebook bridge — manages the NotesCanvas lifecycle within Hush.
 * Handles mounting/unmounting, loading/saving shapes, and autosave.
 */

let canvasInstance = null;
let currentNotebookFileId = null;
let notebookDirty = false;

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
  canvasInstance = new NotesCanvas(container);

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

  // Listen for shape changes to mark dirty
  container.addEventListener("notebook-change", () => {
    notebookDirty = true;
  });

  return canvasInstance;
}

/**
 * Apply Hush notebook settings to the active NotesCanvas
 */
export function applyNotebookSettings(state) {
  if (!canvasInstance) return;
  const s = state.settings;
  canvasInstance.applySettings({
    appearanceMode: s.notebookAppearanceMode || "light",
    themeId: s.notebookThemeId || "default",
    backgroundPattern: s.notebookBackgroundPattern || "grid",
    gridSpacing: s.notebookGridSpacing || 25,
    gridOpacity: s.notebookGridOpacity != null ? s.notebookGridOpacity : 0.15,
    fontFamily: s.notebookFontFamily || "Inter",
    fontSize: s.notebookFontSize || 18,
  });
}

/**
 * Save the current notebook shapes to the backing file.
 * Called by the autosave interval and on notebook switch.
 */
export async function saveNotebook() {
  if (!canvasInstance || !currentNotebookFileId || !notebookDirty) return;
  notebookDirty = false;
  const shapes = canvasInstance.getShapes();
  const content = JSON.stringify(shapes);
  try {
    if (IS_TAURI) {
      await tauriInvoke("save_file", { id: currentNotebookFileId, content });
    }
  } catch (e) {
    console.error("Failed to save notebook:", e);
  }
}

/**
 * Destroy the current NotesCanvas and save if dirty.
 */
export async function unmountNotebook() {
  if (notebookDirty) {
    await saveNotebook();
  }
  if (canvasInstance) {
    canvasInstance.destroy();
    canvasInstance = null;
  }
  currentNotebookFileId = null;
  notebookDirty = false;
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
