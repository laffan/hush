/**
 * Centralized keyboard shortcut system.
 *
 * All keyboard bindings in the app come from `state.settings` — the settings
 * panel is the single source of truth.  This module provides:
 *
 * - `parseShortcut(str)` — parse a stored shortcut string into a normalized
 *   `{ mod, shift, alt, key }` object.  Accepts Electron/Tauri-style tokens
 *   like `CmdOrCtrl`, `Mod`, `Shift`, `Alt`, `Option`.
 * - `toCodeMirrorKey(str)` — convert a stored shortcut to CodeMirror's
 *   hyphen-delimited key format (e.g. `Mod-Shift-f`).
 * - `matchesDomEvent(event, str)` — test whether a DOM `KeyboardEvent`
 *   matches a stored shortcut, for use in window-level keydown listeners.
 * - `buildCodeMirrorKeymap(state, commands)` — build an array of CodeMirror
 *   `{ key, run }` bindings from the settings + a commands map.
 *
 * The commands map is `{ shortcutKey: fn(state, view) }`.  The same map is
 * used by the CodeMirror keymap and by the window-level fallback dispatcher,
 * so every shortcut has exactly one definition.
 */

/** Parse a stored shortcut like `"CmdOrCtrl+Shift+F"` into a normalized struct. */
export function parseShortcut(str) {
  if (!str || typeof str !== "string") return null;
  const parts = str.split("+").map((p) => p.trim()).filter(Boolean);
  const out = { mod: false, shift: false, alt: false, key: "" };
  for (const p of parts) {
    if (p === "CmdOrCtrl" || p === "Mod" || p === "Cmd" || p === "Ctrl" || p === "Meta") {
      out.mod = true;
    } else if (p === "Shift") {
      out.shift = true;
    } else if (p === "Alt" || p === "Option") {
      out.alt = true;
    } else {
      out.key = p;
    }
  }
  if (!out.key) return null;
  return out;
}

/** Convert a stored shortcut to CodeMirror's `Mod-Shift-f` key format. */
export function toCodeMirrorKey(str) {
  const p = parseShortcut(str);
  if (!p) return null;
  const segs = [];
  // CodeMirror's key matcher is order-tolerant, but putting modifiers in a
  // canonical order keeps things readable.
  if (p.alt) segs.push("Alt");
  if (p.mod) segs.push("Mod");
  if (p.shift) segs.push("Shift");
  // Single-character keys must be lowercase for CM's matcher
  const k = p.key.length === 1 ? p.key.toLowerCase() : p.key;
  segs.push(k);
  return segs.join("-");
}

/** Test whether a DOM KeyboardEvent matches a stored shortcut string. */
export function matchesDomEvent(event, str) {
  const p = parseShortcut(str);
  if (!p) return false;
  const mod = event.metaKey || event.ctrlKey;
  if (!!p.mod !== !!mod) return false;
  if (!!p.shift !== !!event.shiftKey) return false;
  if (!!p.alt !== !!event.altKey) return false;
  // Normalize key names.  `event.key` is uppercase when Shift is held for
  // letters (`"F"` vs `"f"`), and special keys use CamelCase names which
  // already match our stored format (`"ArrowRight"`, `"Backspace"`, etc.).
  const evKey = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const shKey = p.key.length === 1 ? p.key.toLowerCase() : p.key;
  return evKey === shKey;
}

/**
 * Build a CodeMirror-compatible keymap array from the current settings.
 *
 * @param {object} state   The shared AppState (reads `state.settings`).
 * @param {Record<string, (state, view) => boolean | void>} commands
 *   A map from setting key (e.g. `shortcutBold`) to a handler.  Handlers
 *   should return `true` if they handled the key (to stop further keymap
 *   propagation); returning a falsy value lets CodeMirror fall through.
 * @returns {Array<{key: string, run: (view) => boolean}>}
 */
export function buildCodeMirrorKeymap(state, commands) {
  const bindings = [];
  for (const [settingKey, handler] of Object.entries(commands)) {
    const shortcut = state.settings[settingKey];
    const cmKey = toCodeMirrorKey(shortcut);
    if (!cmKey) continue;
    bindings.push({
      key: cmKey,
      run: (view) => {
        const result = handler(state, view);
        // `undefined` from a handler still means "handled" — most editor
        // commands return void but have side effects, and we want to stop
        // the browser's default action regardless.
        return result !== false;
      },
    });
  }
  return bindings;
}

/**
 * Dispatch a DOM keydown event through the commands map, using the stored
 * shortcuts.  Returns `true` if a handler fired (and the caller should
 * `preventDefault`), `false` otherwise.
 *
 * This is the fallback dispatcher used by `main.js`'s window keydown
 * listener — it fires when the editor isn't focused (e.g. a sidebar input
 * has focus) so window-level actions like fullscreen still work.
 */
export function dispatchDomShortcut(event, state, commands, view) {
  for (const [settingKey, handler] of Object.entries(commands)) {
    const shortcut = state.settings[settingKey];
    if (!shortcut) continue;
    if (!matchesDomEvent(event, shortcut)) continue;
    const result = handler(state, view || null);
    return result !== false;
  }
  return false;
}
