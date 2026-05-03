// Author: Ethan Schoonover
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const solarizedLight = createTheme({
  variant: "light",
  settings: {
    background: "#fef7e5",
    foreground: "#586E75",
    caret: "#000000",
    selection: "#073642",
    gutterBackground: "#fef7e5",
    gutterForeground: "#586E7580",
    lineHighlight: "#EEE8D5",
  },
  styles: [
    { tag: t.comment, color: "#93A1A1" },
  ],
});
