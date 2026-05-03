// Author: Zeno Rocha
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const dracula = createTheme({
  variant: "dark",
  settings: {
    background: "#2d2f3f",
    foreground: "#f8f8f2",
    caret: "#f8f8f0",
    selection: "#44475a",
    gutterBackground: "#282a36",
    gutterForeground: "rgb(144, 145, 148)",
    lineHighlight: "#44475a",
  },
  styles: [
    { tag: t.comment, color: "#6272a4" },
  ],
});
