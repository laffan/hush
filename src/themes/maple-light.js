// Source: VSCode-Ultimate-Themes-Pack/maple-light-color-theme.json (Maple Light)
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const mapleLight = createTheme({
  variant: "light",
  settings: {
    background: "#fffffe",
    foreground: "#475569",
    caret: "#6e7e95",
    selection: "#dee4d8e6",
    gutterBackground: "#fffffe",
    gutterForeground: "#808080b3",
    lineHighlight: "#dee4d840",
  },
  styles: [
    { tag: t.comment, color: "#808080" },
  ],
});
