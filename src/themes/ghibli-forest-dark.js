// Source: VSCode-Ultimate-Themes-Pack/spiritwood-night-theme.json (Ghibli Forest (Dark))
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const ghibliForestDark = createTheme({
  variant: "dark",
  settings: {
    background: "#1E2A24",
    foreground: "#E8DFD0",
    caret: "#F4A460",
    selection: "#4A6B5A55",
    gutterBackground: "#1E2A24",
    gutterForeground: "#5C7A68",
    lineHighlight: "#2A3B32",
  },
  styles: [
    { tag: t.comment, color: "#6A8A78" },
  ],
});
