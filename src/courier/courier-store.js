/**
 * Courier's per-device memory, kept in `settings.courier` (opaque to
 * Rust — see `courier` on `AppSettings`):
 *
 *   { mode, scope, locations: { [slot]: locationKey } }
 *
 * A slot is the mode, or `sticky:<scope>` for a sticky, so each list
 * remembers its own last pick. The sheet reopens where the last message
 * went: a second note to the same place is three taps, a sentence and ⌘↩.
 */

function read(state) {
  const c = state.settings?.courier;
  return c && typeof c === "object" ? c : {};
}

export function slotFor(mode, scope) {
  return mode === "sticky" ? `sticky:${scope}` : mode;
}

export function lastMode(state) { return read(state).mode || null; }
export function lastScope(state) { return read(state).scope || null; }

export function lastLocation(state, slot) {
  return read(state).locations?.[slot] || null;
}

export function rememberSend(state, mode, scope, locationKey) {
  const prev = read(state);
  const locations = { ...(prev.locations || {}) };
  if (locationKey) locations[slotFor(mode, scope)] = locationKey;
  const next = { mode, scope: scope || prev.scope || null, locations };
  state.settings.courier = next;
  // Key-scoped patch (README-TECHNICAL: every settings write is).
  void state.updateSettings({ courier: next });
}
