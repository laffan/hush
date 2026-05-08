/**
 * Pane editor factory — creates a fully-featured CodeMirror 6 editor
 * for use inside floating panes.  Uses `createBaseExtensions` from
 * editor.js so pane editors share the exact same plugin / shortcut /
 * theme setup as the main editor.
 */

import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { syntaxHighlighting } from "@codemirror/language";
import { getActiveTheme } from "../themes/index.js";
import {
  createBaseExtensions, getMarkdownHighlight, buildShortcutExtension,
} from "../editor/editor.js";
import { resolveStyleForAppearance } from "../sidebar/styles-panel.js";
import { themeBackgrounds } from "../theme-colors.js";
import { hasAcceptableDragPayload, readDragText } from "../editor/file-drop.js";

/**
 * Create a CodeMirror editor suitable for a floating pane.
 * Returns { view, getContent, setContent, focus, blur, destroy, reconfigureTheme }.
 */
export function createPaneEditor(container, appState, onChange, opts) {
  // The pane caller passes a `getLocalSyncContext` resolver that reads
  // its own `pane.localSync` so this pane's image-decorator targets the
  // right mounted folder even when the main editor is showing a
  // different doc. Falls back to no context (global Images store).
  const getImageContext = opts?.getLocalSyncContext || (() => null);
  const { extensions, themeComp, highlightComp, shortcutComp, editableComp } =
    createBaseExtensions(appState, onChange ? () => onChange() : null, { getImageContext });

  const startState = EditorState.create({ doc: "", extensions });
  const view = new EditorView({ state: startState, parent: container });

  return {
    view,
    getContent: () => view.state.doc.toString(),
    setContent: (text) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    focus: () => view.focus(),
    blur: () => view.contentDOM.blur(),
    setEditable: (editable) => {
      view.dispatch({ effects: editableComp.reconfigure(EditorView.editable.of(editable)) });
    },
    /** Select the given range and scroll it to the centre of the pane.
     *  Used by the shelf's search results so a click jumps the reader to
     *  the matched text. */
    scrollToPosition: (from, to) => {
      const docLen = view.state.doc.length;
      const a = Math.max(0, Math.min(docLen, from));
      const b = Math.max(0, Math.min(docLen, to ?? from));
      view.dispatch({
        selection: { anchor: a, head: b },
        effects: EditorView.scrollIntoView(a, { y: "center" }),
      });
      view.focus();
    },
    /** Read / write the editor's scroll offset so the host (pane
     *  persistence + sync) can stash and restore it. */
    getScrollTop: () => view.scrollDOM.scrollTop,
    setScrollTop: (px) => { view.scrollDOM.scrollTop = px; },
    /** Subscribe to scroll events on the editor's scroller. Returns an
     *  unsubscribe function. The host throttles writes via the persist
     *  debounce so this fires plenty often. */
    onScroll: (handler) => {
      const sd = view.scrollDOM;
      sd.addEventListener("scroll", handler, { passive: true });
      return () => sd.removeEventListener("scroll", handler);
    },
    destroy: () => view.destroy(),
    /** Reconfigure theme from the given settings. When `lockedStyleId` is
     *  provided, the pane uses that style instead of the session's active
     *  style — this is how panes showing a document with a locked style
     *  (set via the command palette's "Lock style to document" entry)
     *  end up with that style even when the main editor is showing
     *  something else. */
    reconfigureTheme: (settings, lockedStyleId) => {
      const effective = lockedStyleId
        ? resolveLockedStyleSettings(settings, lockedStyleId)
        : settings;
      const t = getActiveTheme(effective);
      const style = effective.activeStyleId
        ? (effective.styles || []).find(s => s.id === effective.activeStyleId) : null;
      const nh = style?.suppressHeaderSize ?? effective.normalizeHeaders;
      const nhc = style?.suppressHeaderColor ?? effective.normalizeHeaderColor;
      const hScale = style?.headerScale ?? effective.headerScale ?? 1.0;
      const headerOverride = (style && ((effective.appearance === "dark" ? style.darkColors : style.lightColors)?.header))
        || undefined;
      view.dispatch({
        effects: [
          themeComp.reconfigure(t ? t.extension : []),
          highlightComp.reconfigure(syntaxHighlighting(
            getMarkdownHighlight(nh, nhc ? undefined : (headerOverride || t?.headingColor), hScale)
          )),
          shortcutComp.reconfigure(buildShortcutExtension(appState)),
        ],
      });
      // Apply the style's color overrides directly to this pane's
      // .cm-editor — mirroring what main.js's applyActiveStyle does for
      // the main editor. The global CSS vars (--bg, --fg, etc.) reach
      // the pane wrapper but the CodeMirror theme extension paints its
      // own background/foreground inside, so without inline overrides
      // here the pane keeps showing the theme's stock colours.
      applyStyleColorsToView(view, style, effective);
    },
  };
}

