/**
 * Mode toggles (ratchet, private, typewriter, dry, focus, zen, fullscreen)
 * — extracted from state.js. Each fn takes the AppState instance.
 */

import { getDeskRatchet, setDeskRatchet } from "./state-desks.js";

/** Toggle the active desk's persistent Ratchet mode — every Doc in the
 *  desk goes forward-only until this is turned back off, across
 *  sessions. Unlike `startRatchet` there's no clock: the setting lives
 *  in `desksMeta` beside the desk's style. Notebooks are untouched.
 *  `desks-changed` refreshes the desk name's ratchet glyph in the
 *  switcher; `mode-changed` re-anchors the editor. */
export async function toggleDeskRatchet(state) {
  const next = !getDeskRatchet(state);
  await setDeskRatchet(state, next);
  state.emit("mode-changed");
  state.emit("desks-changed");
  return next;
}

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

/** Toggle the Shuffle Editor. Entry carries a `payload` captured from the
 *  active editor selection (`{ sourceView, from, to, text, columnWidth }`),
 *  staged on `state._shuffleEditorPayload`; exit clears it. The view-side
 *  handler (shuffle-editor.js) listens for `shuffle-editor-changed`. */
export function toggleShuffleEditor(state, payload) {
  if (state.shuffleEditor) {
    state.shuffleEditor = false;
    state._shuffleEditorPayload = null;
  } else {
    if (!payload || !payload.text) return; // nothing to shuffle
    state.shuffleEditor = true;
    state._shuffleEditorPayload = payload;
  }
  state.emit("mode-changed");
  state.emit("shuffle-editor-changed");
}

export function toggleFullscreen(state) {
  state.isFullscreen = !state.isFullscreen;
  state.emit("fullscreen-changed");
}
