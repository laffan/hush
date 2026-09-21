/**
 * The "Turn off <mode>" entries the command palette puts at the top when
 * a mode is running. Split out of `command-palette-commands.js` so that
 * file stays under the 700-line cap; re-exported from it so callers keep
 * importing one module.
 */
import { icons } from "./command-palette-commands.js";
import { hasActiveDocSurface } from "./state/mode-context.js";

export function buildActiveModeTurnoffs(state) {
  // Zen Focus is the only mode whose turn-off entry shows up in
  // notebook context too (you can be Zen-focusing a text shape).
  if (state.zenFocus) {
    const zen = [{
      id: "turnoff-zenFocus", section: "Active Modes", label: "Turn off Zen Focus", icon: icons.focus,
      shortcutKey: "shortcutZenFocus", action: (s) => s.toggleZenFocus(),
    }];
    if (state.currentNotebookFileId) return [...zen, ...notebookModeTurnoffs(state)];
    // In doc mode, prepend Zen alongside the doc-only turn-offs below.
    return [...zen, ...docModeTurnoffs(state)];
  }
  if (state.currentNotebookFileId) return notebookModeTurnoffs(state);
  return docModeTurnoffs(state);
}

/** The turn-offs that still apply with a notebook as the main surface.
 *  Spellcheck is the only one: it reaches a focused doc pane over the
 *  canvas, so a user who turned it on there needs a way back off. */
function notebookModeTurnoffs(state) {
  if (!state.spellcheckMode || !hasActiveDocSurface(state)) return [];
  return docModeTurnoffs(state).filter((m) => m.id === "turnoff-spellcheckMode");
}

function docModeTurnoffs(state) {
  const modes = [
    { flag: "ratchetMode", label: "Turn off Ratchet mode", icon: icons.ratchet, action: (s) => s.stopRatchet() },
    { flag: "privateMode", label: "Turn off Private mode", icon: icons.private, shortcutKey: "shortcutTogglePrivate", action: (s) => s.togglePrivate() },
    { flag: "typewriterMode", label: "Turn off Typewriter mode", icon: icons.typewriter, shortcutKey: "shortcutTypewriter", action: (s) => s.toggleTypewriter() },
    { flag: "dryMode", label: "Turn off Show repeats", icon: icons.dry, shortcutKey: "shortcutToggleDry", action: (s) => s.toggleDry() },
    { flag: "focusMode", label: "Turn off Focus mode", icon: icons.focus, shortcutKey: "shortcutToggleFocus", action: (s) => s.toggleFocus() },
    { flag: "proofreadMode", label: "Turn off Proofread mode", icon: icons.proofread, action: (s) => s.toggleProofread() },
    { flag: "spellcheckMode", label: "Turn off Spellcheck", icon: icons.proofread, action: (s) => s.toggleSpellcheck() },
  ];
  return modes
    .filter(m => state[m.flag])
    .map(m => ({ id: `turnoff-${m.flag}`, section: "Active Modes", label: m.label, icon: m.icon, shortcutKey: m.shortcutKey || null, action: m.action }));
}
