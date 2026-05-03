// Author: Jacob Rus
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const cobalt = createTheme({
  variant: "dark",
  settings: {
    background: "#00254b",
    foreground: "#FFFFFF",
    caret: "#FFFFFF",
    selection: "#B36539BF",
    gutterBackground: "#00254b",
    gutterForeground: "#FFFFFF70",
    lineHighlight: "#00000059",
  },
  styles: [
    { tag: t.comment, color: "#0088FF" },
  ],
});
