import type { DrawingState } from "../state";
import type { BackgroundPattern } from "../state";
import { h, clearChildren } from "./dom-helpers";
import { icon } from "./icons";

export function createStatusBar(state: DrawingState): HTMLElement {
  const zoomSpan = h("span");
  const shapesSpan = h("span");
  const selectedSpan = h("span");
  const brainstormSpan = h("span", { style: { fontWeight: "600" } });

  // Grid settings popup
  let popupOpen = false;
  const popupContainer = h("div", {
    style: { position: "relative", display: "inline-flex", alignItems: "center" },
  });

  const gridBtn = h("button", {
    title: "Background settings",
    style: {
      width: "20px", height: "20px", border: "none", background: "none",
      cursor: "pointer", padding: "0", display: "flex", alignItems: "center",
      justifyContent: "center", opacity: "0.6", borderRadius: "4px",
    },
    children: [icon("grid", 14)],
    onClick: (e) => { e.stopPropagation(); popupOpen = !popupOpen; buildPopup(); },
  });
  popupContainer.appendChild(gridBtn);

  const popup = h("div", {
    style: {
      display: "none", position: "absolute", bottom: "28px", left: "0",
      padding: "12px 14px", borderRadius: "8px", zIndex: "300",
      boxShadow: "0 4px 20px rgba(0,0,0,0.15)", minWidth: "200px",
    },
  });
  popup.addEventListener("pointerdown", (e) => e.stopPropagation());
  popupContainer.appendChild(popup);

  // Close popup on click outside
  document.addEventListener("click", () => { if (popupOpen) { popupOpen = false; buildPopup(); } });

  function buildPopup() {
    popup.style.display = popupOpen ? "block" : "none";
    if (!popupOpen) return;
    clearChildren(popup);

    const theme = state.theme;
    popup.style.background = theme.uiBackground;
    popup.style.border = `1px solid ${theme.uiBorder}`;

    // Label style
    const labelStyle: Partial<CSSStyleDeclaration> = {
      fontSize: "11px", fontWeight: "600", color: theme.foreground,
      marginBottom: "6px", opacity: "0.7",
    };

    // Pattern buttons
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

    // Spacing + Opacity only when pattern is not blank
    if (state.backgroundPattern !== "blank") {
      popup.appendChild(h("div", { text: "Spacing", style: labelStyle }));
      const spacingRow = h("div", { style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "10px" } });
      const spacingInput = h("input", {
        attrs: { type: "range", min: "10", max: "60", step: "5" },
        style: { flex: "1", accentColor: theme.accent },
      }) as HTMLInputElement;
      spacingInput.value = String(state.gridSpacing);
      const spacingLabel = h("span", {
        text: `${state.gridSpacing}px`,
        style: { fontSize: "11px", color: theme.foreground, opacity: "0.6", minWidth: "30px", textAlign: "right" },
      });
      spacingInput.addEventListener("input", () => {
        state.gridSpacing = parseInt(spacingInput.value, 10);
        spacingLabel.textContent = `${state.gridSpacing}px`;
        state.notify("theme");
      });
      spacingRow.appendChild(spacingInput);
      spacingRow.appendChild(spacingLabel);
      popup.appendChild(spacingRow);

      popup.appendChild(h("div", { text: "Opacity", style: labelStyle }));
      const opacityRow = h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } });
      const opacityInput = h("input", {
        attrs: { type: "range", min: "0", max: "100", step: "5" },
        style: { flex: "1", accentColor: theme.accent },
      }) as HTMLInputElement;
      opacityInput.value = String(Math.round(state.gridOpacity * 100));
      const opacityLabel = h("span", {
        text: `${Math.round(state.gridOpacity * 100)}%`,
        style: { fontSize: "11px", color: theme.foreground, opacity: "0.6", minWidth: "30px", textAlign: "right" },
      });
      opacityInput.addEventListener("input", () => {
        state.gridOpacity = parseInt(opacityInput.value, 10) / 100;
        opacityLabel.textContent = `${opacityInput.value}%`;
        state.notify("theme");
      });
      opacityRow.appendChild(opacityInput);
      opacityRow.appendChild(opacityLabel);
      popup.appendChild(opacityRow);
    }
  }

  const bar = h("div", {
    style: {
      position: "absolute", bottom: "env(safe-area-inset-bottom)", left: "env(safe-area-inset-left)",
      display: "flex", alignItems: "center", padding: "0 12px", gap: "12px", height: "24px",
      fontSize: "11px", zIndex: "50", borderRadius: "0 8px 0 0",
    },
    children: [zoomSpan, shapesSpan, selectedSpan, brainstormSpan, popupContainer],
  });

  function update() {
    const theme = state.theme;
    bar.style.background = theme.uiBackground;
    bar.style.color = theme.foreground;
    bar.style.borderTop = `1px solid ${theme.uiBorder}`;
    bar.style.borderRight = `1px solid ${theme.uiBorder}`;
    bar.style.opacity = "0.85";
    gridBtn.style.color = theme.foreground;
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
