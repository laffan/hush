// Source: VSCode-Ultimate-Themes-Pack/aurora-borealis-theme.json (Aurora Borealis)
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const auroraBorealis = createTheme({
  variant: "light",
  settings: {
    background: "#eceff4",
    foreground: "#2e3440",
    caret: "#81a1c1",
    selection: "#88c0d0",
    gutterBackground: "#e5e9f0",
    gutterForeground: "#81a1c1",
    lineHighlight: "#5e81ac77",
  },
  styles: [
    { tag: t.comment, color: "#616e88" },
  ],
});
