// Source: VSCode-Ultimate-Themes-Pack/midnight-frost-theme.json (Midnight Frost)
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const midnightFrost = createTheme({
  variant: "dark",
  settings: {
    background: "#011627",
    foreground: "#a7dbf7",
    caret: "#219fd5",
    selection: "#103362",
    gutterBackground: "#011627",
    gutterForeground: "#219fd5",
    lineHighlight: "#0c499477",
  },
  styles: [
    { tag: t.comment, color: "#999999" },
  ],
});
