// Author: Fred LeBlanc
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const clouds = createTheme({
  variant: "light",
  settings: {
    background: "#fff",
    foreground: "#000",
    caret: "#000",
    selection: "#BDD5FC",
    gutterBackground: "#fff",
    gutterForeground: "#00000070",
    lineHighlight: "#FFFBD1",
  },
  styles: [
    { tag: t.comment, color: "#BCC8BA" },
  ],
});
