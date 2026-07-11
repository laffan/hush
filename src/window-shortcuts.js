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
import { isPaneActive } from "./pane/pane-manager.js";

/**
 * Wire window activation to focus the active editing surface so keyboard
 * shortcuts fire without an extra click. macOS `focus` lands before the
 * WebView is first-responder (rAF defers past it); iOS doesn't always
 * fire `focus`, so `visibilitychange` is the reliable signal there.
 */
export function installActivationFocus(state, notebookContainer) {
  notebookContainer.setAttribute("tabindex", "-1");
  notebookContainer.style.outline = "none";
  function refocus() {
    if (isPaneActive()) return;
    requestAnimationFrame(() => {
      if (state.currentNotebookFileId) notebookContainer.focus({ preventScroll: true });
      else if (state.editor) state.editor.focus();
    });
  }
  window.addEventListener("focus", refocus);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refocus();
  });
}

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
    const alwaysAllowedKeys = ["shortcutToggleSidebar", "shortcutToggleOutline", "shortcutOpenFullscreen", "shortcutSwitchDesks"];
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
        // Zen Focus — same pattern: the shortcut should reach the
        // user wherever they're typing prose, including a text shape.
        const zen = state.settings.shortcutZenFocus;
        if (zen && matchesDomEvent(e, zen)) {
          const handler = windowCommands.shortcutZenFocus;
          if (handler) { e.preventDefault(); handler(state, null); return; }
        }
        // Find — the panel reads `window.getSelection()` as a fallback
        // so a textarea selection still seeds the search field.
        const find = state.settings.shortcutFind;
        if (find && matchesDomEvent(e, find)) {
          const handler = windowCommands.shortcutFind;
          if (handler) { e.preventDefault(); handler(state, null); return; }
        }
      }
    }
    // Properties UI — the View/Hide toggle should still work while focus
    // sits in one of the frontmatter widget's inputs, so the same key
    // that opened the panel can close it mid-edit.
    if (isTextField && t.closest?.(".cm-properties")) {
      const sc = state.settings.shortcutToggleProperties;
      if (sc && matchesDomEvent(e, sc)) {
        const handler = windowCommands.shortcutToggleProperties;
        if (handler) { e.preventDefault(); handler(state, null); return; }
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
