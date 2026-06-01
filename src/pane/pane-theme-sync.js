/**
 * Pane theme / style sync — ratchet lock, style hover previews, and
 * the post-style-change refresh that walks every pane and reapplies
 * the active style (or the file's locked style, if any). Pulled out
 * of pane-manager.js to keep that file focused on lifecycle.
 */

import { panes, appState, setActivePaneId, getNotebookBridge } from "./pane-state.js";
import { findLockedStyleForFile } from "./pane-content.js";

/** Ratchet locks every pane editor — clicking into one shouldn't unlock
 *  the editor and let the user write outside the ratcheted document.
 *  Notebook panes have no `editable` toggle, so we just clear focus. */
export function syncPaneRatchetLock() {
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

/** Apply a hovered-style preview to every non-locked pane. Synthesises
 *  a settings object with the previewed style as activeStyleId and
 *  routes it through the same reconfigureTheme path the real selection
 *  uses. Locked panes are skipped so they don't flicker on hover. */
export async function previewPaneStyle(styleObj) {
  if (!appState || !styleObj || !styleObj.id) return;
  const baseStyles = appState.settings.styles || [];
  const styles = baseStyles.some((s) => s.id === styleObj.id)
    ? baseStyles.map((s) => (s.id === styleObj.id ? { ...s, ...styleObj } : s))
    : [...baseStyles, styleObj];
  const synthSettings = { ...appState.settings, activeStyleId: styleObj.id, styles };
  let bridge = null;
  for (const [, pane] of panes) {
    if (findLockedStyleForFile(pane.fileId)) continue;
    if (pane.editor?.reconfigureTheme) {
      pane.editor.reconfigureTheme(synthSettings, null);
    }
    if (pane.notebook) {
      if (!bridge) bridge = await getNotebookBridge();
      pane.notebook.applySettings(
        bridge.computeNotebookSettings({ ...appState, settings: synthSettings }, null),
      );
    }
  }
}

/** Re-resolve every pane's theme + style and pick up tree-side renames. */
export async function syncPaneThemes() {
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
    // Track tree-side renames — covers manual renames and the auto-
    // rename-from-first-line that fires for fresh "Untitled" docs.
    if (pane.fileType === "document" || pane.fileType === "notebook" || pane.fileType === "stack") {
      const node = findNodeByFileId(appState.fileTree, pane.fileId);
      if (node && node.name && node.name !== pane.fileName) {
        pane.fileName = node.name;
        const titleLink = pane._titlebar?.querySelector(".fp-title-link");
        if (titleLink) titleLink.textContent = node.name;
      }
    }
  }
}
