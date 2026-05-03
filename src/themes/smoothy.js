// Author: Kenneth Reitz
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const smoothy = createTheme({
  variant: "light",
  settings: {
    background: "#FFFFFF",
    foreground: "#000000",
    caret: "#000000",
    selection: "#FFFD0054",
    gutterBackground: "#FFFFFF",
    gutterForeground: "#00000070",
    lineHighlight: "#00000008",
  },
  styles: [
    { tag: t.comment, color: "#CFCFCF" },
  ],
});
