/* src/notebook/drawing/tool-panel.ts
 *
 * Drawing toolbar. Sits at the bottom of the notebook, anchored to the
 * right edge of the bottom toolbar with a 10 px gap so the two pills
 * read as one combined toolbar. Always visible — there's no minimize
 * state any more, just a gray hamburger drag-tab at the right end that
 * lets the user reposition the entire combined toolbar (both pills
 * move in lockstep via `state.drawingToolbarOffset`).
 *
 * Contents (left → right):
 *   Undo | Brush 1 · Brush 2 · Brush 3 | Slice · Erase · Lasso
 * Then a separate gray pill, abutting the right edge, with a hamburger
 * icon — the drag handle.
 *
 * The lasso button exposes its own small flyout (click to activate,
 * click-again to toggle) letting the user dial in how long a held
 * stroke needs to be before it promotes into a lasso.
 */

import type { DrawingState } from "../state";
import type { DrawingLayer } from "./drawing-layer";
import type { DrawingSubTool } from "../types";
import { h } from "../ui/dom-helpers";
import { icon } from "../ui/icons";
import { createBrushSlots } from "./brush-slots";

interface SubToolDef {
  id: DrawingSubTool;
  iconName: string;
  label: string;
  shortcut: string;
}

const SUB_TOOLS: SubToolDef[] = [
  // Draw is the implicit default — clicking a brush slot returns the
  // user to Draw (that's how the user exits Slice / Erase), so no
  // dedicated Draw button is needed.
  { id: "slice",  iconName: "slice",  label: "Slice",  shortcut: "X" },
  { id: "erase",  iconName: "erase",  label: "Erase",  shortcut: "E" },
];

export interface DrawingToolPanelHandle {
  /** Pill containing the drawing tools (undo, brushes, slice/erase/lasso). */
  root: HTMLElement;
  /** Gray hamburger drag tab — visually abuts the right edge of `root`
   *  but is a separate element so its theme can diverge. */
  dragTab: HTMLElement;
  /** Gray orientation-toggle tab — mirrors the drag tab on the *other*
   *  end of the combined toolbar. Click flips between horizontal and
   *  vertical layout. */
  toggleTab: HTMLElement;
  /** Flyouts (brush edit + lasso settings). Append separately — they
   *  can extend past the pill and position themselves relative to
   *  their shared parent. */
  flyout: HTMLElement;
  /** Recompute the drawing pill's anchor position. The pill anchors
   *  to the right edge of the bottom toolbar, so a width change in
   *  the bottom toolbar (theme switch, layers panel content change,
   *  leftInset shift) needs to nudge this pill back into place. */
  relayout(): void;
}

