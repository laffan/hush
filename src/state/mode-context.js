/**
 * Per-editor mode context.
 *
 * Each editing surface (floating pane, stack column) gets its own mode
 * context so toggling focus / typewriter / DRY applies only to the
 * active editor, not every editor on screen. A fresh context starts
 * from the global flags, so a surface opened while a mode is on joins
 * it; from there the two diverge on the next toggle.
 *
 * The context is a prototype-inherited proxy of AppState: plugins that
 * read `stateRef.focusMode` see the local value (own-property), while
 * `stateRef.settings`, `stateRef.emit`, etc. delegate to the real
 * AppState through the prototype chain.
 */

import { getActivePaneId } from "../pane/pane-manager.js";
import { panes } from "../pane/pane-state.js";
import { getStackInstance } from "../stack/stack-bridge.js";

const MODE_KEYS = ["focusMode", "typewriterMode", "dryMode"];

export function createModeContext(appState) {
  const proxy = Object.create(appState);
  // Seed from the global flags rather than from off. These modes are
  // per-surface once a surface exists, but "Typewriter mode is on" is a
  // statement about how the user is writing, not about one editor: a
  // pane opened while it's on belongs in it too. Without this a pane
  // opened after the toggle was silently exempt — and the global
  // boundary line hides itself whenever a pane is active, so the mode
  // read as simply not working in panes.
  for (const k of MODE_KEYS) proxy[k] = !!appState[k];

  function toggle(modeName, view, container) {
    if (!MODE_KEYS.includes(modeName)) return;
    proxy[modeName] = !proxy[modeName];

    if (modeName === "typewriterMode" && view && container) {
      import("../pane/pane-editor.js").then(({ applyPaneTypewriterFromContext }) => {
        applyPaneTypewriterFromContext(view, proxy, container);
      });
    }

    if (view) {
      try { view.dispatch({ effects: [] }); } catch (_) {}
    }
  }

  return { proxy, toggle };
}

/**
 * Toggle one mode on whichever editing surface is active: the focused
 * pane / stack column via its own context, or — when the main editor is
 * the active surface — the global AppState flag.
 *
 * Every entry point for these modes routes through here (the keyboard
 * shortcuts and the command palette alike) so a mode never lands on the
 * main editor behind a pane the user was typing in.
 */
export function toggleModeOnContext(state, modeName) {
  const ctx = getActiveModeContext(state);
  if (ctx) {
    ctx.mc.toggle(modeName, ctx.view, ctx.container);
    return true;
  }
  if (modeName === "focusMode") state.toggleFocus();
  else if (modeName === "typewriterMode") state.toggleTypewriter();
  else if (modeName === "dryMode") state.toggleDry();
  return true;
}

/**
 * True when some surface holding a *document* is the one the user is
 * working in — the main editor when it isn't showing a notebook, or a
 * focused doc pane / stack column when it is.
 *
 * Doc-only editor features (spellcheck) key off this rather than off
 * `currentNotebookFileId` alone. A doc open in a pane over a notebook
 * is still a doc being written in, and testing only the main surface
 * hid the command and made its toggle a no-op.
 */
export function hasActiveDocSurface(appState) {
  if (!appState.currentNotebookFileId) return true;
  const ctx = getActiveModeContext(appState);
  return !!ctx?.view;
}

/**
 * Find the active per-editor mode context. Returns
 * `{ mc, view, container }` for a pane / stack column, or `null` when
 * the main editor is focused (caller falls through to global state).
 */
export function getActiveModeContext(appState) {
  if (appState.currentStackFileId) {
    const inst = getStackInstance();
    if (inst) {
      const item = inst.getActiveItem();
      if (item) {
        const ld = inst._liveColumns.get(item.id);
        if (ld?.modeContext) {
          return { mc: ld.modeContext, view: ld.editor?.view, container: ld.container };
        }
      }
    }
  }
  const paneId = getActivePaneId();
  if (paneId) {
    const pane = panes.get(paneId);
    if (pane?.modeContext) {
      return { mc: pane.modeContext, view: pane.editor?.view, container: pane._content };
    }
  }
  return null;
}
