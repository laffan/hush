// Author: TextMate
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const espresso = createTheme({
  variant: "light",
  settings: {
    background: "#FFFFFF",
    foreground: "#000000",
    caret: "#000000",
    selection: "#80C7FF",
    gutterBackground: "#FFFFFF",
    gutterForeground: "#00000070",
    lineHighlight: "#C1E2F8",
  },
  styles: [
    { tag: t.comment, color: "#AAAAAA" },
  ],
});
