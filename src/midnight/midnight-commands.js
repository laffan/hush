/**
 * Midnight mode's command palette entries: the toggle in the Styles
 * section, and — while it is on — "Deactivate Midnight mode" pinned as
 * the palette's first row. It changes every colour on screen, so the way
 * out is the first thing the palette offers rather than something to be
 * searched for.
 */
import { isMidnightActive } from "./midnight-mode.js";
import { toggleMidnightMode, setMidnightMode } from "./midnight-controller.js";

/** A crescent moon with a small star beside it — the dark-appearance
 *  moon, made into night. */
export const MIDNIGHT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5066C3 16.7497 7.25034 21 12.4934 21C16.2209 21 19.4466 18.8518 21 15.7259C12.4934 15.7259 8.27411 11.5066 8.27411 3C5.14821 4.55344 3 7.77915 3 11.5066Z"/><path d="M17.5 3v4M15.5 5h4"/></svg>`;

/** The Styles-section toggle, ✓ while on (the appearance rows' idiom). */
export function buildMidnightCommands(state) {
  const on = isMidnightActive(state.settings);
  return [{
    id: "midnight-mode", section: "Styles", label: `Midnight mode${on ? " ✓" : ""}`,
    keywords: "dark black night grey gray dim", icon: MIDNIGHT_ICON, shortcutKey: null, ctx: "shared",
    action: (s) => { void toggleMidnightMode(s); },
  }];
}

/** The rows pinned above everything else in the palette. They carry no
 *  section, which `groupBySection` puts first and draws without a header,
 *  and they stay out of the Recent list (`pinned`). Empty unless midnight
 *  mode is on. */
export function buildPinnedCommands(state) {
  if (!isMidnightActive(state.settings)) return [];
  return [{
    id: "midnight-deactivate", section: null, pinned: true, label: "Deactivate Midnight mode",
    keywords: "midnight turn off end dark night", icon: MIDNIGHT_ICON, shortcutKey: null, ctx: "shared",
    action: (s) => { void setMidnightMode(s, false); },
  }];
}
