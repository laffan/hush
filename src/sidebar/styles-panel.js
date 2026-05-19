/**
 * Style helpers — the sidebar Styles panel is retired (styles live in
 * the command palette + Edit Styles modal). This file keeps the small
 * helpers other modules still import: appearance resolution and the
 * per-document "Lock style" accessors.
 */

import { migrateStyle } from "./styles-panel-shared.js";

/** Get the appearance-appropriate theme/colors from a style. */
export function resolveStyleForAppearance(style, appearance) {
  const s = migrateStyle(style);
  let mode = appearance || "dark";
  if (mode === "auto") mode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return {
    themeId: mode === "dark" ? s.darkThemeId : s.lightThemeId,
    colors: mode === "dark" ? (s.darkColors || {}) : (s.lightColors || {}),
  };
}

/** Check if the current document has a locked style. */
export function getLockedStyleId(state) {
  if (!state.currentFileId || !state.fileTree) return null;
  function search(nodes) {
    for (const n of nodes) {
      if (n.fileId === state.currentFileId) return n.lockedStyleId || null;
      if (n.children) { const r = search(n.children); if (r) return r; }
    }
    return null;
  }
  return search(state.fileTree);
}

/** Set or clear the locked style on the current document's tree node. */
export async function setLockedStyleId(state, styleId) {
  if (!state.currentFileId || !state.fileTree) return;
  function search(nodes) {
    for (const n of nodes) {
      if (n.fileId === state.currentFileId) { n.lockedStyleId = styleId || undefined; return true; }
      if (n.children && search(n.children)) return true;
    }
    return false;
  }
  if (search(state.fileTree)) {
    await state.saveFileTree();
    state.emit("files-changed");
  }
}
