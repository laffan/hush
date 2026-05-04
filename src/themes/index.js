/**
 * Theme registry — local replacements for the previous thememirror imports.
 * Each theme lives in a sibling file built via `./_create-theme.js`.
 */
import { amy } from "./amy.js";
import { ayuLight } from "./ayu-light.js";
import { barf } from "./barf.js";
import { bespin } from "./bespin.js";
import { birdsOfParadise } from "./birds-of-paradise.js";
import { boysAndGirls } from "./boys-and-girls.js";
import { clouds } from "./clouds.js";
import { cobalt } from "./cobalt.js";
import { coolGlow } from "./cool-glow.js";
import { dracula } from "./dracula.js";
import { espresso } from "./espresso.js";
import { noctisLilac } from "./noctis-lilac.js";
import { rosePineDawn } from "./rose-pine-dawn.js";
import { smoothy } from "./smoothy.js";
import { solarizedLight } from "./solarized-light.js";
import { tomorrow } from "./tomorrow.js";

// Imported from the VSCode-Ultimate-Themes-Pack
import { akariNight } from "./akari-night.js";
import { auroraBorealis } from "./aurora-borealis.js";
import { aurumDusk } from "./aurum-dusk.js";
import { calmDark } from "./calm-dark.js";
import { darkGreenJungle } from "./dark-green-jungle.js";
import { eyeComfortDarkPro } from "./eye-comfort-dark-pro.js";
import { ghibliForestDark } from "./ghibli-forest-dark.js";
import { mapleLight } from "./maple-light.js";
import { midnightFrost } from "./midnight-frost.js";
import { midnightGlow } from "./midnight-glow.js";
import { nuttyLight } from "./nutty-light.js";
import { pokemonColor } from "./pokemon-color.js";
import { softContrast } from "./soft-contrast.js";
import { solsticeEstival } from "./solstice-estival.js";

export const themeList = [
  // Light themes — headingColor matches each theme's accent/keyword tones
  { id: "ayuLight", name: "Ayu Light", type: "light", extension: ayuLight, headingColor: "#ff9940" },
  { id: "clouds", name: "Clouds", type: "light", extension: clouds, headingColor: "#af582a" },
  { id: "noctisLilac", name: "Noctis Lilac", type: "light", extension: noctisLilac, headingColor: "#8c4aff" },
  { id: "rosePineDawn", name: "Rosé Pine Dawn", type: "light", extension: rosePineDawn, headingColor: "#907aa9" },
  { id: "solarizedLight", name: "Solarized Light", type: "light", extension: solarizedLight, headingColor: "#268bd2" },
  { id: "smoothy", name: "Smoothy", type: "light", extension: smoothy, headingColor: "#5a67d8" },
  { id: "auroraBorealis", name: "Aurora Borealis", type: "light", extension: auroraBorealis, headingColor: "#5e81ac" },
  { id: "mapleLight", name: "Maple Light", type: "light", extension: mapleLight, headingColor: "#726293" },
  { id: "nuttyLight", name: "Nutty Light", type: "light", extension: nuttyLight, headingColor: "#7A3F7D" },
  { id: "softContrast", name: "Soft Contrast", type: "light", extension: softContrast, headingColor: "#1F6AA5" },
  { id: "solsticeEstival", name: "Solstice Estival", type: "light", extension: solsticeEstival, headingColor: "#68685F" },

  // Dark themes
  { id: "amy", name: "Amy", type: "dark", extension: amy, headingColor: "#ff6600" },
  { id: "barf", name: "Barf", type: "dark", extension: barf, headingColor: "#5ccfe6" },
  { id: "bespin", name: "Bespin", type: "dark", extension: bespin, headingColor: "#cf7d34" },
  { id: "birdsOfParadise", name: "Birds of Paradise", type: "dark", extension: birdsOfParadise, headingColor: "#ef5d32" },
  { id: "boysAndGirls", name: "Boys and Girls", type: "dark", extension: boysAndGirls, headingColor: "#ff69b4" },
  { id: "cobalt", name: "Cobalt", type: "dark", extension: cobalt, headingColor: "#ffc600" },
  { id: "coolGlow", name: "Cool Glow", type: "dark", extension: coolGlow, headingColor: "#7cb7ff" },
  { id: "dracula", name: "Dracula", type: "dark", extension: dracula, headingColor: "#bd93f9" },
  { id: "espresso", name: "Espresso", type: "dark", extension: espresso, headingColor: "#c5956b" },
  { id: "tomorrow", name: "Tomorrow", type: "dark", extension: tomorrow, headingColor: "#7aa6da" },
  { id: "akariNight", name: "Akari Night", type: "dark", extension: akariNight, headingColor: "#E26A3B" },
  { id: "aurumDusk", name: "Aurum Dusk", type: "dark", extension: aurumDusk, headingColor: "#c99d5a" },
  { id: "calmDark", name: "Calm Dark", type: "dark", extension: calmDark, headingColor: "#dedbd3" },
  { id: "darkGreenJungle", name: "Dark Green Jungle", type: "dark", extension: darkGreenJungle, headingColor: "#a2d99a" },
  { id: "eyeComfortDarkPro", name: "Eye Comfort Dark Pro", type: "dark", extension: eyeComfortDarkPro, headingColor: "#569cd6" },
  { id: "ghibliForestDark", name: "Ghibli Forest (Dark)", type: "dark", extension: ghibliForestDark, headingColor: "#B88FB8" },
  { id: "midnightFrost", name: "Midnight Frost", type: "dark", extension: midnightFrost, headingColor: "#00bff9" },
  { id: "midnightGlow", name: "Midnight Glow", type: "dark", extension: midnightGlow, headingColor: "#97EE91" },
  { id: "pokemonColor", name: "Pokemon Color", type: "dark", extension: pokemonColor, headingColor: "#FBA54C" },
];

export function getThemeById(id) {
  return themeList.find((t) => t.id === id);
}

export function getActiveTheme(settings) {
  // If a style is active and has a theme, use the appropriate one for current appearance
  if (settings.activeStyleId && settings.styles) {
    const style = settings.styles.find(s => s.id === settings.activeStyleId);
    if (style) {
      // New dual-mode style format
      if (style.lightThemeId || style.darkThemeId) {
        let appearance = settings.appearance || "dark";
        if (appearance === "auto") {
          appearance = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        }
        const themeId = appearance === "dark" ? style.darkThemeId : style.lightThemeId;
        if (themeId) return getThemeById(themeId);
      }
      // Legacy single-mode format
      if (style.themeId) {
        return getThemeById(style.themeId);
      }
    }
  }

  let appearance = settings.appearance || "dark";
  if (appearance === "auto") {
    appearance = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  const themeId = appearance === "dark" ? settings.darkTheme : settings.lightTheme;
  return getThemeById(themeId);
}
