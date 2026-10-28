/**
 * Palette entries for the "set the scene" features: Write Now (also
 * triple-tapped Option — write-now/), Edge Lights (edge-lights/) and
 * Campfire Cursor (campfire/, Docs only).
 * Split out of `command-palette-commands.js`, which is at the
 * line cap. Both are `shared`: neither depends on what is open.
 */
import { isEdgeLightsOn } from "./edge-lights/edge-lights-store.js";
import { isCampfireOn } from "./campfire/campfire-store.js";

// A pen nib over a spark — begin writing, now.
const writeNowIcon = `<svg viewBox="0 0 24 24"><path d="M4 20 L8.5 19 L19 8.5 L15.5 5 L5 15.5 Z M13.5 7 L17 10.5"/><path d="M19 15 V19 M17 17 H21"/></svg>`;
// A flame over two crossed logs.
const campfireIcon = `<svg viewBox="0 0 24 24"><path d="M12 3 C14.5 6.5 16 8.5 16 11.5 A4 4 0 0 1 8 11.5 C8 9.5 9.5 8.5 10 6.5 C11 8 11.5 8.5 12 3 Z"/><path d="M5 20 L19 16 M5 16 L19 20"/></svg>`;
// Three curtains of light over a horizon.
const lightsIcon = `<svg viewBox="0 0 24 24"><path d="M3 20 H21"/><path d="M5 16 C6 11 5 7 7 3 M11 16 C12 11 10.5 7 12.5 3 M17 16 C18 11 16.5 7 18.5 3"/></svg>`;

export function buildSessionCommands() {
  return [
    { id: "write-now", section: "Create", label: "Write Now", icon: writeNowIcon, shortcutKey: null, ctx: "shared",
      keywords: "new document idea start begin quick triple option",
      action: async (s) => (await import("./write-now/write-now.js")).writeNow(s) },
    { id: "edge-lights", section: "Styles", icon: lightsIcon, shortcutKey: null, ctx: "shared",
      label: "Edge Lights",
      keywords: "northern lights aurora borealis glow edges ambient background magic presets",
      action: async (s) => (await import("./edge-lights/edge-lights-modal.js")).openEdgeLightsModal(s) },
    { id: "edge-lights-off", section: "Active Modes", icon: lightsIcon, shortcutKey: null, ctx: "shared",
      label: "Turn off Edge Lights",
      keywords: "northern lights aurora borealis glow end stop",
      hiddenIf: (s) => !isEdgeLightsOn(s),
      action: async (s) => (await import("./edge-lights/edge-lights.js")).endEdgeLights(s) },
    { id: "campfire-toggle", section: "Styles", icon: campfireIcon, shortcutKey: null, ctx: "doc",
      label: "Toggle Campfire Cursor",
      keywords: "campfire cursor light glow dark fade focus illuminate flame caret",
      action: async (s) => (await import("./campfire/campfire.js")).toggleCampfire(s) },
    { id: "campfire-options", section: "Styles", icon: campfireIcon, shortcutKey: null, ctx: "doc",
      label: "Campfire Cursor Options",
      keywords: "campfire cursor light glow brightness range opacity blend line settings",
      action: async (s) => (await import("./campfire/campfire-modal.js")).openCampfireModal(s) },
    { id: "campfire-off", section: "Active Modes", icon: campfireIcon, shortcutKey: null, ctx: "shared",
      label: "Turn off Campfire Cursor",
      keywords: "campfire cursor light end stop",
      hiddenIf: (s) => !isCampfireOn(s),
      action: async (s) => (await import("./campfire/campfire.js")).endCampfire(s) },
  ];
}
