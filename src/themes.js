/**
 * Theme registry — wraps thememirror themes for CodeMirror
 */
import {
  amy,
  ayuLight,
  barf,
  bespin,
  birdsOfParadise,
  boysAndGirls,
  clouds,
  cobalt,
  coolGlow,
  dracula,
  espresso,
  noctisLilac,
  rosePineDawn,
  smoothy,
  solarizedLight,
  tomorrow,
} from "thememirror";

export const themeList = [
  // Light themes
  { id: "ayuLight", name: "Ayu Light", type: "light", extension: ayuLight },
  { id: "clouds", name: "Clouds", type: "light", extension: clouds },
  { id: "noctisLilac", name: "Noctis Lilac", type: "light", extension: noctisLilac },
  { id: "rosePineDawn", name: "Ros\u00e9 Pine Dawn", type: "light", extension: rosePineDawn },
  { id: "solarizedLight", name: "Solarized Light", type: "light", extension: solarizedLight },
  { id: "smoothy", name: "Smoothy", type: "light", extension: smoothy },

  // Dark themes
  { id: "amy", name: "Amy", type: "dark", extension: amy },
  { id: "barf", name: "Barf", type: "dark", extension: barf },
  { id: "bespin", name: "Bespin", type: "dark", extension: bespin },
  { id: "birdsOfParadise", name: "Birds of Paradise", type: "dark", extension: birdsOfParadise },
  { id: "boysAndGirls", name: "Boys and Girls", type: "dark", extension: boysAndGirls },
  { id: "cobalt", name: "Cobalt", type: "dark", extension: cobalt },
  { id: "coolGlow", name: "Cool Glow", type: "dark", extension: coolGlow },
  { id: "dracula", name: "Dracula", type: "dark", extension: dracula },
  { id: "espresso", name: "Espresso", type: "dark", extension: espresso },
  { id: "tomorrow", name: "Tomorrow", type: "dark", extension: tomorrow },
];

export function getThemeById(id) {
  return themeList.find((t) => t.id === id);
}

export function getActiveTheme(settings) {
  let appearance = settings.appearance || "dark";
  if (appearance === "auto") {
    appearance = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  const themeId = appearance === "dark" ? settings.darkTheme : settings.lightTheme;
  return getThemeById(themeId);
}
