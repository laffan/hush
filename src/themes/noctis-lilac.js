// Author: Liviu Schera
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const noctisLilac = createTheme({
  variant: "light",
  settings: {
    background: "#f2f1f8",
    foreground: "#0c006b",
    caret: "#5c49e9",
    selection: "#d5d1f2",
    gutterBackground: "#f2f1f8",
    gutterForeground: "#0c006b70",
    lineHighlight: "#e1def3",
  },
  styles: [
    { tag: t.comment, color: "#9995b7" },
  ],
});
