// Source: VSCode-Ultimate-Themes-Pack/solstice-estival-theme.json (Solstice Estival)
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const solsticeEstival = createTheme({
  variant: "light",
  settings: {
    background: "#F0EEE7",
    foreground: "#1B3C3C",
    caret: "#1B3C3C",
    selection: "#A0AA9850",
    gutterBackground: "#F0EEE7",
    gutterForeground: "#9A9992",
    lineHighlight: "#E8E6DF",
  },
  styles: [
    { tag: t.comment, color: "#9A9992" },
  ],
});
