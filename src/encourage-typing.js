/**
 * Encourage Typing — Ratchet Mode feature.
 * When enabled, text added during a ratchet session fades out if the user
 * stops pressing keys. If it fades fully (~10s), the new text is deleted.
 * Uses CodeMirror mark decorations to fade only the new text.
 */
import { Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

let encourageState = null;

export function initEncourageTyping(view, state, bypassRatchet) {
  clearEncourageTyping();
  if (!state.settings.ratchetEncourageTyping) return;
  encourageState = {
    baseLength: view.state.doc.length,
    fadeTimer: null,
    fadeStart: null,
    animFrame: null,
    opacity: 1,
    bypassRatchet,
    view,
  };
}

export function clearEncourageTyping() {
  if (!encourageState) return;
  if (encourageState.fadeTimer) clearTimeout(encourageState.fadeTimer);
  if (encourageState.animFrame) cancelAnimationFrame(encourageState.animFrame);
  // Remove any lingering fade decorations
  removeEncourageDecorations(encourageState.view);
  encourageState = null;
}

export function onEncourageKeystroke(view, state) {
  if (!encourageState || !state.settings.ratchetEncourageTyping) return;
  // Reset fade — restore full opacity
  encourageState.opacity = 1;
  encourageState.fadeStart = null;
  encourageState.view = view;
  if (encourageState.fadeTimer) clearTimeout(encourageState.fadeTimer);
  if (encourageState.animFrame) cancelAnimationFrame(encourageState.animFrame);
  removeEncourageDecorations(view);

  // Start fade after 2 seconds of no typing
  encourageState.fadeTimer = setTimeout(() => {
    startFade(view, state);
  }, 2000);
}

/** Build decorations that dim the new text range. */
function buildFadeDecorations(view, baseLen, opacity) {
  const docLen = view.state.doc.length;
  if (baseLen >= docLen || opacity >= 1) return Decoration.none;
  const builder = new RangeSetBuilder();
  builder.add(
    baseLen, docLen,
    Decoration.mark({ attributes: { style: `opacity: ${opacity.toFixed(2)}` } })
  );
  return builder.finish();
}

function applyEncourageDecorations(view, baseLen, opacity) {
  // Use a DOM approach: find the editor and apply a style range
  // We store our decoration state as a data attribute so we can update it
  const decos = buildFadeDecorations(view, baseLen, opacity);
  view._encourageDecos = decos;
  // Force a visual update
  view.dispatch({ effects: [] });
}

function removeEncourageDecorations(view) {
  if (!view) return;
  if (view._encourageDecos) {
    view._encourageDecos = null;
    view.dispatch({ effects: [] });
  }
}

function startFade(view, state) {
  if (!encourageState) return;
  const FADE_DURATION = 10000;
  encourageState.fadeStart = Date.now();

  function tick() {
    if (!encourageState || !encourageState.fadeStart) return;
    const elapsed = Date.now() - encourageState.fadeStart;
    const progress = Math.min(1, elapsed / FADE_DURATION);
    encourageState.opacity = 1 - progress;

    applyEncourageDecorations(view, encourageState.baseLength, encourageState.opacity);

    if (progress >= 1) {
      // Delete all text added since ratchet started
      const currentLen = view.state.doc.length;
      const baseLen = encourageState.baseLength;
      removeEncourageDecorations(view);
      if (currentLen > baseLen) {
        view.dispatch({
          changes: { from: baseLen, to: currentLen },
          annotations: encourageState.bypassRatchet.of(true),
        });
      }
      encourageState.fadeStart = null;
      encourageState.opacity = 1;
      return;
    }
    encourageState.animFrame = requestAnimationFrame(tick);
  }
  tick();
}

/**
 * Returns current encourage-typing decorations for the ViewPlugin.
 * Called from the editor's encourage decoration plugin.
 */
export function getEncourageDecorations(view) {
  return view._encourageDecos || Decoration.none;
}
