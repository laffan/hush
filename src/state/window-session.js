/** A secondary WKWebView can be reclaimed and reloaded with its original URL.
 * Keep its latest selection in sessionStorage (isolated to this webview),
 * rather than restoring the original hash or another window's disk settings.
 * This survives page reloads, not destruction of the native scene.
 */
import { preserveWindowSettings, sessionSettings } from "./session-state.js";

const KEY = "hush.window-session.v1";

export function readWindowSession(label, storage) {
  try {
    const saved = JSON.parse((storage || sessionStorage).getItem(KEY));
    return saved?.label === label && saved.settings ? preserveWindowSettings(saved.settings) : null;
  } catch (_) { return null; }
}

export function installWindowSession(state, label, storage) {
  if (!state.isSecondaryWindow) return;
  const save = () => {
    try {
      (storage || sessionStorage).setItem(KEY, JSON.stringify({ label, settings: {
        ...preserveWindowSettings(state.settings), ...sessionSettings(state),
      } }));
    } catch (_) { /* Storage may be unavailable; disk remains main's session. */ }
  };
  for (const event of ["file-opened", "notebook-open", "pdf-open", "stack-open", "no-file-state"]) state.on(event, save);
  // Do not store the seeded pointers until their first mount succeeds.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") save();
  });
}
