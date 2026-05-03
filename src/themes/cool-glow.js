// Author: unknown
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const coolGlow = createTheme({
  variant: "dark",
  settings: {
    background: "#060521",
    foreground: "#E0E0E0",
    caret: "#FFFFFFA6",
    selection: "#122BBB",
    gutterBackground: "#060521",
    gutterForeground: "#E0E0E090",
    lineHighlight: "#FFFFFF0F",
  },
  styles: [
    { tag: t.comment, color: "#AEAEAE" },
  ],
});
