// Author: Michael Diolosa
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const bespin = createTheme({
  variant: "dark",
  settings: {
    background: "#2e241d",
    foreground: "#BAAE9E",
    caret: "#A7A7A7",
    selection: "#DDF0FF33",
    gutterBackground: "#28211C",
    gutterForeground: "#BAAE9E90",
    lineHighlight: "#FFFFFF08",
  },
  styles: [
    { tag: t.comment, color: "#666666" },
  ],
});