export function createDrawingToolPanel(
  state: DrawingState,
  drawingLayer: DrawingLayer,
): DrawingToolPanelHandle {
  const container = h("div", {
    style: {
      position: "absolute",
      bottom: "calc(16px + env(safe-area-inset-bottom))",
      display: "flex",
      alignItems: "center",
      gap: "4px",
      padding: "6px 8px",
      borderRadius: "12px",
      boxShadow: "0 2px 12px rgba(0,0,0,0.12)",
      zIndex: "100",
      userSelect: "none",
      backdropFilter: "blur(8px)",
    },
  });
  container.classList.add("notebook-tool-panel");

  /** Route a sub-tool activation through the drawing engine. Clicking
   *  any drawing-engine tool (lasso / erase / slice / brush) flips
   *  state.tool to "pen" if it wasn't already and clears any active
   *  pan so the two modes don't layer. */
  function activateDrawingSubTool(sub: DrawingSubTool): void {
    if (state.isPanning) { state.isPanning = false; state.notify("isPanning"); }
    if (state.tool !== "pen") {
      state.tool = "pen";
      state.notify("tool");
      state.notify("drawingMode");
    }
    state.setDrawingSubTool(sub);
  }

  // ----- Undo (backup for the 2-finger tap gesture) ----------------

  const undoBtn = h("button", {
    title: "Undo",
    style: {
      width: "36px", height: "36px", display: "flex",
      alignItems: "center", justifyContent: "center",
      border: "none", borderRadius: "8px", cursor: "pointer",
      background: "transparent", transition: "all 0.15s",
    },
    children: [icon("undo", 20)],
    onClick: () => drawingLayer.undo(),
  }) as HTMLButtonElement;
  container.appendChild(undoBtn);

  // ----- Brush slots ------------------------------------------------

  const slots = createBrushSlots(state, drawingLayer);
  container.appendChild(slots.root);

  const separator = h("div", {
    style: { width: "1px", height: "24px", background: "currentColor", opacity: "0.15", margin: "0 4px" },
  });
  container.appendChild(separator);

  // ----- Slice / Erase sub-tools ------------------------------------

  const subToolBtns = new Map<DrawingSubTool, HTMLButtonElement>();
  for (const def of SUB_TOOLS) {
    const btn = h("button", {
      title: `${def.label} (${def.shortcut})`,
      style: {
        width: "36px", height: "36px", display: "flex",
        alignItems: "center", justifyContent: "center",
        border: "none", borderRadius: "8px", cursor: "pointer",
        background: "transparent", transition: "all 0.15s",
      },
      children: [icon(def.iconName, 20)],
      onClick: () => activateDrawingSubTool(def.id),
    }) as HTMLButtonElement;
    subToolBtns.set(def.id, btn);
    container.appendChild(btn);
  }

  // ----- Lasso button + its flyout ----------------------------------

  const lassoBtn = h("button", {
    title: "Lasso select",
    style: {
      width: "36px", height: "36px", display: "flex",
      alignItems: "center", justifyContent: "center",
      border: "none", borderRadius: "8px", cursor: "pointer",
      background: "transparent", transition: "all 0.15s",
    },
    children: [icon("lasso", 20)],
    onClick: () => {
      const alreadyActive = state.tool === "pen" && state.drawingSubTool === "select";
      if (alreadyActive) {
        if (lassoFlyoutOpen) closeLassoFlyout(); else openLassoFlyout();
        return;
      }
      activateDrawingSubTool("select");
      if (lassoFlyoutOpen) closeLassoFlyout();
    },
  });
  container.appendChild(lassoBtn);

  // ----- Hamburger drag tab (replaces the meta-tools pill) ----------
  //
  // A small gray pill abutting the right edge of the drawing toolbar.
  // Press-and-drag updates `state.drawingToolbarOffset`, which both
  // this pill *and* the bottom toolbar consume — so the combined
  // toolbar moves as one unit.

  const dragTab = h("button", {
    title: "Drag toolbar",
    style: {
      position: "absolute",
      width: "32px", height: "48px",
      display: "flex",
      alignItems: "center", justifyContent: "center",
      border: "none",
      borderRadius: "0 12px 12px 0",
      cursor: "grab",
      transition: "background 0.15s",
      touchAction: "none",
      zIndex: "100",
      padding: "0",
      userSelect: "none",
    },
    children: [icon("menu", 18)],
  }) as HTMLButtonElement;
  dragTab.classList.add("notebook-tool-panel-drag-tab");

  // ----- Orientation toggle tab -------------------------------------
  //
  // Mirrors the drag tab's gray-pill styling but lives at the *other*
  // end of the combined toolbar (left side in horizontal mode, top in
  // vertical mode). Clicking flips state.drawingToolbarVertical, which
  // re-layouts the bottom toolbar + drawing pill + both tabs.

  const toggleTab = h("button", {
    title: "Toggle orientation",
    style: {
      position: "absolute",
      width: "32px", height: "48px",
      display: "flex",
      alignItems: "center", justifyContent: "center",
      border: "none",
      borderRadius: "12px 0 0 12px",
      cursor: "pointer",
      transition: "background 0.15s",
      touchAction: "none",
      zIndex: "100",
      padding: "0",
      userSelect: "none",
    },
    children: [icon("menu", 18)],
    onClick: () => state.setDrawingToolbarVertical(!state.drawingToolbarVertical),
  }) as HTMLButtonElement;
  toggleTab.classList.add("notebook-tool-panel-toggle-tab");

  // ----- Drag-to-reposition wiring ---------------------------------

  /** Clamp a desired (x, y) offset so the combined toolbar's bbox stays
   *  inside its parent. Reads the current rendered bbox of the bottom
   *  toolbar + drag tab (which together span the assembly's full
   *  extent) and back-projects to the natural offset = 0 position so
   *  the math is independent of where the assembly currently sits. */
  function clampOffset(desiredX: number, desiredY: number): { x: number; y: number } {
    const parent = container.parentElement;
    if (!parent) return { x: desiredX, y: desiredY };
    const bottomToolbar = parent.querySelector<HTMLElement>(":scope > .notebook-toolbar");
    if (!bottomToolbar) return { x: desiredX, y: desiredY };
    const parentRect = parent.getBoundingClientRect();
    const tbRect = bottomToolbar.getBoundingClientRect();
    const dragTabRect = dragTab.getBoundingClientRect();
    const toggleTabRect = toggleTab.getBoundingClientRect();
    if (tbRect.width === 0 || dragTabRect.width === 0) return { x: desiredX, y: desiredY };
    const cur = state.drawingToolbarOffset || { x: 0, y: 0 };
    // Assembly spans from the toggle tab (far end, opposite the drag
    // tab) through the bottom toolbar, drawing pill, and drag tab.
    // Take the union so neither tab can be dragged past the parent.
    const left = Math.min(tbRect.left, dragTabRect.left, toggleTabRect.left);
    const right = Math.max(tbRect.right, dragTabRect.right, toggleTabRect.right);
    const top = Math.min(tbRect.top, dragTabRect.top, toggleTabRect.top);
    const bottom = Math.max(tbRect.bottom, dragTabRect.bottom, toggleTabRect.bottom);
    // Parent-local bounds of the assembly at offset (0, 0).
    const natLeft = (left - parentRect.left) - cur.x;
    const natRight = (right - parentRect.left) - cur.x;
    const natTop = (top - parentRect.top) - cur.y;
    const natBottom = (bottom - parentRect.top) - cur.y;
    const leftBound = state.leftInset || 0;
    let minX = leftBound - natLeft;
    let maxX = parentRect.width - natRight;
    if (minX > maxX) { const m = (minX + maxX) / 2; minX = maxX = m; }
    let minY = -natTop;
    let maxY = parentRect.height - natBottom;
    if (minY > maxY) { const m = (minY + maxY) / 2; minY = maxY = m; }
    return {
      x: Math.max(minX, Math.min(maxX, desiredX)),
      y: Math.max(minY, Math.min(maxY, desiredY)),
    };
  }

  let dragStartClient: { x: number; y: number } | null = null;
  let dragStartOffset: { x: number; y: number } = { x: 0, y: 0 };
  let dragPointerId: number | null = null;
  function onDragPointerDown(e: PointerEvent) {
    if (e.button !== undefined && e.button !== 0) return;
    dragPointerId = e.pointerId;
    dragStartClient = { x: e.clientX, y: e.clientY };
    dragStartOffset = { ...state.drawingToolbarOffset };
    try { dragTab.setPointerCapture(e.pointerId); } catch { /* noop */ }
    dragTab.style.cursor = "grabbing";
    e.preventDefault();
  }
  function onDragPointerMove(e: PointerEvent) {
    if (dragStartClient === null) return;
    if (e.pointerId !== dragPointerId) return;
    const dx = e.clientX - dragStartClient.x;
    const dy = e.clientY - dragStartClient.y;
    const clamped = clampOffset(dragStartOffset.x + dx, dragStartOffset.y + dy);
    state.setDrawingToolbarOffset(clamped.x, clamped.y);
  }
  function onDragPointerUp(e: PointerEvent) {
    if (dragStartClient === null) return;
    if (e.pointerId !== dragPointerId) return;
    try { dragTab.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    dragStartClient = null;
    dragPointerId = null;
    dragTab.style.cursor = "grab";
  }
  dragTab.addEventListener("pointerdown", onDragPointerDown);
  dragTab.addEventListener("pointermove", onDragPointerMove);
  dragTab.addEventListener("pointerup", onDragPointerUp);
  dragTab.addEventListener("pointercancel", onDragPointerUp);

  // ----- Lasso flyout (hold-duration slider) ------------------------

  let lassoFlyoutOpen = false;
  const lassoFlyout = h("div", {
    style: {
      position: "absolute",
      display: "none",
      minWidth: "220px",
      padding: "12px 14px",
      borderRadius: "12px",
      boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
      zIndex: "200",
      backdropFilter: "blur(8px)",
      userSelect: "none",
    },
  });
  lassoFlyout.addEventListener("pointerdown", (e) => e.stopPropagation());

  const lassoLabelRow = h("div", {
    style: { fontSize: "11px", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.04em", opacity: "0.7", marginBottom: "6px" },
    text: "Hold to select",
  });
  lassoFlyout.appendChild(lassoLabelRow);

  const lassoSliderRow = h("div", {
    style: { display: "grid", gridTemplateColumns: "1fr 48px", alignItems: "center", gap: "10px" },
  });
  const lassoSlider = h("input", {
    attrs: { type: "range", min: "500", max: "2000", step: "50" },
    style: { width: "100%" },
  }) as HTMLInputElement;
  lassoSlider.value = String(state.lassoHoldMs);
  const lassoReadout = h("span", {
    text: formatHoldMs(state.lassoHoldMs),
    style: { fontSize: "11px", textAlign: "right", fontVariantNumeric: "tabular-nums", opacity: "0.7" },
  });
  lassoSlider.addEventListener("input", () => {
    const ms = parseInt(lassoSlider.value, 10);
    lassoReadout.textContent = formatHoldMs(ms);
    state.setLassoHoldMs(ms);
  });
  lassoSliderRow.appendChild(lassoSlider);
  lassoSliderRow.appendChild(lassoReadout);
  lassoFlyout.appendChild(lassoSliderRow);

  function formatHoldMs(ms: number): string {
    const s = ms / 1000;
    return (Math.round(s * 10) / 10).toFixed(s === Math.round(s) ? 0 : 1) + "s";
  }

  function applyLassoFlyoutTheme(): void {
    const theme = state.theme;
    lassoFlyout.style.background = theme.uiBackground;
    lassoFlyout.style.border = `1px solid ${theme.uiBorder}`;
    lassoFlyout.style.color = theme.foreground;
  }

  function positionLassoFlyout(): void {
    const parent = lassoFlyout.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const btnRect = lassoBtn.getBoundingClientRect();
    // Reset the four anchors before re-applying the right pair so a
    // mode flip doesn't leave a stale axis pinned.
    lassoFlyout.style.left = "auto";
    lassoFlyout.style.right = "auto";
    lassoFlyout.style.top = "auto";
    lassoFlyout.style.bottom = "auto";
    if (state.drawingToolbarVertical) {
      // Vertical toolbar: flyout flies to the side, picking the side
      // farther from the nearest screen edge.
      const centerY = btnRect.top + btnRect.height / 2 - parentRect.top;
      lassoFlyout.style.top = `${centerY}px`;
      lassoFlyout.style.transform = "translateY(-50%)";
      const btnCenterX = btnRect.left + btnRect.width / 2;
      if (btnCenterX < window.innerWidth / 2) {
        lassoFlyout.style.left = `${btnRect.right - parentRect.left + 8}px`;
      } else {
        lassoFlyout.style.right = `${parentRect.right - btnRect.left + 8}px`;
      }
    } else {
      const centerX = btnRect.left + btnRect.width / 2 - parentRect.left;
      lassoFlyout.style.left = `${centerX}px`;
      lassoFlyout.style.transform = "translateX(-50%)";
      const btnCenterY = btnRect.top + btnRect.height / 2;
      if (btnCenterY < window.innerHeight / 2) {
        lassoFlyout.style.top = `${btnRect.bottom - parentRect.top + 8}px`;
      } else {
        lassoFlyout.style.bottom = `${parentRect.bottom - btnRect.top + 8}px`;
      }
    }
  }

  function openLassoFlyout(): void {
    lassoFlyoutOpen = true;
    lassoFlyout.style.display = "block";
    applyLassoFlyoutTheme();
    lassoSlider.value = String(state.lassoHoldMs);
    lassoReadout.textContent = formatHoldMs(state.lassoHoldMs);
    positionLassoFlyout();
  }
  function closeLassoFlyout(): void {
    lassoFlyoutOpen = false;
    lassoFlyout.style.display = "none";
  }

  document.addEventListener("keydown", (e) => {
    if (lassoFlyoutOpen && e.key === "Escape") closeLassoFlyout();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!lassoFlyoutOpen) return;
    const t = e.target as Node;
    if (lassoFlyout.contains(t) || lassoBtn.contains(t)) return;
    let el: HTMLElement | null = t as HTMLElement;
    while (el && el !== document.body) {
      const cls = el.classList;
      if (cls && (cls.contains("notebook-toolbar") || cls.contains("notebook-tool-panel") ||
                  cls.contains("status-bar") || cls.contains("shelf") ||
                  cls.contains("selection-toolbar"))) return;
      el = el.parentElement;
    }
    closeLassoFlyout();
  });

  // ----- Panel layout + active-state wiring -------------------------

  function updateActiveClasses(): void {
    const theme = state.theme;
    const drawing = state.tool === "pen";
    const lassoActive = drawing && state.drawingSubTool === "select";
    lassoBtn.style.color = lassoActive ? theme.accent : theme.foreground;
    lassoBtn.style.opacity = lassoActive ? "1" : "0.6";
    lassoBtn.style.background = lassoActive ? "rgba(66, 133, 244, 0.08)" : "transparent";
    for (const [id, btn] of subToolBtns) {
      const active = drawing && state.drawingSubTool === id;
      btn.style.color = active ? theme.accent : theme.foreground;
      btn.style.opacity = active ? "1" : "0.6";
      btn.style.background = active ? "rgba(66, 133, 244, 0.08)" : "transparent";
    }
    undoBtn.style.color = theme.foreground;
    undoBtn.style.opacity = "0.6";
  }

  function applyActiveSlot(): void {
    const slot = state.brushSlots[state.activeBrushSlot];
    if (slot) drawingLayer.applySlot(slot);
  }

  function applyLayout(): void {
    const parent = container.parentElement;
    if (!parent) return;
    const offset = state.drawingToolbarOffset || { x: 0, y: 0 };
    const vertical = state.drawingToolbarVertical;
    container.style.background = state.theme.uiBackground;
    container.style.color = state.theme.foreground;
    container.style.flexDirection = vertical ? "column" : "row";
    // Reset both axis anchors before re-applying — a mode flip
    // otherwise leaves a stale axis pinned.
    container.style.left = "auto";
    container.style.right = "auto";
    container.style.top = "auto";
    container.style.bottom = "auto";
    container.style.transform = "none";
    // Vertical separator → horizontal separator (and the gutter
    // margin flips axes too).
    if (vertical) {
      separator.style.width = "24px";
      separator.style.height = "1px";
      separator.style.margin = "4px 0";
    } else {
      separator.style.width = "1px";
      separator.style.height = "24px";
      separator.style.margin = "0 4px";
    }
    // Drag tab and toggle tab both pivot on orientation: in horizontal
    // they're vertical strips on either short edge; in vertical they
    // become horizontal strips at top / bottom.
    const tabSharedBg = "rgba(127,127,127,0.18)";
    if (vertical) {
      dragTab.style.width = "48px";
      dragTab.style.height = "32px";
      dragTab.style.borderRadius = "0 0 12px 12px";
      toggleTab.style.width = "48px";
      toggleTab.style.height = "32px";
      toggleTab.style.borderRadius = "12px 12px 0 0";
    } else {
      dragTab.style.width = "32px";
      dragTab.style.height = "48px";
      dragTab.style.borderRadius = "0 12px 12px 0";
      toggleTab.style.width = "32px";
      toggleTab.style.height = "48px";
      toggleTab.style.borderRadius = "12px 0 0 12px";
    }
    dragTab.style.background = tabSharedBg;
    dragTab.style.color = state.theme.foreground;
    toggleTab.style.background = tabSharedBg;
    toggleTab.style.color = state.theme.foreground;

    const place = () => {
      const bottomToolbar = parent.querySelector<HTMLElement>(":scope > .notebook-toolbar");
      const parentRect = parent.getBoundingClientRect();
      // Reset tab anchors each pass.
      dragTab.style.left = "auto";
      dragTab.style.right = "auto";
      dragTab.style.top = "auto";
      dragTab.style.bottom = "auto";
      dragTab.style.transform = "none";
      toggleTab.style.left = "auto";
      toggleTab.style.right = "auto";
      toggleTab.style.top = "auto";
      toggleTab.style.bottom = "auto";
      toggleTab.style.transform = "none";

      if (vertical) {
        // Drawing pill sits below the bottom toolbar (vertical stack).
        let topPx: number;
        if (bottomToolbar) {
          const tbRect = bottomToolbar.getBoundingClientRect();
          topPx = tbRect.bottom - parentRect.top + 10;
          container.style.left = (tbRect.left - parentRect.left) + "px";
        } else {
          topPx = parentRect.height / 2;
          container.style.left = "16px";
        }
        container.style.top = topPx + "px";
        // Toggle tab attaches to the top of the bottom toolbar.
        if (bottomToolbar) {
          const tbRect = bottomToolbar.getBoundingClientRect();
          toggleTab.style.left = (tbRect.left - parentRect.left) + "px";
          toggleTab.style.top = (tbRect.top - parentRect.top - 32) + "px";
        }
        // Drag tab attaches to the bottom of the drawing pill.
        const cRect = container.getBoundingClientRect();
        dragTab.style.left = (cRect.left - parentRect.left) + "px";
        dragTab.style.top = (cRect.bottom - parentRect.top) + "px";
      } else {
        // Drawing pill sits to the right of the bottom toolbar with
        // a 10 px gap. The bottom toolbar's own .update() pins it to
        // the user-offset bottom-center anchor.
        let leftPx: number;
        if (bottomToolbar) {
          const tbRect = bottomToolbar.getBoundingClientRect();
          leftPx = tbRect.right - parentRect.left + 10;
          container.style.bottom = `calc(16px + env(safe-area-inset-bottom) - ${offset.y}px)`;
        } else {
          leftPx = parentRect.width / 2;
          container.style.bottom = "16px";
        }
        container.style.left = leftPx + "px";
        // Toggle tab abuts the left edge of the bottom toolbar.
        if (bottomToolbar) {
          const tbRect = bottomToolbar.getBoundingClientRect();
          toggleTab.style.left = (tbRect.left - parentRect.left - 32) + "px";
          toggleTab.style.bottom = `calc(16px + env(safe-area-inset-bottom) - ${offset.y}px)`;
        }
        // Drag tab abuts the right edge of the drawing pill.
        const cRect = container.getBoundingClientRect();
        dragTab.style.left = (cRect.right - parentRect.left) + "px";
        dragTab.style.bottom = `calc(16px + env(safe-area-inset-bottom) - ${offset.y}px)`;
      }
    };
    place();
    requestAnimationFrame(() => {
      place();
      // Keep the offset inside the parent on layout changes (e.g.
      // window resize after a drag). Equal-value short-circuit in
      // setDrawingToolbarOffset prevents an infinite notify loop when
      // the offset is already in bounds.
      const cur = state.drawingToolbarOffset || { x: 0, y: 0 };
      const c = clampOffset(cur.x, cur.y);
      if (c.x !== cur.x || c.y !== cur.y) {
        state.setDrawingToolbarOffset(c.x, c.y);
      }
    });
    if (lassoFlyoutOpen) positionLassoFlyout();
  }

  state.addEventListener("change", ((e: CustomEvent) => {
    const keys: string[] = (e.detail && e.detail.keys) || [];
    if (keys.includes("theme") || keys.includes("drawingMode") ||
        keys.includes("tool") || keys.includes("drawingSubTool")) {
      applyActiveSlot();
      drawingLayer.setTool(state.drawingSubTool);
    }
    if (keys.includes("activeBrushSlot") || keys.includes("brushSlots")) {
      applyActiveSlot();
    }
    if (lassoFlyoutOpen) {
      const lassoLive = state.tool === "pen" && state.drawingSubTool === "select";
      if (!lassoLive) closeLassoFlyout();
    }
    updateActiveClasses();
    applyLayout();
  }) as EventListener);

  updateActiveClasses();
  applyLayout();
  applyActiveSlot();
  drawingLayer.setTool(state.drawingSubTool);

  const flyoutGroup = h("div", { style: { position: "relative" } });
  flyoutGroup.appendChild(slots.flyout);
  flyoutGroup.appendChild(slots.miniPalette);
  flyoutGroup.appendChild(lassoFlyout);

  return { root: container, dragTab, toggleTab, flyout: flyoutGroup, relayout: applyLayout };
}
