/* src/notebook/ui/bg-settings-fixed-button.ts
 *
 * Fixed canvas-surface chrome — bottom-right corner of the notebook
 * container, just inboard of the shelf. A row of three pieces, right
 * to left:
 *
 *   [rotation °] [rotate toggle] [page rail toggle] [background settings]
 *
 * - Background settings opens the pattern / spacing / opacity popup
 *   (reused from `bg-settings-popup.ts`; its internal tab stays
 *   detached — we call `bg.toggle()` and anchor the popup against the
 *   visible button).
 * - The rotate toggle (icon-only) flips `state.canvasRotationEnabled`
 *   — the two-finger canvas-rotation gesture opt-in. Enabled state
 *   reads as an accent-tinted icon + border.
 * - The rotation readout shows the camera's current rotation in
 *   degrees while the option is on; tapping it snaps the rotation
 *   back to 0. Hidden while the option is off (rotation is forced to
 *   0 there anyway).
 * - The page rail toggle shows / hides a proofread notebook's page
 *   rail (`proof-thumbnails.ts`). Only rendered on a proof — nothing
 *   else has a rail — and it sits here because the rail's own foot
 *   already clears this row, so the control is beside the thing it
 *   controls.
 *
 * This row replaced the bottom toolbar's end-cap so the surface
 * controls are always reachable wherever the toolbar happens to sit.
 */

import type { DrawingState } from "../state";
import { h } from "./dom-helpers";
// @ts-ignore — sibling JS module
import { applyTooltip } from "../../tooltips.js";
import { icon } from "./icons";
import { createBgSettingsPopup, emitNotebookBgChange } from "./bg-settings-popup";

export interface BgSettingsFixedHandle {
  /** Visible chrome row. Append to the notebook container. */
  button: HTMLElement;
  /** Popup element. Append to the same parent so it positions against
   *  the button. */
  popup: HTMLElement;
  /** Reposition the popup against the button. */
  reposition(): void;
}

