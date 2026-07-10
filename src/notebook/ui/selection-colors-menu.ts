/* Combined Colors menu for the selection toolbar — text / bg / border
 * swatch rows plus the app-wide saved-style chips. Extracted from
 * selection-toolbar.ts to keep that file under the 700-line cap. */

import type { DrawingState } from "../state";
import { COLOR_PALETTE, BACKGROUND_COLORS, TEXT_COLORS } from "../types";
import { h } from "./dom-helpers";

interface SavedTextStyle {
  id: string;
  color: string;
  backgroundColor?: string;
  fontSize: number;
  borderColor?: string;
  borderWidth?: number;
}

interface AppStateBridge {
  settings?: { notebookTextStyles?: SavedTextStyle[] };
  updateSettings?: (p: Record<string, unknown>) => void;
  on?: (ev: string, fn: () => void) => void;
  off?: (ev: string, fn: () => void) => void;
}

function getAppState(): AppStateBridge | undefined {
  return (window as unknown as { __hushState__?: AppStateBridge }).__hushState__;
}

function getSavedTextStyles(): SavedTextStyle[] {
  const list = getAppState()?.settings?.notebookTextStyles;
  return Array.isArray(list) ? list : [];
}

function setSavedTextStyles(next: SavedTextStyle[]): void {
  const app = getAppState();
  if (app && typeof app.updateSettings === "function") {
    app.updateSettings({ notebookTextStyles: next });
  }
}

function genStyleId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function resolveBackground(bg: string | undefined): string | undefined {
  if (!bg) return undefined;
  return COLOR_PALETTE[bg] || bg;
}

function makeSwatchRow(state: DrawingState, colors: readonly string[], onSelect: (c: string) => void): HTMLElement {
  const theme = state.theme;
  return h("div", {
    style: { display: "flex", gap: "4px", alignItems: "center" },
    children: colors.map((c) => {
      if (c === "reset") {
        const btn = h("button", {
          title: "Reset",
          style: { width: "14px", height: "14px", borderRadius: "50%", border: "1px solid #ccc", background: "#fff", cursor: "pointer", padding: "0", position: "relative" },
          onClick: () => onSelect(c),
        });
        const slash = h("span", { style: { position: "absolute", top: "50%", left: "-1px", width: "14px", height: "1px", background: "red", transform: "rotate(45deg)", transformOrigin: "center" } });
        btn.appendChild(slash);
        return btn;
      }
      if (c === "auto") {
        const btn = h("button", {
          title: "Auto (theme foreground)",
          style: { width: "14px", height: "14px", borderRadius: "50%", border: "1px solid #ccc", background: theme.foreground, cursor: "pointer", padding: "0", position: "relative", display: "flex", alignItems: "center", justifyContent: "center" },
          onClick: () => onSelect(c),
        });
        btn.appendChild(h("span", { text: "A", style: { fontSize: "8px", fontWeight: "bold", color: theme.variant === "dark" ? "#000" : "#fff", lineHeight: "1", pointerEvents: "none" } }));
        return btn;
      }
      if (c === "heading") {
        const btn = h("button", {
          title: "Heading (theme heading color)",
          style: { width: "14px", height: "14px", borderRadius: "50%", border: "1px solid #ccc", background: theme.headingColor, cursor: "pointer", padding: "0", position: "relative", display: "flex", alignItems: "center", justifyContent: "center" },
          onClick: () => onSelect(c),
        });
        btn.appendChild(h("span", { text: "H", style: { fontSize: "8px", fontWeight: "bold", color: theme.variant === "dark" ? "#000" : "#fff", lineHeight: "1", pointerEvents: "none" } }));
        return btn;
      }
      return h("button", {
        title: c,
        style: { width: "14px", height: "14px", borderRadius: "50%", border: c === "white" ? "1px solid #ccc" : "none", background: COLOR_PALETTE[c] || "#ccc", cursor: "pointer", padding: "0" },
        onClick: () => onSelect(c),
      });
    }),
  });
}

