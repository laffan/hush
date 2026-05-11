/**
 * Per-context "hide panes" toggle.
 *
 * `settings.panesHiddenByContext` is a `{ [contextId]: true }` map.
 * Context ids match `pane.ownerContext` (`doc:<id>`, `nb:<id>`,
 * `pj:<id>`). Toggling flips the entry and re-runs the visibility
 * pass via `refreshPaneContextVisibility` so the DOM updates without
 * a context switch.
 *
 * Panes that are currently "owned by" or "pinned into" the active
 * context disappear when its flag is true; switching to another doc
 * shows panes normally again.
 */

function currentContextId(state) {
  if (state.currentNotebookFileId) return "nb:" + state.currentNotebookFileId;
  if (state.currentProjectId) return "pj:" + state.currentProjectId;
  if (state.currentFileId) return "doc:" + state.currentFileId;
  return "";
}

export function getActiveContextId(state) { return currentContextId(state); }

export function arePanesHiddenFor(state, contextId) {
  const map = state.settings?.panesHiddenByContext || {};
  return !!map[contextId];
}

export function arePanesHiddenForActive(state) {
  return arePanesHiddenFor(state, currentContextId(state));
}

async function _applyHiddenState(state) {
  // Lazy import to avoid circular pane-manager deps at module load.
  const { refreshPaneContextVisibility } = await import("../pane/pane-manager.js");
  refreshPaneContextVisibility();
  state.emit("panes-hidden-changed", currentContextId(state));
}

async function _setHiddenForContext(state, contextId, hidden) {
  if (!contextId) return;
  const current = { ...(state.settings?.panesHiddenByContext || {}) };
  const already = !!current[contextId];
  if (already === !!hidden) return;
  if (hidden) current[contextId] = true;
  else delete current[contextId];
  await state.updateSettings({ panesHiddenByContext: current });
  await _applyHiddenState(state);
}

export async function hidePanesForActive(state) {
  await _setHiddenForContext(state, currentContextId(state), true);
}

export async function showPanesForActive(state) {
  await _setHiddenForContext(state, currentContextId(state), false);
}

/** Force the hidden state for a specific context (used after switching
 *  panes to another doc so the target opens with panes visible). */
export async function setPanesHiddenForContext(state, contextId, hidden) {
  await _setHiddenForContext(state, contextId, hidden);
}
