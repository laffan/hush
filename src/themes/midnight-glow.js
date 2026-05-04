// Source: VSCode-Ultimate-Themes-Pack/midnight-glow-theme.json (Midnight Glow)
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const midnightGlow = createTheme({
  variant: "dark",
  settings: {
    background: "#27273A",
    foreground: "#fcf6ff",
    caret: "#97EE91",
    selection: "#42557BC0",
    gutterBackground: "#27273A",
    gutterForeground: "#919CB9",
    lineHighlight: "#2A2A46",
  },
  styles: [
    { tag: t.comment, color: "#8059A2" },
  ],
});
