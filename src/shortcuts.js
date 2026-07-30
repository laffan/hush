/**
 * Centralized keyboard shortcut system.
 *
 * All keyboard bindings in the app come from `state.settings` — the settings
 * panel is the single source of truth.  This module provides:
 *
 * - `parseShortcut(str)` — parse a stored shortcut string into a normalized
 *   `{ mod, meta, ctrl, shift, alt, key }` object.  Accepts Electron/Tauri-
 *   style tokens like `CmdOrCtrl`, `Mod`, `Shift`, `Alt`, `Option`, plus
 *   the strict `Cmd` (meta only) and `Ctrl` (control only) forms so the
 *   two primary modifiers can carry different bindings.
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

/** Parse a stored shortcut like `"CmdOrCtrl+Shift+F"` into a normalized
 *  struct. Three modifier flavours are distinguished:
 *  - `CmdOrCtrl` / `Mod` → `mod`: either primary modifier (⌘ or ⌃).
 *  - `Cmd` / `Meta`      → `meta`: strictly the command (meta) key.
 *  - `Ctrl`              → `ctrl`: strictly the control key.
 *  The strict forms let e.g. `Cmd+N` and `Ctrl+N` bind different
 *  commands on the same keyboard. */
export function parseShortcut(str) {
  if (!str || typeof str !== "string") return null;
  const parts = str.split("+").map((p) => p.trim()).filter(Boolean);
  const out = { mod: false, meta: false, ctrl: false, shift: false, alt: false, key: "" };
  for (const p of parts) {
    if (p === "CmdOrCtrl" || p === "Mod") {
      out.mod = true;
    } else if (p === "Cmd" || p === "Meta") {
      out.meta = true;
    } else if (p === "Ctrl") {
      out.ctrl = true;
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
  // CM keeps the same strict/either distinction: `Cmd-` is the meta key,
  // `Ctrl-` the control key, `Mod-` the platform primary.
  if (p.meta) segs.push("Cmd");
  if (p.ctrl) segs.push("Ctrl");
  if (p.shift) segs.push("Shift");
  // Single-character keys must be lowercase for CM's matcher
  const k = p.key.length === 1 ? p.key.toLowerCase() : p.key;
  segs.push(k);
  return segs.join("-");
}

/** Physical-code → produced-character fallback for punctuation keys that
 *  can register as dead keys (e.g. grave/backtick for combining accents),
 *  where `event.key` comes through as `"Dead"` and never matches. */
const CODE_TO_KEY = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

/** Test whether a DOM KeyboardEvent matches a stored shortcut string. */
export function matchesDomEvent(event, str) {
  const p = parseShortcut(str);
  if (!p) return false;
  if (p.mod) {
    // Either-primary form: ⌘ or ⌃ both satisfy it (legacy behaviour).
    if (!(event.metaKey || event.ctrlKey)) return false;
  } else {
    // Strict forms — `Cmd+N` must not fire on Ctrl+N and vice versa, and
    // an unmodified binding must not fire while either key is held.
    if (!!p.meta !== !!event.metaKey) return false;
    if (!!p.ctrl !== !!event.ctrlKey) return false;
  }
  if (!!p.shift !== !!event.shiftKey) return false;
  if (!!p.alt !== !!event.altKey) return false;
  // Normalize key names.  `event.key` is uppercase when Shift is held for
  // letters (`"F"` vs `"f"`), and special keys use CamelCase names which
  // already match our stored format (`"ArrowRight"`, `"Backspace"`, etc.).
  const evKey = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const shKey = p.key.length === 1 ? p.key.toLowerCase() : p.key;
  if (evKey === shKey) return true;
  // Dead-key fallback: match the physical code (Cmd+` on layouts where the
  // grave key produces a combining accent reports `event.key === "Dead"`).
  const codeKey = CODE_TO_KEY[event.code];
  return !!codeKey && codeKey === shKey;
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
