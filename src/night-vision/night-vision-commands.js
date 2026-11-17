/**
 * Night Vision's command palette entries. Like Midnight mode, it is
 * chosen from the palette and pinned while it runs:
 *
 *   - "Night Vision" (Styles), a toggle with a ✓ while on — over
 *     whatever appearance is in effect;
 *   - "Night Vision with Midnight mode" (Styles) — both at once, for
 *     black and dim red; hidden once both are on;
 *   - "Deactivate Night Vision", pinned first in Active Modes while it
 *     is on, beside Midnight's own row: it changes every colour on
 *     screen, so the way out is the first thing the palette offers.
 *
 * The rows' actions import the controller lazily, so the palette module
 * graph doesn't take on theme-colors.js.
 */
import { isNightVisionActive } from "./night-vision-mode.js";
import { isMidnightActive } from "../midnight/midnight-mode.js";

/** An eye with a small star beside it — seeing in the dark. */
export const NIGHT_VISION_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 14C4.8 10 8.1 8 12 8s7.2 2 9.5 6c-2.3 4-5.6 6-9.5 6s-7.2-2-9.5-6Z"/><circle cx="12" cy="14" r="2.75"/><path d="M18.5 2.5v4M16.5 4.5h4"/></svg>`;

const controller = () => import("./night-vision-controller.js");

/** The two rows in the Styles section, after the appearances. */
export function buildNightVisionCommands(state) {
  const on = isNightVisionActive(state.settings);
  return [
    {
      id: "night-vision", section: "Styles", label: `Night Vision${on ? " ✓" : ""}`,
      keywords: "red light night vision dark adaptation astronomy blue light filter eyes",
      icon: NIGHT_VISION_ICON, shortcutKey: null, ctx: "shared",
      action: async (s) => (await controller()).toggleNightVision(s),
    },
    {
      id: "night-vision-midnight", section: "Styles", label: "Night Vision with Midnight mode",
      keywords: "red light night vision dark adaptation astronomy blue light black midnight",
      icon: NIGHT_VISION_ICON, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => isNightVisionActive(s.settings) && isMidnightActive(s.settings),
      action: async (s) => (await controller()).setMidnightNightVision(s),
    },
  ];
}

/** Night Vision's row in the palette's pinned Active Modes group; kept
 *  out of the Recent list (`pinned`). Empty unless it is on. */
export function buildNightVisionPinned(state) {
  if (!isNightVisionActive(state.settings)) return [];
  return [{
    id: "night-vision-deactivate", section: "Active Modes", pinned: true, label: "Deactivate Night Vision",
    keywords: "night vision red turn off end", icon: NIGHT_VISION_ICON, shortcutKey: null, ctx: "shared",
    action: async (s) => (await controller()).setNightVision(s, false),
  }];
}
