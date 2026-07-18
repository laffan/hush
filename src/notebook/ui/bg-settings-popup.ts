/* src/notebook/ui/bg-settings-popup.ts
 *
 * Background-settings end-cap: a gray pill mirroring the drag /
 * rotate tabs on the opposite side of the combined toolbar. Click
 * the pill to toggle a popup with the canvas background pattern,
 * spacing, and opacity controls. The popup follows the same
 * proximity rule as the other flyouts — if the bar is in the top
 * half of the window the popup pushes down, otherwise up. Vertical
 * mode mirrors that on the X axis.
 *
 * Returns the tab element + a popup element that should be appended
 * to the same parent the other flyouts live in (so it can position
 * absolutely against it).
 */

import type { DrawingState } from "../state";
import type { BackgroundPattern } from "../state";
import { h, clearChildren } from "./dom-helpers";
import { icon } from "./icons";

export interface BgSettingsHandle {
  /** End-cap pill that holds the background-settings icon. */
  tab: HTMLButtonElement;
  /** The popup element. Append to the same flyoutGroup the other
   *  drawing flyouts live in so it positions next to the tab. */
  popup: HTMLElement;
  /** Reposition the popup against the tab. Callers fire this on
   *  toolbar drags / orientation flips so the popup tracks. */
  reposition(): void;
  /** Refresh tab colors after a theme change. */
  refreshTheme(): void;
  /** Toggle the popup open/closed without going through the tab. Used
   *  by the fixed bottom-right button, which can't forward via
   *  `tab.click()` without re-entering its own listener. */
  toggle(): void;
  /** Use an alternate anchor element for popup positioning. The fixed
   *  bottom-right button calls this with itself so positioning lands
   *  next to the visible button rather than the hidden internal tab.
   *  `mode: "above-right"` aligns the popup's bottom to the anchor's
   *  top edge and its right to the anchor's right — used by the
   *  bottom-right fixed button so the flyout opens upward. */
  setAnchor(el: HTMLElement | null, opts?: { mode?: "auto" | "above-right" }): void;
}

/** Notify the bridge so the per-notebook bg fields ride the next save.
 *  Event fires on document so the bridge can listen at one root
 *  regardless of which container the emitter mounted into. Shared with
 *  the fixed bottom-right chrome (bg-settings-fixed-button.ts), which
 *  owns the canvas-rotation toggle — always sends the FULL field set so
 *  a partial emitter can't clobber the bridge's cached copy of the
 *  others. */
export function emitNotebookBgChange(state: DrawingState): void {
  document.dispatchEvent(new CustomEvent("notebook-bg-changed", {
    detail: {
      state,
      pattern: state.backgroundPattern,
      spacing: state.gridSpacing,
      opacity: state.gridOpacity,
      rotationEnabled: state.canvasRotationEnabled,
    },
  }));
}

