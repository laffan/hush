// Source: VSCode-Ultimate-Themes-Pack/calm-dark-theme.json (Calm Dark)
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const calmDark = createTheme({
  variant: "dark",
  settings: {
    background: "#191f22",
    foreground: "#e6e2d9",
    caret: "#8DC6AC",
    selection: "#434A52",
    gutterBackground: "#191f22",
    gutterForeground: "#8A9198",
    lineHighlight: "#00000010",
  },
  styles: [
    { tag: t.comment, color: "#7f9916" },
  ],
});
