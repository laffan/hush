// Source: VSCode-Ultimate-Themes-Pack/soft-contrast-theme.json (Soft Contrast)
import { tags as t } from "@lezer/highlight";
import { createTheme } from "./_create-theme.js";

export const softContrast = createTheme({
  variant: "light",
  settings: {
    background: "#F5F3EE",
    foreground: "#2B2B2B",
    caret: "#2B6FA6",
    selection: "#E0E3DF",
    gutterBackground: "#F5F3EE",
    gutterForeground: "#817B74",
    lineHighlight: "#E7E6E2",
  },
  styles: [
    { tag: t.comment, color: "#817B74" },
  ],
});