/** Wire dragover/drop on a doc pane's content element so plain text
 *  dragged in from outside (or from another pane) lands at the drop
 *  point. CodeMirror's internal drop path is unreliable inside the
 *  pane (the same WebView quirk that motivated `editor/file-drop.js`
 *  for the main editor) and the global drop net handles only the main
 *  editor / notebook canvas, leaving panes silent. */
export function attachPaneTextDrop(pane) {
  const content = pane._content;
  if (!content) return;
  content.addEventListener("dragover", (e) => {
    if (!hasAcceptableDragPayload(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }, true);
  content.addEventListener("drop", (e) => {
    if (!hasAcceptableDragPayload(e)) return;
    const text = readDragText(e);
    if (!text) return;
    const view = pane.editor?.view;
    if (!view) return;
    e.preventDefault();
    e.stopPropagation();
    let pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
    if (pos == null) pos = view.state.selection.main.head;
    view.dispatch({
      changes: { from: pos, to: pos, insert: text },
      selection: { anchor: pos + text.length },
    });
    view.focus();
  }, true);
}

/** Apply the active style's color overrides (bg / fg / cursor /
 *  selection) inline to the pane's `.cm-editor` element. Without this,
 *  the CodeMirror theme extension's stock palette wins inside the pane
 *  even though the user has overrides — the main editor avoids this by
 *  setting the same inline styles on its own .cm-editor in
 *  main.js::applyActiveStyle. */
function applyStyleColorsToView(view, style, settings) {
  const root = view.dom;
  if (!root) return;
  // The pane wrapper (`.floating-pane`) draws the title-bar backdrop
  // via its own `background: var(--bg)`. The global --bg gets
  // updated by main.js::applyActiveStyle, but the cascade can lag in
  // edge cases (legacy styles missing one of light/darkThemeId, or
  // an upstream race we'd rather not depend on). Pinning the
  // wrapper's bg inline alongside the cm-editor's bg makes the
  // pane's title-bar background track the active style 1:1.
  const wrapper = root.closest(".floating-pane");
  // Resolve the appearance, accounting for "auto".
  let appearance = settings.appearance || "dark";
  if (appearance === "auto") {
    appearance = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  // Global-theme fallback for the no-override / legacy-style case so
  // the pane never inherits whatever --bg happened to be before.
  const fallbackBg = themeBackgrounds[
    appearance === "dark" ? settings.darkTheme : settings.lightTheme
  ] || null;
  // No active style → strip any prior overrides so the theme's own
  // palette shows through cleanly.
  if (!style) {
    root.style.backgroundColor = "";
    root.style.color = "";
    root.style.removeProperty("--style-fg");
    root.style.removeProperty("--cursor");
    root.style.removeProperty("--selection");
    if (wrapper) wrapper.style.backgroundColor = fallbackBg || "";
    return;
  }
  const { themeId, colors } = resolveStyleForAppearance(style, settings.appearance);
  const overrides = colors || {};
  const effectiveBg = overrides.bg || themeBackgrounds[themeId] || fallbackBg;
  if (overrides.bg) {
    root.style.backgroundColor = overrides.bg;
  } else if (effectiveBg) {
    root.style.backgroundColor = effectiveBg;
  } else {
    root.style.backgroundColor = "";
  }
  if (wrapper) wrapper.style.backgroundColor = effectiveBg || "";
  if (overrides.fg) {
    root.style.color = overrides.fg;
    root.style.setProperty("--style-fg", overrides.fg);
    if (!overrides.cursor) root.style.setProperty("--cursor", overrides.fg);
  } else {
    root.style.color = "";
    root.style.removeProperty("--style-fg");
    if (!overrides.cursor) root.style.removeProperty("--cursor");
  }
  if (overrides.cursor) root.style.setProperty("--cursor", overrides.cursor);
  if (overrides.selection) root.style.setProperty("--selection", overrides.selection);
  else root.style.removeProperty("--selection");
}

/** Build a shallow copy of settings with its activeStyleId swapped for
 *  the locked style id. "__default__" means "no style" — explicitly clear
 *  activeStyleId so the default theme/font is used. */
function resolveLockedStyleSettings(settings, lockedStyleId) {
  if (lockedStyleId === "__default__") {
    return { ...settings, activeStyleId: null };
  }
  const exists = (settings.styles || []).some(s => s.id === lockedStyleId);
  if (!exists) return settings; // style was deleted — fall back to session
  return { ...settings, activeStyleId: lockedStyleId };
}