export function createBgSettingsPopup(state: DrawingState): BgSettingsHandle {
  let popupOpen = false;

  const emitBgChange = () => emitNotebookBgChange(state);

  const tab = h("button", {
    title: "Background settings",
    style: {
      position: "absolute",
      width: "32px", height: "38px",
      display: "flex",
      alignItems: "center", justifyContent: "center",
      border: "none",
      borderRadius: "0 12px 12px 0",
      cursor: "pointer",
      transition: "background 0.15s",
      touchAction: "none",
      zIndex: "100",
      padding: "0",
      userSelect: "none",
    },
    children: [icon("grid", 18)],
    onClick: (e) => { e.stopPropagation(); popupOpen = !popupOpen; render(); },
  }) as HTMLButtonElement;
  tab.classList.add("notebook-tool-panel-bg-settings-tab");

  const popup = h("div", {
    style: {
      display: "none", position: "absolute",
      padding: "12px 14px", borderRadius: "8px",
      zIndex: "300", boxShadow: "0 4px 20px rgba(0,0,0,0.15)", minWidth: "200px",
      fontFamily: "var(--ui-font-family)",
    },
  });
  popup.addEventListener("pointerdown", (e) => e.stopPropagation());

  document.addEventListener("click", (e) => {
    if (!popupOpen) return;
    const t = e.target as Node;
    if (popup.contains(t) || tab.contains(t)) return;
    popupOpen = false;
    render();
  });

  let anchor: HTMLElement = tab;
  let anchorMode: "auto" | "above-right" = "auto";
  function setAnchor(el: HTMLElement | null, opts?: { mode?: "auto" | "above-right" }): void {
    anchor = el || tab;
    anchorMode = opts?.mode || "auto";
    if (popupOpen) reposition();
  }
  function toggle(): void {
    popupOpen = !popupOpen;
    render();
  }

  function reposition(): void {
    if (!popupOpen) return;
    const parent = popup.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const btnRect = anchor.getBoundingClientRect();
    if (btnRect.width === 0) return;
    popup.style.left = "auto";
    popup.style.right = "auto";
    popup.style.top = "auto";
    popup.style.bottom = "auto";
    popup.style.transform = "none";
    if (anchorMode === "above-right") {
      // Pin the popup so its right edge aligns with the anchor's right
      // edge and its bottom sits just above the anchor's top. Used by
      // the bottom-right fixed bg-settings button so the flyout opens
      // upward and stays inside the viewport.
      popup.style.right = `${parentRect.right - btnRect.right}px`;
      popup.style.bottom = `${parentRect.bottom - btnRect.top + 8}px`;
      return;
    }
    if (state.drawingToolbarVertical) {
      const centerY = btnRect.top + btnRect.height / 2 - parentRect.top;
      popup.style.top = `${centerY}px`;
      popup.style.transform = "translateY(-50%)";
      const cx = btnRect.left + btnRect.width / 2;
      if (cx < window.innerWidth / 2) {
        popup.style.left = `${btnRect.right - parentRect.left + 8}px`;
      } else {
        popup.style.right = `${parentRect.right - btnRect.left + 8}px`;
      }
    } else {
      const centerX = btnRect.left + btnRect.width / 2 - parentRect.left;
      popup.style.left = `${centerX}px`;
      popup.style.transform = "translateX(-50%)";
      const cy = btnRect.top + btnRect.height / 2;
      if (cy < window.innerHeight / 2) {
        popup.style.top = `${btnRect.bottom - parentRect.top + 8}px`;
      } else {
        popup.style.bottom = `${parentRect.bottom - btnRect.top + 8}px`;
      }
    }
  }

  function render(): void {
    refreshTheme();
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
      { label: "Dots", value: "dot-grid" },
      { label: "Grid", value: "grid" },
      { label: "Lined", value: "lined" },
      { label: "Iso", value: "isometric" },
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
          fontFamily: "inherit", fontSize: "11px", fontWeight: active ? "600" : "400",
        },
        onClick: () => { state.backgroundPattern = pat.value; state.notify("theme"); emitBgChange(); render(); },
      }));
    }
    popup.appendChild(patternRow);

    if (state.backgroundPattern !== "blank") {
      popup.appendChild(h("div", { text: "Spacing", style: labelStyle }));
      const spacingRow = h("div", { style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "10px" } });
      const spacingInput = h("input", { attrs: { type: "range", min: "10", max: "60", step: "5" }, style: { flex: "1", accentColor: theme.accent } }) as HTMLInputElement;
      spacingInput.value = String(state.gridSpacing);
      const spacingLabel = h("span", { text: `${state.gridSpacing}px`, style: { fontSize: "11px", color: theme.foreground, opacity: "0.6", minWidth: "30px", textAlign: "right" } });
      spacingInput.addEventListener("input", () => { state.gridSpacing = parseInt(spacingInput.value, 10); spacingLabel.textContent = `${state.gridSpacing}px`; state.notify("theme"); emitBgChange(); });
      spacingRow.appendChild(spacingInput);
      spacingRow.appendChild(spacingLabel);
      popup.appendChild(spacingRow);

      popup.appendChild(h("div", { text: "Opacity", style: labelStyle }));
      const opacityRow = h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } });
      const opacityInput = h("input", { attrs: { type: "range", min: "0", max: "100", step: "5" }, style: { flex: "1", accentColor: theme.accent } }) as HTMLInputElement;
      opacityInput.value = String(Math.round(state.gridOpacity * 100));
      const opacityLabel = h("span", { text: `${Math.round(state.gridOpacity * 100)}%`, style: { fontSize: "11px", color: theme.foreground, opacity: "0.6", minWidth: "30px", textAlign: "right" } });
      opacityInput.addEventListener("input", () => { state.gridOpacity = parseInt(opacityInput.value, 10) / 100; opacityLabel.textContent = `${opacityInput.value}%`; state.notify("theme"); emitBgChange(); });
      opacityRow.appendChild(opacityInput);
      opacityRow.appendChild(opacityLabel);
      popup.appendChild(opacityRow);
    }
    reposition();
  }

  function refreshTheme(): void {
    tab.style.background = "rgba(127,127,127,0.18)";
    tab.style.color = state.theme.foreground;
  }

  state.addEventListener("change", () => { refreshTheme(); if (popupOpen) render(); });
  refreshTheme();

  return { tab, popup, reposition, refreshTheme, toggle, setAnchor };
}
