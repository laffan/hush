// Author: Konstantin Pschera
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const ayuLight = createTheme({
  variant: "light",
  settings: {
    background: "#fcfcfc",
    foreground: "#5c6166",
    caret: "#ffaa33",
    selection: "#036dd626",
    gutterBackground: "#fcfcfc",
    gutterForeground: "#8a919966",
    lineHighlight: "#8a91991a",
  },
  styles: [
    { tag: t.comment, color: "#787b8099" },
  ],
});