/** Combined Colors menu — text/bg/border rows + saved-style chips. */
export function makeColorsMenu(
  state: DrawingState,
  rerender: () => void,
  opts: { hasColorable: boolean; hasBgable: boolean; hasText: boolean },
): HTMLElement {
  const theme = state.theme;
  const muted = theme.variant === "dark" ? "rgba(255,255,255,0.5)" : "#666";
  const panel = h("div", {
    style: {
      position: "absolute", left: "50%", transform: "translateX(-50%)",
      bottom: "calc(100% + 4px)",
      display: "flex", flexDirection: "column", gap: "6px", padding: "8px 10px",
      background: theme.uiBackground, borderRadius: "8px",
      boxShadow: "0 2px 8px rgba(0,0,0,0.15)", border: `1px solid ${theme.uiBorder}`,
      zIndex: "300", whiteSpace: "nowrap",
    },
  });
  panel.addEventListener("pointerdown", (e) => e.stopPropagation());

  // Fixed-width labels keep the swatch rows aligned so the colour
  // circles line up across "Text" and "Bg".
  const labelStyle: Partial<CSSStyleDeclaration> = {
    fontSize: "11px", color: muted, width: "42px", flexShrink: "0",
    textTransform: "uppercase", letterSpacing: "0.5px",
  };

  function makeRow(label: string, swatches: HTMLElement): HTMLElement {
    return h("div", {
      style: { display: "flex", alignItems: "center", gap: "8px" },
      children: [
        h("span", { text: label, style: labelStyle }),
        swatches,
      ],
    });
  }

  if (opts.hasColorable) {
    panel.appendChild(makeRow("Text", makeSwatchRow(state, TEXT_COLORS, (c) => {
      state.changeSelectedColor(c === "reset" ? "black" : c);
    })));
  }

  if (opts.hasBgable) {
    panel.appendChild(makeRow("Bg", makeSwatchRow(state, BACKGROUND_COLORS, (c) => {
      state.changeSelectedBackground(c);
    })));
    panel.appendChild(makeRow("Border", makeSwatchRow(state, BACKGROUND_COLORS, (c) => {
      state.changeSelectedBorder(c);
    })));
  }

  if (!opts.hasText) return panel;

  // Divider above the saved-style chips.
  panel.appendChild(h("div", {
    style: {
      height: "1px", background: theme.uiBorder, margin: "2px 0",
    },
  }));

  const stylesRow = h("div", {
    style: { display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap" },
  });

  const styles = getSavedTextStyles();
  if (styles.length === 0) {
    stylesRow.appendChild(h("span", {
      text: "No saved styles",
      style: { fontSize: "11px", color: muted, padding: "0 4px" },
    }));
  }

  for (const s of styles) {
    const wrap = h("div", { style: { position: "relative", display: "inline-flex" } });
    const fg = s.color || theme.foreground;
    const bg = resolveBackground(s.backgroundColor) || "transparent";
    const borderStyle = s.borderColor
      ? `${s.borderWidth || 2}px solid ${COLOR_PALETTE[s.borderColor] || s.borderColor}`
      : bg === "transparent" ? "1px dashed rgba(0,0,0,0.15)" : "1px solid rgba(0,0,0,0.06)";
    const chip = h("button", {
      title: `Apply (${s.fontSize}px)`,
      style: {
        padding: "3px 10px",
        border: borderStyle,
        borderRadius: "10px",
        background: bg,
        color: fg,
        fontSize: `${Math.max(10, Math.min(14, s.fontSize / 2))}px`,
        fontWeight: "500",
        cursor: "pointer",
        fontFamily: "inherit",
        lineHeight: "1.4",
      },
      children: ["Aa"],
      onClick: () => {
        state.applyTextStyle({
          color: s.color,
          backgroundColor: s.backgroundColor,
          fontSize: s.fontSize,
          borderColor: s.borderColor,
          borderWidth: s.borderWidth,
        });
      },
    });
    wrap.appendChild(chip);

    const del = h("button", {
      title: "Delete style",
      text: "×",
      style: {
        position: "absolute", top: "-6px", right: "-6px",
        width: "14px", height: "14px", borderRadius: "50%",
        border: "none", background: theme.uiBackground,
        color: theme.foreground, fontSize: "11px", lineHeight: "12px",
        cursor: "pointer", padding: "0",
        boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
        display: "none",
      },
    });
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      const remaining = getSavedTextStyles().filter((x) => x.id !== s.id);
      setSavedTextStyles(remaining);
      rerender();
    });
    wrap.addEventListener("mouseenter", () => { del.style.display = "block"; });
    wrap.addEventListener("mouseleave", () => { del.style.display = "none"; });
    wrap.appendChild(del);

    stylesRow.appendChild(wrap);
  }

  const chipBtnStyle: Partial<CSSStyleDeclaration> = {
    display: "inline-flex", alignItems: "center", gap: "3px",
    padding: "3px 8px",
    border: `1px solid ${theme.uiBorder}`,
    borderRadius: "10px", background: "transparent",
    color: theme.foreground, fontSize: "11px", fontWeight: "500",
    cursor: "pointer", fontFamily: "inherit",
  };

  const addBtn = h("button", {
    title: "Save current style",
    style: chipBtnStyle,
    children: ["+ Style"],
    onClick: () => {
      const firstText = state.shapes.find((sh) => state.selectedIds.has(sh.id) && sh.type === "text");
      if (!firstText || firstText.type !== "text") return;
      const entry: SavedTextStyle = {
        id: genStyleId(),
        color: firstText.color || "#000000",
        backgroundColor: firstText.backgroundColor,
        fontSize: firstText.fontSize,
        borderColor: (firstText as unknown as { borderColor?: string }).borderColor,
        borderWidth: (firstText as unknown as { borderWidth?: number }).borderWidth,
      };
      setSavedTextStyles([...getSavedTextStyles(), entry]);
      rerender();
    },
  });
  stylesRow.appendChild(addBtn);

  const clearBtn = h("button", {
    title: "Reset text color, background, and size",
    style: chipBtnStyle,
    children: ["Clear"],
    onClick: () => {
      state.changeSelectedColor("black");
      state.changeSelectedBackground("reset");
      // Default seeded by addTextShape* in state.ts: state.fontSize,
      // which tracks the user's Settings > Editor > Notebook text size.
      state.changeSelectedFontSize(state.fontSize);
    },
  });
  stylesRow.appendChild(clearBtn);

  panel.appendChild(stylesRow);

  return panel;
}
