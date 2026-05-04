// Source: VSCode-Ultimate-Themes-Pack/aurum-dusk-theme.json (Aurum Dusk)
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const aurumDusk = createTheme({
  variant: "dark",
  settings: {
    background: "#1a1614",
    foreground: "#f2e8dc",
    caret: "#d6aa63",
    selection: "#3a2d2c",
    gutterBackground: "#1a1614",
    gutterForeground: "#6b5a54",
    lineHighlight: "#2a1f1e",
  },
  styles: [
    { tag: t.comment, color: "#7b6a60" },
  ],
});
