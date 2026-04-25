/**
 * Window-level keyboard shortcut fallback. Fires when CodeMirror hasn't
 * already consumed the event (CM calls `preventDefault()` for any binding
 * it handles, so we skip handled events to avoid double-firing).
 *
 * Coordinates with notebook mode and inline text-shape editors so that
 * the always-allowed UI shortcuts (sidebar / outline / fullscreen) and
 * Cmd+P / Cmd+O always work, while text-field focus suppresses
 * everything else except a handful of explicit cases.
 */
import { dispatchDomShortcut, matchesDomEvent } from "./shortcuts.js";
import { toggleCommandPalette, openFilePalette } from "./command-palette.js";
import { openSettingsWindow } from "./settings/settings-ui.js";

export function installWindowShortcuts(state, windowCommands) {
  window.addEventListener("keydown", (e) => {
    // Skip shortcuts already consumed by CodeMirror's keymap.  When the
    // editor is focused, CM calls `preventDefault()` as soon as it handles
    // a binding, so we avoid double-firing here.
    if (e.defaultPrevented) return;

    // Cmd+P — toggle command palette (works even from input fields)
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "p") {
      e.preventDefault();
      toggleCommandPalette(state);
      return;
    }

    // Cmd+O / Cmd+Shift+O — jump straight into the palette's
    // file-picker mode. Matches the "Open document or notebook" /
    // "Open as pane" palette commands but skips the intermediate hop.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "o" || e.key === "O")) {
      e.preventDefault();
      openFilePalette(state, e.shiftKey ? "pane" : "open");
      return;
    }

    // A small set of global UI shortcuts should fire regardless of focus —
    // the sidebar/outline/fullscreen toggles are expected to work whether
    // the user is inside the editor, a notebook text shape, a pane, or the
    // body. Check these up front before the text-field guard so they
    // aren't swallowed by focus state.
    const alwaysAllowedKeys = ["shortcutToggleSidebar", "shortcutToggleOutline", "shortcutOpenFullscreen"];
    for (const key of alwaysAllowedKeys) {
      const sc = state.settings[key];
      if (sc && matchesDomEvent(e, sc)) {
        const handler = windowCommands[key];
        if (handler) { e.preventDefault(); handler(state, null); return; }
      }
    }

    const t = e.target;
    const tag = t && t.tagName;
    const isTextField = !!t && (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable);
    const inNotebook = document.body.classList.contains("notebook-mode");
    const inNotebookInlineEditor = !!t && tag === "TEXTAREA" && t.classList?.contains("inline-text-editor");
    if (isTextField && inNotebook) {
      // Cmd+, — open settings (also hardcoded below for canvas focus)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === ",") {
        e.preventDefault(); openSettingsWindow(state); return;
      }
      // Zotero — allow Insert Reference to fire from inside an inline
      // text-shape editor so users can cite while editing a text shape.
      // The modal's insert path routes back into the textarea (see
      // zotero.js getActiveNotebookTextEditor).
      if (inNotebookInlineEditor) {
        const sc = state.settings.shortcutZotero;
        if (sc && matchesDomEvent(e, sc)) {
          const handler = windowCommands.shortcutZotero;
          const mainView = state.editor ? state.editor.view : null;
          if (handler) { e.preventDefault(); handler(state, mainView); return; }
        }
      }
    }
    // Don't hijack keystrokes in text input fields.  In notebook mode the
    // target is the canvas element, not body — let shortcuts through.
    if (isTextField) return;
    // Cmd+, — open settings (CodeMirror handles this in doc mode, but
    // we need an explicit check for notebook mode)
    if (state.currentNotebookFileId && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === ",") {
      e.preventDefault(); openSettingsWindow(state); return;
    }

    const view = state.editor ? state.editor.view : null;
    if (dispatchDomShortcut(e, state, windowCommands, view)) {
      e.preventDefault();
    }
  });
}
