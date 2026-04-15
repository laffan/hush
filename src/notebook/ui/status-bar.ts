import type { DrawingState } from "../state";
import { h } from "./dom-helpers";

export function createStatusBar(state: DrawingState): HTMLElement {
  const zoomSpan = h("span");
  const shapesSpan = h("span");
  const selectedSpan = h("span");
  const brainstormSpan = h("span", { style: { fontWeight: "600" } });

  const bar = h("div", {
    style: {
      position: "absolute", bottom: "env(safe-area-inset-bottom)", left: "env(safe-area-inset-left)",
      display: "flex", alignItems: "center", padding: "0 12px", gap: "12px", height: "24px",
      fontSize: "11px", zIndex: "50", borderRadius: "0 8px 0 0",
    },
    children: [zoomSpan, shapesSpan, selectedSpan, brainstormSpan],
  });

  function update() {
    const theme = state.theme;
    bar.style.background = theme.uiBackground;
    bar.style.color = theme.foreground;
    bar.style.borderTop = `1px solid ${theme.uiBorder}`;
    bar.style.borderRight = `1px solid ${theme.uiBorder}`;
    bar.style.opacity = "0.85";
    brainstormSpan.style.color = theme.accent;

    zoomSpan.textContent = Math.round(state.camera.zoom * 100) + "%";
    const n = state.shapes.length;
    shapesSpan.textContent = `${n} shape${n !== 1 ? "s" : ""}`;
    selectedSpan.textContent = state.selectedIds.size > 0 ? `${state.selectedIds.size} selected` : "";
    brainstormSpan.textContent = state.brainstormMode ? "Brainstorm" : "";
  }

  state.addEventListener("change", update);
  update();
  return bar;
}
