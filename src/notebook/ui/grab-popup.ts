/**
 * The grab's control bar — a fixed pill at the top centre of the canvas.
 *
 * A grab is the one canvas gesture that spans two pointer interactions
 * with a live buffer in between, so it needs somewhere permanent to say
 * what stage it is in and how to get out. Canvas chrome couldn't do that
 * job: it would scroll away the moment the user panned to find a landing
 * spot, which is exactly what the place stage asks them to do.
 *
 * The bar reads `state.grab` and nothing else, so it stays correct
 * through undo and redo — those restore the session along with the
 * shapes (see undo-manager.ts).
 */

import type { DrawingState } from "../state";
import { h } from "./dom-helpers";
import { applyGrab, cancelGrab } from "../state-splits";

export function createGrabPopup(state: DrawingState): HTMLElement {
  const label = h("span", {
    style: { fontSize: "12px", fontWeight: "600", letterSpacing: "0.02em", whiteSpace: "nowrap" },
  });

  const mkBtn = (text: string, primary: boolean, onClick: () => void) =>
    h("button", {
      text,
      style: {
        border: "none", borderRadius: "6px", padding: "5px 12px",
        fontSize: "12px", fontWeight: "600", cursor: "pointer",
        fontFamily: "var(--ui-font-family)",
        background: primary ? "#2563eb" : "transparent",
        color: primary ? "#ffffff" : "inherit",
      },
      onClick: (e) => { e.stopPropagation(); onClick(); },
    });

  const applyBtn = mkBtn("Apply Grab", true, () => applyGrab(state));
  const cancelBtn = mkBtn("Cancel", false, () => cancelGrab(state));

  const root = h("div", {
    style: {
      position: "absolute", top: "16px", left: "50%", transform: "translateX(-50%)",
      display: "none", alignItems: "center", gap: "10px",
      padding: "6px 8px 6px 14px", borderRadius: "10px",
      boxShadow: "0 4px 20px rgba(0,0,0,0.18)", zIndex: "160",
      userSelect: "none", backdropFilter: "blur(8px)",
      fontFamily: "var(--ui-font-family)",
    },
    children: [label, applyBtn, cancelBtn],
  });
  root.classList.add("notebook-grab-bar");

  function update() {
    const g = state.grab;
    // Hidden while the band is actively being swept — the pill would
    // otherwise flicker in under the cursor on every drag.
    const visible = !!g && !state.grabBandDrag;
    root.style.display = visible ? "flex" : "none";
    if (!visible || !g) return;
    const theme = state.theme;
    root.style.background = theme.uiBackground;
    root.style.color = theme.foreground;
    root.style.border = `1px solid ${theme.uiBorder}`;
    cancelBtn.style.color = theme.foreground;
    if (g.stage === "band") {
      label.textContent = "Adjust the grab, then apply";
      applyBtn.style.display = "";
    } else {
      label.textContent = `Click to place ${g.buffer.length} item${g.buffer.length === 1 ? "" : "s"}`;
      applyBtn.style.display = "none";
    }
  }

  state.addEventListener("change", update);
  update();
  return root;
}
