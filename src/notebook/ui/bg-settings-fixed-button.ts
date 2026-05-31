/* src/notebook/ui/bg-settings-fixed-button.ts
 *
 * Fixed Background Settings button — bottom-right corner of the
 * notebook container, just inboard of the shelf. Replaces the bottom
 * toolbar's end-cap so the bg controls are always reachable wherever
 * the toolbar happens to be sitting.
 *
 * The actual popup is reused from `bg-settings-popup.ts`; this module
 * owns the visible button + sidebar/shelf inset tracking. The popup's
 * internal tab is left detached — we call `bg.toggle()` directly and
 * `bg.setAnchor(button)` so positioning lines up with the fixed
 * button.
 */

import type { DrawingState } from "../state";
import { h } from "./dom-helpers";
import { icon } from "./icons";
import { createBgSettingsPopup } from "./bg-settings-popup";

export interface BgSettingsFixedHandle {
  /** Visible button. Append to the notebook container. */
  button: HTMLElement;
  /** Popup element. Append to the same parent so it positions against
   *  the button. */
  popup: HTMLElement;
  /** Reposition the popup against the button. */
  reposition(): void;
}

export function createBgSettingsFixedButton(state: DrawingState): BgSettingsFixedHandle {
  const bg = createBgSettingsPopup(state);

  const button = h("button", {
    title: "Background settings",
    style: {
      position: "absolute",
      bottom: "20px",
      width: "40px",
      height: "40px",
      borderRadius: "10px",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: "120",
      transition: "background 0.15s, border-color 0.15s",
      backdropFilter: "blur(6px)",
    },
    children: [icon("grid", 20)],
    onClick: (e) => { e.stopPropagation(); bg.toggle(); },
  });
  button.classList.add("notebook-bg-settings-fixed-btn");

  // Anchor the popup against the visible button — the fixed button
  // sits in the bottom-right corner, so use the above-right mode so
  // the flyout opens upward and aligns with the button's right edge.
  bg.setAnchor(button, { mode: "above-right" });

  function refresh() {
    const theme = state.theme;
    button.style.color = theme.foreground;
    // Track the notebook's actual background colour so the button reads
    // as part of the canvas surface (matching what the user just set in
    // bg settings), with a subtle outline mirroring the sidebar / shelf
    // border so the button still distinguishes itself from blank canvas.
    button.style.background = theme.background;
    button.style.border = `1px solid ${theme.uiBorder}`;
  }

  function applyRightInset() {
    // state.rightInset already measures the shelf's left edge against
    // the container's right edge — so when a right-docked pane shifts
    // the shelf left, this picks up the extended distance and the
    // button stays just inboard of the shelf without double counting.
    const ri = state.rightInset || 0;
    button.style.right = `calc(env(safe-area-inset-right) + ${ri + 16}px)`;
    bg.reposition();
  }

  // Single listener — handles both theme and inset updates.
  state.addEventListener("change", ((e: CustomEvent) => {
    const keys: string[] = (e.detail && e.detail.keys) || [];
    if (keys.includes("theme")) {
      refresh();
      applyRightInset();
    }
  }) as EventListener);

  window.addEventListener("resize", applyRightInset);

  refresh();
  applyRightInset();

  return { button, popup: bg.popup, reposition: bg.reposition };
}
