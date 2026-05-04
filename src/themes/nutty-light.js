// Source: VSCode-Ultimate-Themes-Pack/nutty-light-theme.json (Nutty Light Theme)
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const nuttyLight = createTheme({
  variant: "light",
  settings: {
    background: "#FFFEF9",
    foreground: "#2A1F16",
    caret: "#E67D22",
    selection: "#FFD9B8",
    gutterBackground: "#FFFEF9",
    gutterForeground: "#8B7D6B",
    lineHighlight: "#F5F0E8",
  },
  styles: [
    { tag: t.comment, color: "#746B5F" },
  ],
});
