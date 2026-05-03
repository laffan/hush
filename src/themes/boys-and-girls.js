// Author: unknown
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const boysAndGirls = createTheme({
  variant: "dark",
  settings: {
    background: "#000205",
    foreground: "#FFFFFF",
    caret: "#E60065",
    selection: "#E60C6559",
    gutterBackground: "#000205",
    gutterForeground: "#ffffff90",
    lineHighlight: "#4DD7FC1A",
  },
  styles: [
    { tag: t.comment, color: "#404040" },
  ],
});
