// Source: VSCode-Ultimate-Themes-Pack/eye-comfort-dark-pro-theme.json (Eye Comfort Dark Pro)
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const eyeComfortDarkPro = createTheme({
  variant: "dark",
  settings: {
    background: "#1e1e1e",
    foreground: "#d4d4d4",
    caret: "#aeafad",
    selection: "#264f78",
    gutterBackground: "#1e1e1e",
    gutterForeground: "#858585",
    lineHighlight: "#282828",
  },
  styles: [
    { tag: t.comment, color: "#6A9955" },
  ],
});
