// Author: Chris Kempson
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const tomorrow = createTheme({
  variant: "light",
  settings: {
    background: "#FFFFFF",
    foreground: "#4D4D4C",
    caret: "#AEAFAD",
    selection: "#D6D6D6",
    gutterBackground: "#FFFFFF",
    gutterForeground: "#4D4D4C80",
    lineHighlight: "#EFEFEF",
  },
  styles: [
    { tag: t.comment, color: "#8E908C" },
  ],
});
