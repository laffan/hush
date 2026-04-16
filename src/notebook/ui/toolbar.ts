import type { DrawingState } from "../state";
import type { Tool } from "../types";
import type { BackgroundPattern } from "../state";
import { h, clearChildren } from "./dom-helpers";
import { icon } from "./icons";
import { createBookmarksPanel } from "./bookmarks-panel";

interface ToolDef { iconName: string; label: string; tool: Tool | "brainstorm"; shortcut: string }

const TOOLS: ToolDef[] = [
  { iconName: "select", label: "Select", tool: "select", shortcut: "1" },
  { iconName: "text", label: "Text", tool: "text", shortcut: "T" },
  { iconName: "drag-area", label: "Drag Area", tool: "drag-area", shortcut: "A" },
  { iconName: "brainstorm", label: "Brainstorm", tool: "brainstorm", shortcut: "B" },
];

function createGridPopup(state: DrawingState): HTMLElement {
  let popupOpen = false;

  const wrapper = h("div", { style: { position: "relative", display: "inline-flex", alignItems: "center" } });

  const gridBtn = h("button", {
    title: "Background settings",
    style: {
      width: "36px", height: "36px", border: "none", borderRadius: "8px",
      cursor: "pointer", background: "transparent", display: "flex",
      alignItems: "center", justifyContent: "center",
    },
    children: [icon("grid", 18)],
    onClick: (e) => { e.stopPropagation(); popupOpen = !popupOpen; buildPopup(); },
  });
  wrapper.appendChild(gridBtn);

  const popup = h("div", {
    style: {
      display: "none", position: "absolute", bottom: "44px", left: "50%",
      transform: "translateX(-50%)", padding: "12px 14px", borderRadius: "8px",
      zIndex: "300", boxShadow: "0 4px 20px rgba(0,0,0,0.15)", minWidth: "200px",
    },
  });
  popup.addEventListener("pointerdown", (e) => e.stopPropagation());
  wrapper.appendChild(popup);

  document.addEventListener("click", () => { if (popupOpen) { popupOpen = false; buildPopup(); } });

  function buildPopup() {
    popup.style.display = popupOpen ? "block" : "none";
    if (!popupOpen) return;
    clearChildren(popup);

    const theme = state.theme;
    popup.style.background = theme.uiBackground;
    popup.style.border = `1px solid ${theme.uiBorder}`;

    const labelStyle: Partial<CSSStyleDeclaration> = {
      fontSize: "11px", fontWeight: "600", color: theme.foreground,
      marginBottom: "6px", opacity: "0.7",
    };

    popup.appendChild(h("div", { text: "Pattern", style: labelStyle }));
    const patternRow = h("div", { style: { display: "flex", gap: "4px", marginBottom: "10px" } });
    const patterns: { label: string; value: BackgroundPattern }[] = [
      { label: "Grid", value: "grid" },
      { label: "Dots", value: "dot-grid" },
      { label: "Blank", value: "blank" },
    ];
    for (const pat of patterns) {
      const active = state.backgroundPattern === pat.value;
      patternRow.appendChild(h("button", {
        text: pat.label,
        style: {
          padding: "3px 10px", border: `1px solid ${active ? theme.accent : theme.uiBorder}`,
          borderRadius: "4px", background: active ? theme.accent : "transparent",
          color: active ? "#fff" : theme.foreground, cursor: "pointer",
          fontSize: "11px", fontWeight: active ? "600" : "400",
        },
        onClick: () => { state.backgroundPattern = pat.value; state.notify("theme"); buildPopup(); },
      }));
    }
    popup.appendChild(patternRow);

    if (state.backgroundPattern !== "blank") {
      popup.appendChild(h("div", { text: "Spacing", style: labelStyle }));
      const spacingRow = h("div", { style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "10px" } });
      const spacingInput = h("input", { attrs: { type: "range", min: "10", max: "60", step: "5" }, style: { flex: "1", accentColor: theme.accent } }) as HTMLInputElement;
      spacingInput.value = String(state.gridSpacing);
      const spacingLabel = h("span", { text: `${state.gridSpacing}px`, style: { fontSize: "11px", color: theme.foreground, opacity: "0.6", minWidth: "30px", textAlign: "right" } });
      spacingInput.addEventListener("input", () => { state.gridSpacing = parseInt(spacingInput.value, 10); spacingLabel.textContent = `${state.gridSpacing}px`; state.notify("theme"); });
      spacingRow.appendChild(spacingInput);
      spacingRow.appendChild(spacingLabel);
      popup.appendChild(spacingRow);

      popup.appendChild(h("div", { text: "Opacity", style: labelStyle }));
      const opacityRow = h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } });
      const opacityInput = h("input", { attrs: { type: "range", min: "0", max: "100", step: "5" }, style: { flex: "1", accentColor: theme.accent } }) as HTMLInputElement;
      opacityInput.value = String(Math.round(state.gridOpacity * 100));
      const opacityLabel = h("span", { text: `${Math.round(state.gridOpacity * 100)}%`, style: { fontSize: "11px", color: theme.foreground, opacity: "0.6", minWidth: "30px", textAlign: "right" } });
      opacityInput.addEventListener("input", () => { state.gridOpacity = parseInt(opacityInput.value, 10) / 100; opacityLabel.textContent = `${opacityInput.value}%`; state.notify("theme"); });
      opacityRow.appendChild(opacityInput);
      opacityRow.appendChild(opacityLabel);
      popup.appendChild(opacityRow);
    }
  }

  // Expose button for theme updates
  (wrapper as any)._gridBtn = gridBtn;
  return wrapper;
}