export function createBgSettingsFixedButton(state: DrawingState): BgSettingsFixedHandle {
  const bg = createBgSettingsPopup(state);

  // Row wrapper — carries the absolute positioning that used to live
  // on the lone button; children lay out right-to-left ending with the
  // bg button so the corner anchor stays where it always was.
  const wrap = h("div", {
    style: {
      position: "absolute",
      // 9px lands the 40px row's vertical centre level with the
      // sidebar's Add / Settings footer buttons and the command-palette
      // pill (their centres sit ~29px above the window bottom).
      bottom: "9px",
      display: "flex",
      alignItems: "center",
      gap: "8px",
      zIndex: "120",
    },
  });

  const cornerBtnStyle: Partial<CSSStyleDeclaration> = {
    width: "40px",
    height: "40px",
    borderRadius: "10px",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "background 0.15s, border-color 0.15s, color 0.15s, opacity 0.15s",
    backdropFilter: "blur(6px)",
    padding: "0",
  };

  // --- rotation readout (leftmost) ---------------------------------
  const rotationReadout = h("button", {
    title: "Reset rotation",
    style: {
      display: "none",
      height: "26px",
      padding: "0 10px",
      borderRadius: "999px",
      cursor: "pointer",
      font: "500 11px/1 var(--ui-font-family, system-ui, sans-serif)",
      fontVariantNumeric: "tabular-nums",
      transition: "background 0.15s, border-color 0.15s",
      backdropFilter: "blur(6px)",
    },
    onClick: (e) => {
      e.stopPropagation();
      if ((state.camera.rotation || 0) === 0) return;
      state.camera = { ...state.camera, rotation: 0 };
      state.notify("camera");
    },
  });

  // --- rotate toggle ------------------------------------------------
  const rotateBtn = h("button", {
    title: "Rotate canvas with two-finger pan/zoom",
    style: { ...cornerBtnStyle },
    children: [icon("rotate", 20)],
    onClick: (e) => {
      e.stopPropagation();
      state.setCanvasRotationEnabled(!state.canvasRotationEnabled);
      // Persist per-notebook alongside the other bg-surface fields.
      emitNotebookBgChange(state);
    },
  });
  rotateBtn.classList.add("notebook-rotate-toggle-btn");

  // --- page rail toggle (proofread notebooks only) ------------------
  // The rail is an app-wide reading preference, so it rides settings
  // rather than the notebook's own bg-surface fields. Sibling windows
  // pick it up through the ordinary settings broadcast; this canvas
  // repaints off the `interaction` pulse below, which is repaint-only
  // and so can't mark the notebook dirty.
  const railBtn = h("button", {
    title: "Show page rail",
    style: { ...cornerBtnStyle, display: "none" },
    children: [icon("page-rail", 20)],
    onClick: (e) => {
      e.stopPropagation();
      const app = hushApp();
      app?.updateSettings?.({ notebookProofRailVisible: !railVisible() });
      state.notify("interaction");
      refreshRail();
    },
  });
  railBtn.classList.add("notebook-proof-rail-toggle-btn");

  // --- background settings (rightmost, the corner anchor) -----------
  const button = h("button", {
    title: "Background settings",
    style: { ...cornerBtnStyle },
    children: [icon("grid", 20)],
    onClick: (e) => { e.stopPropagation(); bg.toggle(); },
  });
  button.classList.add("notebook-bg-settings-fixed-btn");

  wrap.appendChild(rotationReadout);
  wrap.appendChild(rotateBtn);
  wrap.appendChild(railBtn);
  wrap.appendChild(button);

  // Anchor the popup against the visible bg button — the row sits in
  // the bottom-right corner, so use the above-right mode so the flyout
  // opens upward and aligns with the button's right edge.
  bg.setAnchor(button, { mode: "above-right" });

  function hushApp() {
    return (window as unknown as {
      __hushState__?: {
        settings?: { notebookProofRailVisible?: boolean };
        updateSettings?: (p: Record<string, unknown>) => void;
      };
    }).__hushState__;
  }

  function railVisible(): boolean {
    return hushApp()?.settings?.notebookProofRailVisible !== false;
  }

  /** Show the toggle only on a proof, and paint it the way the rotate
   *  toggle paints itself: accent icon + accent border while on. Runs
   *  off the same per-notify listener as everything else here, so it
   *  keys on its own visible state to skip the style writes — a proof
   *  is panned as much as any other canvas. */
  let _lastRailKey = "";
  function refreshRail(force?: boolean): void {
    const isProof = !!state.proof;
    const on = railVisible();
    const theme = state.theme;
    const key = `${isProof}:${on}:${theme.accent}:${theme.foreground}`;
    if (!force && key === _lastRailKey) return;
    _lastRailKey = key;
    railBtn.style.display = isProof ? "flex" : "none";
    if (!isProof) return;
    applyTooltip(railBtn, on ? "Hide page rail" : "Show page rail");
    railBtn.style.color = on ? theme.accent : theme.foreground;
    railBtn.style.opacity = on ? "1" : "0.6";
    railBtn.style.border = `1px solid ${on ? theme.accent : theme.uiBorder}`;
    railBtn.style.background = theme.background;
  }

  /** Camera rotation, normalized to (-180, 180] whole degrees. The
   *  gesture accumulates rotation across twists, so the raw radians
   *  can wind past ±π. */
  function rotationDegrees(): number {
    const rot = state.camera.rotation || 0;
    let deg = Math.round((rot * 180) / Math.PI) % 360;
    if (deg > 180) deg -= 360;
    if (deg <= -180) deg += 360;
    return deg;
  }

  // Runs on every camera notify (~per pan frame), so skip the DOM work
  // unless the visible state actually changed. `_lastKey` folds the
  // toggle + degrees into one comparison; theme refreshes reset it so
  // the accent colours re-apply.
  let _lastKey = "";
  function refreshRotation(force?: boolean): void {
    const enabled = state.canvasRotationEnabled;
    const deg = enabled ? rotationDegrees() : 0;
    const key = `${enabled}:${deg}`;
    if (!force && key === _lastKey) return;
    _lastKey = key;
    rotationReadout.style.display = enabled ? "flex" : "none";
    rotationReadout.style.alignItems = "center";
    rotationReadout.textContent = `${deg}°`;
    const theme = state.theme;
    // Enabled toggle reads as accent icon + accent border; disabled
    // matches the bg button's neutral treatment at reduced strength.
    rotateBtn.style.color = enabled ? theme.accent : theme.foreground;
    rotateBtn.style.opacity = enabled ? "1" : "0.6";
    rotateBtn.style.border = `1px solid ${enabled ? theme.accent : theme.uiBorder}`;
  }

  function refresh() {
    const theme = state.theme;
    button.style.color = theme.foreground;
    // Track the notebook's actual background colour so the row reads
    // as part of the canvas surface (matching what the user just set in
    // bg settings), with a subtle outline mirroring the sidebar / shelf
    // border so the buttons still distinguish themselves from blank
    // canvas.
    button.style.background = theme.background;
    button.style.border = `1px solid ${theme.uiBorder}`;
    rotateBtn.style.background = theme.background;
    refreshRail(true);
    rotationReadout.style.background = theme.background;
    rotationReadout.style.border = `1px solid ${theme.uiBorder}`;
    rotationReadout.style.color = theme.foreground;
    refreshRotation(true);
  }

  // Gap mirrors the minimap's SHELF_GAP_PX so the spacing between the
  // shelf edge, button, and minimap reads evenly.
  const SHELF_GAP = 10;

  function applyRightInset() {
    // state.rightInset already measures the shelf's left edge against
    // the container's right edge — so when a right-docked pane shifts
    // the shelf left, this picks up the extended distance and the
    // row stays just inboard of the shelf without double counting.
    const ri = state.rightInset || 0;
    // The window's safe-area band is the window form's business; a
    // pane's edges are interior (see `shelf-panel.ts#applyPlacement`).
    const safeRight = state.paneHosted ? "0px" : "env(safe-area-inset-right)";
    const container = wrap.parentElement;
    const minimap = container ? container.querySelector(".notebook-minimap") : null;
    if (minimap && container) {
      // Minimap is visible: sit 10px inboard of the shelf edge (same as
      // the minimap) and stack directly above the minimap with a 10px gap.
      wrap.style.right = `calc(${safeRight} + ${ri + SHELF_GAP}px)`;
      const mmRect = minimap.getBoundingClientRect();
      const cRect = container.getBoundingClientRect();
      wrap.style.bottom = `${Math.round(cRect.bottom - mmRect.top + SHELF_GAP)}px`;
    } else {
      // No minimap: park in the bottom-right corner just inboard of the
      // shelf, centres level with the sidebar footer buttons.
      wrap.style.right = `calc(${safeRight} + ${ri + 16}px)`;
      wrap.style.bottom = "9px";
    }
    bg.reposition();
  }

  // Single listener — theme, inset, rotation state, and live camera
  // rotation all funnel through the state change event.
  state.addEventListener("change", ((e: CustomEvent) => {
    const keys: string[] = (e.detail && e.detail.keys) || [];
    if (keys.includes("theme")) {
      refresh();
      applyRightInset();
    }
    if (keys.includes("canvasRotationEnabled") || keys.includes("camera")) {
      refreshRotation();
    }
    // A notebook only becomes a proof when its envelope lands, and the
    // rail toggle rides a setting no canvas key names — so this one is
    // re-derived on every notify and guarded by its own key instead.
    refreshRail();
  }) as EventListener);

  window.addEventListener("resize", applyRightInset);
  // Minimap mount / unmount restacks the row above (or away from) it.
  // Self-removing once the row is detached so stale rows don't pile
  // up listeners across notebook re-mounts.
  const onMinimapChange = () => {
    if (!wrap.isConnected) {
      document.removeEventListener("notebook-minimap-changed", onMinimapChange);
      return;
    }
    applyRightInset();
  };
  document.addEventListener("notebook-minimap-changed", onMinimapChange);

  refresh();
  applyRightInset();
  // Re-run once mounted: at construction the row isn't in the DOM yet, so
  // it can't see a minimap that was already mounted (e.g. minimap-on-by-
  // default). A deferred pass picks it up and stacks correctly.
  requestAnimationFrame(applyRightInset);

  return { button: wrap, popup: bg.popup, reposition: bg.reposition };
}
