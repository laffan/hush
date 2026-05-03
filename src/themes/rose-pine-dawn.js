// Author: Rosé Pine
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const rosePineDawn = createTheme({
  variant: "light",
  settings: {
    background: "#faf4ed",
    foreground: "#575279",
    caret: "#575279",
    selection: "#6e6a8614",
    gutterBackground: "#faf4ed",
    gutterForeground: "#57527970",
    lineHighlight: "#6e6a860d",
  },
  styles: [
    { tag: t.comment, color: "#9893a5" },
  ],
});
