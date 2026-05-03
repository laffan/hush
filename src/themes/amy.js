// Author: William D. Neumann
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const amy = createTheme({
  variant: "dark",
  settings: {
    background: "#200020",
    foreground: "#D0D0FF",
    caret: "#7070FF",
    selection: "#80000080",
    gutterBackground: "#200020",
    gutterForeground: "#C080C0",
    lineHighlight: "#80000040",
  },
  styles: [
    { tag: t.comment, color: "#404080" },
  ],
});
