// Author: Joe Bergantine
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const birdsOfParadise = createTheme({
  variant: "dark",
  settings: {
    background: "#3b2627",
    foreground: "#E6E1C4",
    caret: "#E6E1C4",
    selection: "#16120E",
    gutterBackground: "#3b2627",
    gutterForeground: "#E6E1C490",
    lineHighlight: "#1F1611",
  },
  styles: [
    { tag: t.comment, color: "#6B4E32" },
  ],
});
