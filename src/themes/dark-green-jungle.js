// Source: VSCode-Ultimate-Themes-Pack/dark-green-jungle-theme.json (Dark Green Jungle)
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const darkGreenJungle = createTheme({
  variant: "dark",
  settings: {
    background: "#18211e",
    foreground: "#d4d4d4",
    caret: "#aeafad",
    selection: "#264f78",
    gutterBackground: "#18231e",
    gutterForeground: "#858585",
    lineHighlight: "#ffffff0A",
  },
  styles: [
    { tag: t.comment, color: "#007161" },
  ],
});
