/**
 * Midnight mode's pinned command palette entry. The mode itself is
 * chosen like any appearance — its row sits with Light / Dark / System
 * (`command-palette-helpers.js#buildAppearanceCommands`). While it is
 * on, "Deactivate Midnight mode" is pinned as the palette's first row:
 * it changes every colour on screen, so the way out is the first thing
 * the palette offers rather than something to be searched for.
 */
import { isMidnightActive } from "./midnight-mode.js";
import { setMidnightMode } from "./midnight-controller.js";
import { MIDNIGHT_ICON } from "./midnight-icon.js";

/** The rows pinned above everything else in the palette. They carry no
 *  section, which `groupBySection` puts first and draws without a header,
 *  and they stay out of the Recent list (`pinned`). Empty unless midnight
 *  mode is on. */
export function buildPinnedCommands(state) {
  if (!isMidnightActive(state.settings)) return [];
  return [{
    id: "midnight-deactivate", section: null, pinned: true, label: "Deactivate Midnight mode",
    keywords: "midnight turn off end dark night appearance", icon: MIDNIGHT_ICON, shortcutKey: null, ctx: "shared",
    action: (s) => { void setMidnightMode(s, false); },
  }];
}
