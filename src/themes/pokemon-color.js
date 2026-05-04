// Source: VSCode-Ultimate-Themes-Pack/elemental-spectrum-theme.json (PokemonColor)
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const pokemonColor = createTheme({
  variant: "dark",
  settings: {
    background: "#2B2B2B",
    foreground: "#eeffff",
    caret: "#eeffff",
    selection: "#595761",
    gutterBackground: "#2B2B2B",
    gutterForeground: "#eeffff",
    lineHighlight: "#313133",
  },
  styles: [
    { tag: t.comment, color: "#A0A29F" },
  ],
});
