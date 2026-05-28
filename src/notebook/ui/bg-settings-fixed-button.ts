/* src/notebook/ui/bg-settings-fixed-button.ts
 *
 * Fixed Background Settings button — sits in the bottom-right corner of
 * the notebook container, just inboard of the shelf. Replaces the
 * previous end-cap on the bottom toolbar so the background controls
 * are always reachable regardless of where the user has dragged the
 * toolbar.
 *
 * The actual popup is reused from `bg-settings-popup.ts` — this module
 * only owns the fixed button + container placement.
 */

import type { DrawingState } from "../state";
import { h } from "./dom-helpers";
import { icon } from "./icons";
import { createBgSettingsPopup, type BgSettingsHandle } from "./bg-settings-popup";

export interface BgSettingsFixedHandle {
  /** Button element. Append to the notebook container. */
  button: HTMLElement;
  /** Popup element. Append to the same parent so it can position
   *  against the button. */
  popup: HTMLElement;
  /** Reposition the popup against the button. */
  reposition(): void;
}

export function createBgSettingsFixedButton(state: DrawingState): BgSettingsFixedHandle {
  // Underlying popup carries all the bg-pattern controls. We dispose of
  // its built-in tab and wrap our own fixed button around the popup.
  const bg: BgSettingsHandle = createBgSettingsPopup(state);

  // The popup itself ignores `.tab` for positioning — the caller-supplied
  // wrapper handles positioning. Hide the original tab; reuse the popup.
  bg.tab.style.display = "none";

  const button = h("button", {
    title: "Background settings",
    style: {
      position: "absolute",
      bottom: "20px",
      right: "calc(env(safe-area-inset-right) + 36px)",
      width: "40px",
      height: "40px",
      border: "none",
      borderRadius: "10px",
      background: "rgba(127, 127, 127, 0.20)",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: "120",
      transition: "background 0.15s",
      backdropFilter: "blur(6px)",
    },
    children: [icon("grid", 20)],
  });
  button.classList.add("notebook-bg-settings-fixed-btn");

  // Forward clicks into the popup tab so its toggle logic runs.
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    bg.tab.click();
  });

  // The popup positions against `bg.tab` by default. Move bg.tab into the
  // button's box so the popup anchors at the button's location.
  button.appendChild(bg.tab);

  // Repaint button on theme change so its color tracks the canvas.
  function refresh() {
    button.style.color = state.theme.foreground;
  }
  state.addEventListener("change", refresh);
  refresh();

  // Right-edge inset tracking: when the shelf opens / resizes, shift
  // the button inboard so it stays clear.
  function applyRightInset() {
    const ri = state.rightInset || 0;
    button.style.right = `calc(env(safe-area-inset-right) + ${ri + 16}px)`;
    bg.reposition();
  }
  state.addEventListener("change", ((e: CustomEvent) => {
    const keys: string[] = (e.detail && e.detail.keys) || [];
    if (keys.includes("theme") || keys.includes("camera")) applyRightInset();
  }) as EventListener);
  // Use a ResizeObserver-ish poll via the existing change pathway; also
  // listen to window resize since shelf width sync rides on it.
  window.addEventListener("resize", applyRightInset);
  applyRightInset();

  return { button, popup: bg.popup, reposition: bg.reposition };
}
