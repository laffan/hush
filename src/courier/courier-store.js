/**
 * Courier's per-device memory, kept in `settings.courier` (opaque to
 * Rust — see `courier` on `AppSettings`):
 *
 *   { type, locations: { [type]: locationKey }, shortcutNames: [] }
 *
 * `type` and `locations` reopen the sheet where the last message went,
 * so a second note to the same place is three taps, a sentence and
 * ⌘↩. `shortcutNames` holds Shortcut names typed by hand — the only
 * list there is on iPad, where nothing can enumerate the user's
 * Shortcuts (courier.rs).
 */

const MAX_SHORTCUT_NAMES = 20;

function read(state) {
  const c = state.settings?.courier;
  return c && typeof c === "object" ? c : {};
}

function write(state, patch) {
  const next = { ...read(state), ...patch };
  state.settings.courier = next;
  // Key-scoped patch (see README-TECHNICAL: every settings write is).
  void state.updateSettings({ courier: next });
}

export function lastType(state) {
  return read(state).type || null;
}

export function lastLocation(state, type) {
  return read(state).locations?.[type] || null;
}

export function rememberSend(state, type, locationKey) {
  const locations = { ...(read(state).locations || {}), [type]: locationKey };
  write(state, { type, locations });
}

export function shortcutNames(state) {
  const list = read(state).shortcutNames;
  return Array.isArray(list) ? list.filter((n) => typeof n === "string" && n.trim()) : [];
}

export function rememberShortcutName(state, name) {
  const clean = (name || "").trim();
  if (!clean) return;
  const rest = shortcutNames(state).filter((n) => n !== clean);
  write(state, { shortcutNames: [clean, ...rest].slice(0, MAX_SHORTCUT_NAMES) });
}
