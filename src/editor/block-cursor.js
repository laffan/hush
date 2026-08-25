import { getActiveTheme } from "../themes/index.js";
import { resolveStyleForAppearance } from "../sidebar/styles-panel.js";

/** Resolve the cursor mode (system / block / underline). New `cursorMode`
 *  field wins; fall back to the legacy `blockCursor` boolean. Style
 *  override beats global setting. */
function resolveCursorMode(settings, style) {
  if (style) {
    if (style.cursorMode) return style.cursorMode;
    if (style.blockCursor != null) return style.blockCursor ? "block" : "system";
  }
  if (settings.cursorMode) return settings.cursorMode;
  return settings.blockCursor ? "block" : "system";
}

/** Resolve everything a surface needs to paint the cursor: the mode, the
 *  cursor colour, and the line-indicator colour.
 *
 *  `settings` is normally `AppState.settings`, but panes and stack
 *  columns pass a locked-style-resolved copy (the same object their
 *  `reconfigureTheme` builds) so a document with a locked style paints
 *  that style's cursor rather than the session's — which is why this
 *  reads a settings object and not the app state.
 *
 *  A style's explicit cursor-colour override wins (so the override keeps
 *  working in block / underline mode); otherwise the cursor falls back
 *  to the active theme's heading colour for visibility. The line
 *  indicator resolves style override → cursor colour → the same
 *  fallback, so its CSS variants paint on-brand. A null means "no
 *  variable" — the CSS falls through to `var(--cursor)`. */
export function resolveCursorPaint(settings) {
  let style = null;
  let cursorOverride = null;
  let lineIndicatorOverride = null;
  if (settings.activeStyleId && settings.styles) {
    style = settings.styles.find(s => s.id === settings.activeStyleId) || null;
    if (style) {
      const { colors } = resolveStyleForAppearance(style, settings.appearance);
      const overrides = colors || style.colorOverrides || {};
      cursorOverride = overrides.cursor || null;
      lineIndicatorOverride = overrides.lineIndicator || null;
    }
  } else {
    let appearance = settings.appearance || "dark";
    if (appearance === "auto") {
      appearance = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    const def = appearance === "dark"
      ? (settings.defaultDarkColors || {})
      : (settings.defaultLightColors || {});
    cursorOverride = def.cursor || null;
    lineIndicatorOverride = def.lineIndicator || null;
  }
  const theme = getActiveTheme(settings);
  const fallbackCursor = (theme && theme.headingColor) || null;
  return {
    mode: resolveCursorMode(settings, style),
    cursorColor: cursorOverride || fallbackCursor,
    lineIndicatorColor: lineIndicatorOverride || cursorOverride || fallbackCursor,
  };
}

/** Paint a resolved cursor mode onto one editor-surface root. The root
 *  carries `cursor-mode-surface` so the CSS can target any host that
 *  goes through this painter — the main editor, the overlays, and every
 *  pane / stack column — without the stylesheet learning their class
 *  names one by one. */
export function paintCursorMode(el, paint) {
  if (!el) return;
  el.classList.add("cursor-mode-surface");
  el.classList.toggle("block-cursor", paint.mode === "block");
  el.classList.toggle("underline-cursor", paint.mode === "underline");
  if (paint.cursorColor) el.style.setProperty("--block-cursor-color", paint.cursorColor);
  else el.style.removeProperty("--block-cursor-color");
  if (paint.lineIndicatorColor) el.style.setProperty("--line-indicator-color", paint.lineIndicatorColor);
  else el.style.removeProperty("--line-indicator-color");
}

/** Apply the cursor mode to every window-level editor surface: the main
 *  editor container plus any Zen Focus / Selection Focus overlay
 *  currently mounted. Those overlays each mount their own CodeMirror
 *  outside `#editor-container`, so they need the classes painted on
 *  their own root for the CSS to bite.
 *
 *  Panes and stack columns are *not* reachable from here — they come and
 *  go with their own lifecycle and can each be showing a different
 *  (locked) style. They bind through `bindCursorModeToContainer`. */
export function applyBlockCursor(state) {
  const targets = [];
  const main = document.getElementById("editor-container");
  if (main) targets.push(main);
  const zen = document.querySelector(".zen-focus-overlay");
  if (zen) targets.push(zen);
  const sel = document.querySelector(".selection-focus-overlay");
  if (sel) targets.push(sel);
  if (!targets.length) return;
  const paint = resolveCursorPaint(state.settings);
  for (const el of targets) paintCursorMode(el, paint);
}

/** Wire a pane / stack-column container to the cursor mode, the way
 *  `bindLineIndicatorToContainer` wires the line-indicator class.
 *
 *  `getSettings` returns the settings this surface is currently themed
 *  from — the host updates it as its locked style resolves, so a style
 *  change repaints against the right style rather than the session's.
 *  Returns an unbind function; hosts call it from `destroy`. */
export function bindCursorModeToContainer(container, state, getSettings) {
  if (!container) return () => {};
  const repaint = () => paintCursorMode(container, resolveCursorPaint(getSettings()));
  repaint();
  state.on("style-changed", repaint);
  state.on("settings-changed", repaint);
  return () => {
    state.off("style-changed", repaint);
    state.off("settings-changed", repaint);
  };
}
