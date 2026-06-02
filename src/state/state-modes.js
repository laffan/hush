/**
 * Mode toggles (ratchet, private, typewriter, dry, focus, zen, fullscreen)
 * — extracted from state.js. Each fn takes the AppState instance.
 */

export function startRatchet(state, minutes) {
  const endTime = Date.now() + minutes * 60 * 1000;
  state.ratchetEndTime = endTime;
  state.ratchetMode = true;
  localStorage.setItem("hush_ratchet_end", endTime.toString());
  state.emit("mode-changed");
}

export function stopRatchet(state) {
  state.ratchetMode = false;
  state.ratchetEndTime = null;
  localStorage.removeItem("hush_ratchet_end");
  state.emit("mode-changed");
}

export function togglePrivate(state) {
  state.privateMode = !state.privateMode;
  state.emit("mode-changed");
}

export function toggleTypewriter(state) {
  if (state.ratchetMode) return;
  state.typewriterMode = !state.typewriterMode;
  state.emit("mode-changed");
  state.updateSettings({ typewriterMode: state.typewriterMode });
}

export function toggleDry(state) {
  state.dryMode = !state.dryMode;
  state.emit("mode-changed");
  state.updateSettings({ dryMode: state.dryMode });
}

export function toggleProofread(state) {
  if (state.currentNotebookFileId) return;
  state.proofreadMode = !state.proofreadMode;
  state.emit("mode-changed");
  // Deliberately not persisted — see the matching note in state.js.
  // Each session starts with proofread off so the cold-start dictionary
  // build doesn't gate startup.
}

export function toggleSpellcheck(state) {
  if (state.currentNotebookFileId) return;
  state.spellcheckMode = !state.spellcheckMode;
  state.emit("mode-changed");
  state.updateSettings({ spellcheckMode: state.spellcheckMode });
}

export function toggleFocus(state) {
  state.focusMode = !state.focusMode;
  state.emit("mode-changed");
}

export function toggleZenFocus(state) {
  state.zenFocus = !state.zenFocus;
  state.emit("mode-changed");
  state.emit("zen-focus-changed");
}

/** Toggle Selection Focus mode. Entry carries a `payload` object —
 *  `{ text, fontSize, fontFamily, color, background }` — captured by the
 *  caller from the active editor; exit ignores it. The view-side
 *  handler (selection-focus.js) listens for `selection-focus-changed`
 *  and mounts / tears down the overlay accordingly, reading the payload
 *  off the same staging slot the caller wrote (`state._selectionFocusPayload`). */
export function toggleSelectionFocus(state, payload) {
  if (state.selectionFocus) {
    state.selectionFocus = false;
    state._selectionFocusPayload = null;
  } else {
    if (!payload || !payload.text) return; // nothing to focus on
    state.selectionFocus = true;
    state._selectionFocusPayload = payload;
  }
  state.emit("mode-changed");
  state.emit("selection-focus-changed");
}

export function toggleFullscreen(state) {
  state.isFullscreen = !state.isFullscreen;
  state.emit("fullscreen-changed");
}
