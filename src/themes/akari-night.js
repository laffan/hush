// Source: VSCode-Ultimate-Themes-Pack/akari-night-theme.json (Akari Night)
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const akariNight = createTheme({
  variant: "dark",
  settings: {
    background: "#171B22",
    foreground: "#E6DED3",
    caret: "#E26A3B",
    selection: "#2D2518",
    gutterBackground: "#171B22",
    gutterForeground: "#2E3543",
    lineHighlight: "#251D1A",
  },
  styles: [
    { tag: t.comment, color: "#7D8797" },
  ],
});
