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
  state.updateSettings({ proofreadMode: state.proofreadMode });
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

export function toggleFullscreen(state) {
  state.isFullscreen = !state.isFullscreen;
  state.emit("fullscreen-changed");
}
