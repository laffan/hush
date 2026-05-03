// Author: unknown
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const barf = createTheme({
  variant: "dark",
  settings: {
    background: "#15191EFA",
    foreground: "#EEF2F7",
    caret: "#C4C4C4",
    selection: "#90B2D557",
    gutterBackground: "#15191EFA",
    gutterForeground: "#aaaaaa95",
    lineHighlight: "#57575712",
  },
  styles: [
    { tag: t.comment, color: "#6E6E6E" },
  ],
});
