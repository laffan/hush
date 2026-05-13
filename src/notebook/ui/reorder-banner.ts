import type { DrawingState } from "../state";
import { h } from "./dom-helpers";

/** Floating banner pinned to the top-centre of the canvas while reorder
 *  mode is active. Spells out the modal behaviour ("drag items onto
 *  each other to swap") and offers an explicit Exit button so the user
 *  isn't trapped — the same gesture happens on Esc and on toggling the
 *  Reorder button on the drag-area's selection toolbar. */
export function createReorderBanner(state: DrawingState): HTMLElement {
  const container = h("div", {
    style: {
      position: "absolute", top: "68px", left: "50%",
      transform: "translateX(-50%)",
      display: "none", alignItems: "center", gap: "10px",
      padding: "6px 8px 6px 14px",
      borderRadius: "999px",
      zIndex: "200", pointerEvents: "auto",
      whiteSpace: "nowrap",
      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      fontFamily: "inherit", fontSize: "12px", fontWeight: "500",
    },
  });

  const label = h("span", { text: "Reorder mode — drag an item onto another to swap places" });
  container.appendChild(label);

  const exitBtn = h("button", {
    title: "Exit reorder mode (Esc)",
    style: {
      display: "inline-flex", alignItems: "center", gap: "4px",
      padding: "3px 10px",
      border: "1px solid currentColor",
      borderRadius: "999px", background: "transparent",
      color: "inherit", fontSize: "11px", fontWeight: "500",
      cursor: "pointer", fontFamily: "inherit",
    },
  });
  exitBtn.appendChild(document.createTextNode("Exit ×"));
  exitBtn.addEventListener("click", () => {
    if (state.reorderDragAreaId) state.toggleReorderMode(state.reorderDragAreaId);
  });
  container.appendChild(exitBtn);

  function update() {
    const active = !!state.reorderDragAreaId;
    if (!active) { container.style.display = "none"; return; }
    container.style.display = "inline-flex";
    const theme = state.theme;
    container.style.background = theme.accent;
    // Pick the first text-friendly contrast for the accent badge — most
    // of the canvas themes ship a saturated accent that takes white
    // text well, so we hard-code white rather than recomputing per
    // theme on every change.
    container.style.color = "#fff";
  }

  state.addEventListener("change", update);
  update();
  return container;
}
