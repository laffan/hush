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
import { createBaseExtensions, buildShortcutExtension, programmaticAnnotations } from "../editor/base-extensions.js";
import { bindLineIndicatorToContainer } from "../editor/line-indicator.js";
import { bindCursorModeToContainer, paintCursorMode, resolveCursorPaint } from "../editor/block-cursor.js";
import { getMarkdownHighlight } from "../editor/markdown-highlight.js";
import { bypassSeparatorFilter } from "../editor/plugins/project-view.js";
import { createDryHighlightPlugin } from "../editor/plugins/dry-highlight.js";
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

  // When a modeContext proxy is supplied, plugins read per-editor mode
  // flags (focusMode, typewriterMode, dryMode) from it instead of the
  // global appState. Without one, behaviour is unchanged — everything
  // reads the global flags.
  const modeRef = opts?.modeContext || appState;
  const hasModeCtx = !!opts?.modeContext;

  // `flushLineIndicator`: a pane / stack column has no gutter for the
  // arrow + border indicators to hang in, and its host clips — so they
  // attach to this surface's own edges instead of to the text column.
  const { extensions, themeComp, highlightComp, shortcutComp, editableComp } =
    createBaseExtensions(modeRef, onChange ? () => onChange() : null, {
      getImageContext,
      flushLineIndicator: true,
    });

  const dryPlugin = createDryHighlightPlugin(modeRef);

  const typewriterUpdateListener = EditorView.updateListener.of((update) => {
    if (modeRef.typewriterMode && (update.docChanged || update.selectionSet || update.focusChanged)) {
      requestAnimationFrame(() => scrollPaneCursorToTypewriter(update.view, modeRef, container));
    }
  });

  const extraExts = opts?.extraExtensions || [];
  const startState = EditorState.create({
    doc: "",
    extensions: [...extensions, dryPlugin, typewriterUpdateListener, ...extraExts],
  });
  const view = new EditorView({ state: startState, parent: container });
  const unbindLineIndicator = bindLineIndicatorToContainer(container, appState);
  // The settings this surface is themed from. Starts as the session's
  // and is replaced by `reconfigureTheme` once a locked style resolves,
  // so the cursor binding below repaints against the style the surface
  // is actually showing rather than the one the session is on.
  let themedSettings = appState.settings;
  const unbindCursorMode = bindCursorModeToContainer(container, appState, () => themedSettings);

  if (modeRef.typewriterMode) {
    _applyPaneTypewriter(view, modeRef, container);
  }

  // React to global mode toggles. When this editor has its own mode
  // context the global event only needs to nudge CM (so theme / settings
  // updates propagate); mode flags are managed by the context's toggle().
  // Without a mode context, apply typewriter from the global flag.
  const onModeChanged = () => {
    if (!hasModeCtx) _applyPaneTypewriter(view, modeRef, container);
    try { view.dispatch({ effects: [] }); } catch (_) {}
  };
  appState.on("mode-changed", onModeChanged);

  return {
    view,
    getContent: () => view.state.doc.toString(),
    /** Programmatic load / mirror (initial content, main-editor sync).
     *  Applied as a minimal diff excluded from the pane's undo history,
     *  so mirrors from the main editor can't be "undone" from the pane
     *  and the pane's own edit history maps through them intact. */
    setContent: (text) => {
      const cur = view.state.doc.toString();
      if (cur === text) return;
      let from = 0;
      const minLen = Math.min(cur.length, text.length);
      while (from < minLen && cur.charCodeAt(from) === text.charCodeAt(from)) from++;
      let curTo = cur.length;
      let newTo = text.length;
      while (curTo > from && newTo > from
        && cur.charCodeAt(curTo - 1) === text.charCodeAt(newTo - 1)) {
        curTo--;
        newTo--;
      }
      view.dispatch({
        changes: { from, to: curTo, insert: text.slice(from, newTo) },
        annotations: [bypassSeparatorFilter.of(true), ...programmaticAnnotations()],
      });
    },
    focus: () => view.focus(),
    blur: () => view.contentDOM.blur(),
    /** Lock / unlock this surface for typing. Panes flip this on every
     *  focus change (`focusPane` unlocks the one you clicked and locks
     *  the one you left), and flipping `EditorView.editable` rewrites
     *  `contenteditable` on `.cm-content` — which in WebKit tears down
     *  and rebuilds that subtree's render tree, taking the scroller's
     *  position with it. The pane came back parked at the top of the
     *  document, and because the reset lands on the *blur* the user
     *  only sees it when the pane is next focused. Hold the offset
     *  across the flip: once now, once after CodeMirror's measure pass,
     *  and only when it actually moved. */
    setEditable: (editable) => {
      const scroller = view.scrollDOM;
      const before = scroller.scrollTop;
      view.dispatch({ effects: editableComp.reconfigure(EditorView.editable.of(editable)) });
      const restore = () => { if (scroller.scrollTop !== before) scroller.scrollTop = before; };
      restore();
      requestAnimationFrame(restore);
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
    destroy: () => {
      appState.off("mode-changed", onModeChanged);
      unbindLineIndicator();
      unbindCursorMode();
      _removePaneTypewriter(view, container);
      view.destroy();
    },
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
      themedSettings = effective;
      const t = getActiveTheme(effective);
      const style = effective.activeStyleId
        ? (effective.styles || []).find(s => s.id === effective.activeStyleId) : null;
      const nh = style?.suppressHeaderSize ?? effective.normalizeHeaders;
      const nhc = style?.suppressHeaderColor ?? effective.normalizeHeaderColor;
      const hScale = style?.headerScale ?? effective.headerScale ?? 1.0;
      const headerOverrideSource = style
        ? (effective.appearance === "dark" ? style.darkColors : style.lightColors)
        : (effective.appearance === "dark" ? effective.defaultDarkColors : effective.defaultLightColors);
      const headerOverride = headerOverrideSource?.header || undefined;
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
      // Cursor mode (system / block / underline) is a class on the
      // container, not something the CodeMirror theme can carry — repaint
      // it here so a locked style's cursor lands with the rest of its
      // colours instead of waiting for the next global style event.
      paintCursorMode(container, resolveCursorPaint(effective));
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

// ── Pane-local typewriter helpers ─────────────────────────────────────

/** Called by mode-context toggle() to apply/remove typewriter from a
 *  per-editor mode proxy. Exported so the mode-context module can reach
 *  it without a circular import on the full pane-editor factory. */
export function applyPaneTypewriterFromContext(view, modeRef, container) {
  _applyPaneTypewriter(view, modeRef, container);
}

/** Where the typewriter line sits inside the host box, as a fraction of
 *  its height. Panes share the main editor's `typewriterPosition` (the
 *  value its draggable boundary writes) so both surfaces agree on where
 *  the line belongs; the pane just measures its own box instead of the
 *  window. Clamped so a boundary dragged to the very edge of the screen
 *  still leaves a usable band inside a small pane. */
function paneTypewriterOffset(state, containerH) {
  const raw = Number(state.typewriterPosition);
  const frac = Number.isFinite(raw) ? Math.min(0.9, Math.max(0.1, raw)) : 0.6;
  return Math.round(containerH * frac);
}

function _applyPaneTypewriter(view, state, container) {
  if (!state.typewriterMode) {
    _removePaneTypewriter(view, container);
    return;
  }
  const scroller = view.scrollDOM;
  const containerH = container.clientHeight || 300;
  const targetY = paneTypewriterOffset(state, containerH);
  // Top padding on the scroller pushes line 1 down to the boundary.
  // The runway below has to go on `.cm-content`, NOT on the scroller:
  // WebKit doesn't count a scroll container's own bottom padding as
  // scrollable overflow, so scroller padding gives the last lines
  // nothing to scroll into and the cursor sticks below the line at the
  // end of a document. (The main editor solves the same problem with
  // real blank lines appended to the buffer; a pane holds the whole
  // file and writes the whole file back on save, so it stays away from
  // the buffer and pads the element instead.)
  scroller.style.paddingTop = targetY + "px";
  scroller.style.paddingBottom = "0px";
  view.contentDOM.style.paddingBottom = Math.max(0, containerH - targetY) + "px";

  let line = container.querySelector(".pane-tw-line");
  if (!line) {
    line = document.createElement("div");
    line.className = "pane-tw-line";
    container.appendChild(line);
  }
  const rawOpacity = state.settings.typewriterLineOpacity ?? 0.08;
  Object.assign(line.style, {
    position: "absolute",
    left: "0",
    right: "0",
    top: targetY + "px",
    height: "1px",
    background: "var(--fg, #888)",
    opacity: String(Math.max(rawOpacity, 0.25)),
    pointerEvents: "none",
    zIndex: "5",
  });

  observePaneTypewriterResize(view, state, container);
  requestAnimationFrame(() => scrollPaneCursorToTypewriter(view, state, container));
}

/** Re-centre the line and the cursor whenever the host box changes size.
 *  Every way a pane can be scaled ends in a size change on this element
 *  — the resize handles, a dock reflow, the size popover, a window
 *  resize, a stack column re-layout — so one observer covers them all
 *  where hooking each caller would not. (A pane attached to a notebook
 *  canvas is scaled by a CSS transform, which leaves the box alone: the
 *  line and its padding scale with everything else, as they should.) */
function observePaneTypewriterResize(view, state, container) {
  if (container.__twResizeObserver || typeof ResizeObserver === "undefined") return;
  let pending = false;
  const obs = new ResizeObserver(() => {
    if (pending) return;
    pending = true;
    // Coalesce to one pass per frame: a drag-resize fires this on every
    // pointer sample, and each pass reads layout.
    requestAnimationFrame(() => {
      pending = false;
      if (!container.__twResizeObserver) return; // torn down mid-flight
      if (!state.typewriterMode) { _removePaneTypewriter(view, container); return; }
      _applyPaneTypewriter(view, state, container);
    });
  });
  container.__twResizeObserver = obs;
  obs.observe(container);
}

/** Remove typewriter padding, the boundary line, and the size watcher. */
function _removePaneTypewriter(view, container) {
  if (view && view.scrollDOM) {
    view.scrollDOM.style.paddingTop = "";
    view.scrollDOM.style.paddingBottom = "";
    if (view.contentDOM) view.contentDOM.style.paddingBottom = "";
  }
  if (container) {
    const line = container.querySelector(".pane-tw-line");
    if (line) line.remove();
    if (container.__twResizeObserver) {
      container.__twResizeObserver.disconnect();
      container.__twResizeObserver = null;
    }
  }
}

/** Scroll the pane's editor so the cursor sits at the typewriter line. */
function scrollPaneCursorToTypewriter(view, state, container) {
  if (!state.typewriterMode) return;
  const scroller = view.scrollDOM;
  const containerH = container.clientHeight || 300;
  const targetY = paneTypewriterOffset(state, containerH);
  try {
    const cursor = view.state.selection.main.head;
    const coords = view.coordsAtPos(cursor);
    if (!coords) return;
    const containerRect = container.getBoundingClientRect();
    const offset = coords.bottom - (containerRect.top + targetY);
    if (Math.abs(offset) > 1) {
      scroller.scrollTop += offset;
    }
  } catch (_) { /* view may be destroyed or doc empty */ }
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
  // Resolve overrides + theme. The Default style (no `style` arg) keeps
  // its bg/fg/cursor/selection on AppSettings.defaultLight/DarkColors —
  // mirror style-application.js::applyActiveStyle so panes pick up those
  // overrides too. Without this branch, default-style overrides repaint
  // the main editor but never reach panes.
  let themeId, overrides;
  if (style) {
    const resolved = resolveStyleForAppearance(style, settings.appearance);
    themeId = resolved.themeId;
    overrides = resolved.colors || {};
  } else {
    themeId = appearance === "dark" ? settings.darkTheme : settings.lightTheme;
    overrides = (appearance === "dark"
      ? settings.defaultDarkColors
      : settings.defaultLightColors) || {};
  }
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
  if (overrides.links) root.style.setProperty("--link", overrides.links);
  else root.style.removeProperty("--link");
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
