/**
 * Boot-time settings migrations.
 *
 * Each migration moves installs that are still carrying a retired
 * *default* onto its replacement, and leaves anything the user has
 * customised alone — the test is always "does this still hold the exact
 * old default?", never "is this different from the new one".
 *
 * A migration mutates the settings object in place and returns **only
 * the keys it rewrote**, so the caller persists those and nothing else.
 * Settings writes are key-scoped (`AppState.updateSettings`), so a value
 * that were only assigned into memory here would never reach disk — it
 * used to ride along on the next full-object save, which is exactly the
 * behaviour that made writes clobber each other.
 */

/** Shortcut defaults that were re-assigned after release: Reduce-sentence
 *  selection moved onto Cmd+Shift+L (paired with Cmd+L grow) and
 *  Select-paragraph took the freed Alt+Shift+L; then the new-document
 *  group was split across Cmd and Ctrl. Returns `{ key: value }` for
 *  whatever it changed; empty when there was nothing to do. */
export function migrateShortcutDefaults(settings) {
  const s = settings;
  const changed = {};
  if (s.shortcutReduceSentence === "Alt+Shift+L" && s.shortcutSelectParagraph === "Mod+Shift+L") {
    s.shortcutReduceSentence = "Mod+Shift+L";
    s.shortcutSelectParagraph = "Alt+Shift+L";
    changed.shortcutReduceSentence = s.shortcutReduceSentence;
    changed.shortcutSelectParagraph = s.shortcutSelectParagraph;
  }
  // New-document shortcut regrouping: Cmd creates Docs, Ctrl creates
  // Notebooks, Shift makes either an "as pane" create. Installs still
  // carrying the old defaults are moved onto the new ones; customised
  // bindings are left alone.
  if (s.shortcutNewFile === "Mod+N") {
    s.shortcutNewFile = "Cmd+N";
    changed.shortcutNewFile = s.shortcutNewFile;
  }
  if (s.shortcutNewNotebook === "Mod+Shift+N") {
    s.shortcutNewNotebook = "Ctrl+N";
    changed.shortcutNewNotebook = s.shortcutNewNotebook;
  }
  return changed;
}
