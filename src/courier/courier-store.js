/**
 * Courier's per-device memory, kept in `settings.courier` (opaque to
 * Rust — see `courier` on `AppSettings`):
 *
 *   { mode, scope, locations: { [slot]: locationKey }, card: { bgColor } }
 *
 * A slot is the mode, or `sticky:<scope>` for a sticky, so each list
 * remembers its own last pick — a card's desk included. `card` holds the
 * options the last card was sent with (its colour), which the next card
 * starts from. The sheet reopens where the last message went, made the
 * way the last one was: a second note to the same place is three taps,
 * a sentence and ⌘↩.
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

/** The options the last card went out with: `{ bgColor? }`. */
export function lastCardMeta(state) {
  const c = read(state).card;
  return c && typeof c === "object" && c.bgColor ? { bgColor: c.bgColor } : {};
}

export function rememberSend(state, mode, scope, locationKey, cardMeta) {
  const prev = read(state);
  const locations = { ...(prev.locations || {}) };
  if (locationKey) locations[slotFor(mode, scope)] = locationKey;
  // Only a card send says anything about a card's options; any other
  // send leaves the last card's as they were.
  const card = mode === "card" ? (cardMeta?.bgColor ? { bgColor: cardMeta.bgColor } : {}) : (prev.card || {});
  const next = { mode, scope: scope || prev.scope || null, locations, card };
  state.settings.courier = next;
  // Key-scoped patch (README-TECHNICAL: every settings write is).
  void state.updateSettings({ courier: next });
}