export function createToolbar(state: DrawingState): HTMLElement {
  const buttons = new Map<string, HTMLButtonElement>();

  function makeBtn(def: ToolDef): HTMLButtonElement {
    const btn = h("button", {
      title: `${def.label} (${def.shortcut})`,
      style: { width: "36px", height: "36px", display: "flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: "8px", cursor: "pointer", background: "transparent", transition: "all 0.15s" },
      children: [icon(def.iconName, 20)],
      onClick: () => {
        if (def.tool === "brainstorm") {
          state.brainstormMode = !state.brainstormMode;
          if (state.brainstormMode) { state.tool = "text"; state.notify("tool"); }
          state.notify("brainstormMode");
        } else {
          state.tool = def.tool;
          state.brainstormMode = false;
          state.notify("tool");
          state.notify("brainstormMode");
        }
      },
    });
    buttons.set(def.tool, btn);
    return btn;
  }

  const spacer = h("div", { style: { flex: "1" } });

  const gridPopup = createGridPopup(state);

  const undoBtn = h("button", {
    title: "Undo (Cmd+Z)",
    style: { width: "36px", height: "36px", display: "flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: "8px", cursor: "pointer", background: "transparent", opacity: "0.4" },
    children: [icon("undo", 20)],
    onClick: () => state.undo(),
  });
  const redoBtn = h("button", {
    title: "Redo (Cmd+Shift+Z)",
    style: { width: "36px", height: "36px", display: "flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: "8px", cursor: "pointer", background: "transparent", opacity: "0.4" },
    children: [icon("redo", 20)],
    onClick: () => state.redo(),
  });

  const resetBtn = h("button", {
    title: "Reset view",
    style: { width: "36px", height: "36px", display: "flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: "8px", cursor: "pointer", background: "transparent" },
    children: [icon("reset", 20)],
    onClick: () => { state.camera = { x: 0, y: 0, zoom: 1 }; state.notify("camera"); },
  });

  const bookmarksEl = createBookmarksPanel(state);

  const container = h("div", {
    style: {
      position: "absolute", bottom: "calc(16px + env(safe-area-inset-bottom))",
      display: "flex", alignItems: "center", gap: "4px", padding: "6px 8px",
      borderRadius: "12px",
      boxShadow: "0 2px 12px rgba(0,0,0,0.12)", zIndex: "100", userSelect: "none",
      backdropFilter: "blur(8px)",
    },
    children: [
      ...TOOLS.map(makeBtn),
      spacer,
      bookmarksEl,
      gridPopup,
      resetBtn,
      undoBtn,
      redoBtn,
    ],
  });

  const gridBtnEl = (gridPopup as any)._gridBtn as HTMLElement;

  function update() {
    const theme = state.theme;
    container.style.background = theme.uiBackground;

    // Center toolbar between sidebar inset and right edge of parent
    const inset = state.leftInset || 0;
    const parentW = container.parentElement?.clientWidth || window.innerWidth;
    const center = inset + (parentW - inset) / 2;
    container.style.left = center + "px";
    container.style.transform = "translateX(-50%)";

    const fg = theme.foreground;
    const accent = theme.accent;

    for (const [key, btn] of buttons) {
      const active = key === "brainstorm" ? state.brainstormMode : (state.tool === key && !state.brainstormMode);
      btn.style.color = active ? accent : fg;
      btn.style.opacity = active ? "1" : "0.6";
    }
    undoBtn.style.color = fg;
    redoBtn.style.color = fg;
    resetBtn.style.color = fg;
    gridBtnEl.style.color = fg;
    gridBtnEl.style.opacity = "0.6";
    undoBtn.style.opacity = state.canUndo ? "0.8" : "0.3";
    redoBtn.style.opacity = state.canRedo ? "0.8" : "0.3";
  }

  state.addEventListener("change", update);
  update();
  return container;
}
