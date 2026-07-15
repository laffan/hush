import type { DrawingState } from "../state";
import type { DragAreaShape } from "../types";
import type { DrawingLayer } from "../drawing/drawing-layer-types";
import { canvasToScreen, computePocketLayout, getShapeBounds } from "../utils";
import { rasterizeSelectionToImage, recognizeSelection, canRecognizeSelection } from "../selection-raster";
import { isHandwritingRecognitionAvailable } from "../../recognition/handwriting";
import { flashRecognitionNotice, describeRecognitionError } from "../../recognition/recognition-ui";
import { h, clearChildren } from "./dom-helpers";
import { icon } from "./icons";
import { makeColorsMenu } from "./selection-colors-menu";

/** Accessors the toolbar needs from the owning NotesCanvas for the
 *  raster-backed actions (Rasterize group, Recognize handwriting).
 *  Optional so standalone mounts without a drawing layer still work. */
export interface SelectionRasterAccess {
  getImageCache(): Map<string, HTMLImageElement>;
  getDrawingLayer(): DrawingLayer | null;
}

export function createSelectionToolbar(state: DrawingState, access?: SelectionRasterAccess): HTMLElement {
  const container = h("div", {
    // Sit above canvas content (shapes, strokes, drag-areas) so the
    // selection chrome never reads as part of the artwork below it.
    // Still below the files sidebar overlay so popping the sidebar
    // doesn't get masked by the toolbar.
    style: {
      position: "absolute", display: "none", gap: "2px", zIndex: "200",
      pointerEvents: "auto",
      padding: "4px", borderRadius: "8px",
      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
    },
  });

  type PopupType = "colors" | "size" | "align" | "arrange";
  let activePopup: PopupType | null = null;
  let popupEl: HTMLElement | null = null;
  let popupWrapper: HTMLElement | null = null;
  let isRenamingImage = false;
  // Last grid-column count chosen per drag-area, so the flyout
  // re-opens with the user's last value instead of snapping back to
  // the as-square-as-possible default. Cleared lazily — entries for
  // deleted drag-areas just stay until the toolbar is rebuilt.
  const lastGridCols = new Map<string, number>();
  function closePopup() {
    if (popupEl) { popupEl.remove(); popupEl = null; }
    activePopup = null;
    popupWrapper = null;
  }
  function makeIconBtn(iconName: string, title: string, onClick: () => void): HTMLButtonElement {
    const theme = state.theme;
    return h("button", {
      title,
      style: { width: "28px", height: "28px", border: "none", borderRadius: "6px", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: theme.foreground },
      children: [icon(iconName, 18)],
      onClick,
    });
  }

  /** Count grid units inside a drag-area (one per ungrouped child + one per groupId). */
  function countDragAreaUnits(dragAreaId: string): number {
    const groupIds = new Set<string>();
    let ungrouped = 0;
    for (const s of state.shapes) {
      if (s.parentId !== dragAreaId) continue;
      if (s.groupId) groupIds.add(s.groupId);
      else ungrouped++;
    }
    return ungrouped + groupIds.size;
  }

  function makeStepperPanel(opts: {
    current: number;
    min: number;
    max: number;
    step: number;
    format: (n: number) => string;
    labelMinWidth: string;
    onChange: (value: number) => void;
  }): HTMLElement {
    const { min, max, step, format, labelMinWidth, onChange } = opts;
    const theme = state.theme;
    const panel = h("div", {
      style: { position: "absolute", top: "-44px", left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: "4px", padding: "4px 6px", background: theme.uiBackground, borderRadius: "8px", boxShadow: "0 2px 8px rgba(0,0,0,0.15)", border: `1px solid ${theme.uiBorder}`, zIndex: "300", whiteSpace: "nowrap" },
    });
    const muted = theme.variant === "dark" ? "rgba(255,255,255,0.5)" : "#666";
    const label = h("span", { text: format(opts.current), style: { fontSize: "11px", color: muted, minWidth: labelMinWidth, textAlign: "center" } });
    let value = opts.current;
    function makeStep(symbol: string, delta: number): HTMLElement {
      const btn = h("button", {
        text: symbol,
        style: {
          width: "26px", height: "26px", display: "inline-flex", alignItems: "center", justifyContent: "center",
          background: "transparent", color: theme.foreground, border: `1px solid ${theme.uiBorder}`,
          borderRadius: "6px", cursor: "pointer", fontSize: "14px", fontWeight: "600", lineHeight: "1", padding: "0",
        },
      });
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const next = Math.max(min, Math.min(max, value + delta));
        if (next === value) return;
        value = next;
        label.textContent = format(value);
        onChange(value);
      });
      return btn;
    }
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    panel.appendChild(makeStep("−", -step));
    panel.appendChild(label);
    panel.appendChild(makeStep("+", step));
    return panel;
  }

  function makeSizeStepper(currentSize: number, onChange: (size: number) => void): HTMLElement {
    return makeStepperPanel({
      current: currentSize, min: 6, max: 30, step: 1,
      format: (n) => `${n}px`, labelMinWidth: "32px", onChange,
    });
  }

  // Close popup on click outside
  document.addEventListener("pointerdown", (e) => {
    if (!popupEl || !activePopup) return;
    const target = e.target as HTMLElement;
    if (popupEl.contains(target)) return;
    if (popupWrapper?.contains(target)) return;
    closePopup();
  });

  // Close popup on Escape
  document.addEventListener("keydown", (e) => {
    if (!popupEl || !activePopup) return;
    if (e.key === "Escape") { closePopup(); }
  });

  function makeAlignMenu(state: DrawingState): HTMLElement {
    const theme = state.theme;
    const btnStyle: Partial<CSSStyleDeclaration> = {
      width: "26px", height: "26px", border: "none", borderRadius: "4px",
      background: "transparent", cursor: "pointer",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "0", color: theme.foreground,
    };
    const items: { iconName: string; title: string; action: () => void }[] = [
      { iconName: "align-left", title: "Align left", action: () => state.alignSelected("left") },
      { iconName: "align-vertical-spacing", title: "Distribute vertically", action: () => state.distributeSelected("vertical") },
      { iconName: "align-top", title: "Align top", action: () => state.alignSelected("top") },
      { iconName: "align-bottom", title: "Align bottom", action: () => state.alignSelected("bottom") },
      { iconName: "align-right", title: "Align right", action: () => state.alignSelected("right") },
      { iconName: "align-horizontal-spacing", title: "Distribute horizontally", action: () => state.distributeSelected("horizontal") },
    ];
    const panel = h("div", {
      style: { position: "absolute", top: "-40px", left: "50%", transform: "translateX(-50%)", display: "flex", gap: "2px", padding: "4px 6px", background: theme.uiBackground, borderRadius: "8px", boxShadow: "0 2px 8px rgba(0,0,0,0.15)", border: `1px solid ${theme.uiBorder}`, zIndex: "300" },
      children: items.map((it) => {
        const btn = h("button", { title: it.title, style: { ...btnStyle }, onClick: it.action });
        btn.appendChild(icon(it.iconName, 18));
        return btn;
      }),
    });
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    return panel;
  }

  /** Arrangement flyout for a single selected drag-area. Gathers the
   *  container-layout actions — arrange-as-grid (with its column
   *  stepper inline) and the two reorder modes — into one popup so
   *  they stop crowding the toolbar (mirrors the Colors popup
   *  pattern). Sticky like Colors: state changes rebuild the toolbar
   *  and the saved-popup logic reopens it with fresh active states. */
  function makeArrangeMenu(dragArea: DragAreaShape): HTMLElement {
    const theme = state.theme;
    const muted = theme.variant === "dark" ? "rgba(255,255,255,0.5)" : "#666";
    const rowBtnStyle: Partial<CSSStyleDeclaration> = {
      width: "26px", height: "26px", border: "none", borderRadius: "4px",
      background: "transparent", cursor: "pointer",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "0", color: theme.foreground,
    };
    const panel = h("div", {
      style: {
        position: "absolute", top: "-84px", left: "50%", transform: "translateX(-50%)",
        display: "flex", flexDirection: "column", gap: "4px", padding: "6px 8px",
        background: theme.uiBackground, borderRadius: "8px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.15)", border: `1px solid ${theme.uiBorder}`,
        zIndex: "300", whiteSpace: "nowrap",
      },
    });
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());

    const rowLabel = (text: string) => h("span", {
      text,
      style: { fontSize: "11px", color: muted, minWidth: "48px", lineHeight: "26px" },
    });

    // Grid row — apply + column stepper inline.
    const n = countDragAreaUnits(dragArea.id);
    const gridRow = h("div", { style: { display: "flex", alignItems: "center", gap: "4px" } });
    gridRow.appendChild(rowLabel("Grid"));
    if (n < 2) {
      gridRow.appendChild(h("span", { text: "needs 2+ items", style: { fontSize: "11px", color: muted, lineHeight: "26px" } }));
    } else {
      let cols = Math.max(1, Math.min(n, lastGridCols.get(dragArea.id) ?? Math.ceil(Math.sqrt(n))));
      const applyGrid = () => {
        lastGridCols.set(dragArea.id, cols);
        state.arrangeDragAreaAsGrid(dragArea.id, cols);
      };
      const gridBtn = h("button", { title: "Arrange children as grid", style: { ...rowBtnStyle }, onClick: applyGrid });
      gridBtn.appendChild(icon("grid-mode", 18));
      const colsLabel = h("span", { text: `${cols} cols`, style: { fontSize: "11px", color: muted, minWidth: "44px", textAlign: "center" } });
      const makeStep = (symbol: string, delta: number) => {
        const btn = h("button", {
          text: symbol,
          style: {
            width: "26px", height: "26px", display: "inline-flex", alignItems: "center", justifyContent: "center",
            background: "transparent", color: theme.foreground, border: `1px solid ${theme.uiBorder}`,
            borderRadius: "6px", cursor: "pointer", fontSize: "14px", fontWeight: "600", lineHeight: "1", padding: "0",
          },
        });
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const next = Math.max(1, Math.min(n, cols + delta));
          if (next === cols) return;
          cols = next;
          colsLabel.textContent = `${cols} cols`;
          applyGrid();
        });
        return btn;
      };
      gridRow.appendChild(gridBtn);
      gridRow.appendChild(makeStep("−", -1));
      gridRow.appendChild(colsLabel);
      gridRow.appendChild(makeStep("+", 1));
    }
    panel.appendChild(gridRow);

    // Reorder row — swap / ripple mode toggles.
    const reorderRow = h("div", { style: { display: "flex", alignItems: "center", gap: "4px" } });
    reorderRow.appendChild(rowLabel("Reorder"));
    const swapActive = state.reorderDragAreaId === dragArea.id && state.reorderMode === "swap";
    const swapBtn = h("button", {
      title: swapActive ? "Exit swap-reorder mode" : "Swap-reorder children (drop swaps two items)",
      style: { ...rowBtnStyle },
      onClick: () => state.toggleReorderMode(dragArea.id, "swap"),
    });
    swapBtn.appendChild(icon("item-swap", 18));
    if (swapActive) { swapBtn.style.background = theme.accent; swapBtn.style.color = "#fff"; }
    const rippleActive = state.reorderDragAreaId === dragArea.id && state.reorderMode === "ripple";
    const rippleBtn = h("button", {
      title: rippleActive ? "Exit ripple-reorder mode" : "Ripple-reorder children (drop inserts at target slot)",
      style: { ...rowBtnStyle },
      onClick: () => state.toggleReorderMode(dragArea.id, "ripple"),
    });
    rippleBtn.appendChild(icon("item-reorder", 18));
    if (rippleActive) { rippleBtn.style.background = theme.accent; rippleBtn.style.color = "#fff"; }
    reorderRow.appendChild(swapBtn);
    reorderRow.appendChild(rippleBtn);
    panel.appendChild(reorderRow);

    return panel;
  }

  // ----- raster-backed actions (Rasterize group / Recognize handwriting) -----
  // Logic lives in selection-raster.ts; the toolbar only owns the
  // button and the in-flight dimming for the async recognize path.
  let recognizeBusy = false;
  async function runRecognize(btn: HTMLButtonElement): Promise<void> {
    if (!access || recognizeBusy) return;
    recognizeBusy = true;
    btn.style.opacity = "0.4";
    btn.style.pointerEvents = "none";
    try {
      await recognizeSelection({
        state, imageCache: access.getImageCache(), drawingLayer: access.getDrawingLayer(),
      });
    } catch (err) {
      console.error("[hush] Handwriting recognition failed:", err);
      flashRecognitionNotice(describeRecognitionError(err));
    } finally {
      recognizeBusy = false;
      btn.style.opacity = "";
      btn.style.pointerEvents = "";
    }
  }

  function togglePopup(type: PopupType, wrapper: HTMLElement, create: () => HTMLElement) {
    if (activePopup === type) { closePopup(); return; }
    closePopup();
    popupEl = create();
    popupWrapper = wrapper;
    activePopup = type;
    wrapper.appendChild(popupEl);
  }

  function update() {
    if (isRenamingImage) return;
    const savedPopup = activePopup;
    clearChildren(container);
    popupEl = null;
    popupWrapper = null;
    activePopup = null;

    if (state.selectedIds.size === 0) {
      container.style.display = "none";
      return;
    }

    // While the drawing engine is mid-transform (move / resize /
    // rotate from its own bbox grab), step out of the way — the
    // engine's chrome is tracking the gesture and a stale toolbar
    // anchored to the pre-drag bounds is just visual noise. Pops
    // back at the committed position on release.
    if (state.strokeEngineDragging) { container.style.display = "none"; return; }

    const selected = state.shapes.filter((s) => state.selectedIds.has(s.id));
    if (selected.length === 0) { container.style.display = "none"; return; }

    const allPocketed = selected.every((s) => s.pocketed);
    if (allPocketed) { container.style.display = "none"; return; }

    const pocketLayout = computePocketLayout(state.shapes, state.canvasWidth, state.fontFamily, state.pocketRightInset);
    const pocketScreenMap = new Map<string, { minX: number; minY: number }>();
    for (const entry of pocketLayout.entries) {
      for (const s of entry.shapes) {
        pocketScreenMap.set(s.id, { minX: entry.screenBounds.minX, minY: entry.screenBounds.minY });
      }
    }
    const allSelectedPocketed = selected.every((s) => pocketLayout.pocketedIds.has(s.id));

    let screenMinX: number, screenMinY: number;
    if (allSelectedPocketed) {
      screenMinX = Infinity; screenMinY = Infinity;
      for (const s of selected) {
        const sb = pocketScreenMap.get(s.id);
        if (sb) { screenMinX = Math.min(screenMinX, sb.minX); screenMinY = Math.min(screenMinY, sb.minY); }
      }
    } else {
      let minX = Infinity, minY = Infinity;
      for (const s of selected) {
        if (pocketLayout.pocketedIds.has(s.id)) continue;
        const b = getShapeBounds(s);
        if (b.minX < minX) minX = b.minX;
        if (b.minY < minY) minY = b.minY;
      }
      const topLeft = canvasToScreen({ x: minX, y: minY }, state.camera);
      // Offset by selection highlight padding (6 canvas units) to align with the
      // dashed selection box drawn in the renderer
      const selPad = 6 * state.camera.zoom;
      screenMinX = topLeft.x - selPad;
      screenMinY = topLeft.y - selPad;
    }

    container.style.display = "flex";
    // Paint the notebook's own background under the buttons so the
    // toolbar reads as floating chrome rather than letting the shapes
    // and grid bleed through between the icons.
    container.style.background = state.theme.canvasBackground || state.theme.uiBackground;
    container.style.left = (screenMinX - 7) + "px";
    container.style.top = (screenMinY - 44) + "px";

    const hasText = selected.some((s) => s.type === "text");
    const hasImage = selected.some((s) => s.type === "image");
    const hasColorable = selected.some((s) => s.type === "text");
    const hasBgable = selected.some((s) => s.type === "text" || s.type === "drag-area");
    const multiSelect = selected.length > 1;

    if (multiSelect) {
      const wrapper = h("div", { style: { position: "relative" } });
      wrapper.appendChild(makeIconBtn("align", "Align / Distribute", () => {
        togglePopup("align", wrapper, () => makeAlignMenu(state));
      }));
      container.appendChild(wrapper);
      if (savedPopup === "align") togglePopup("align", wrapper, () => makeAlignMenu(state));

      // Group / Ungroup. Show Ungroup when every selected shape already
      // shares a single groupId (so the whole selection *is* one group);
      // otherwise show Group to bind the selection together.
      const firstGroupId = selected[0].groupId;
      const allSameGroup = !!firstGroupId && selected.every((s) => s.groupId === firstGroupId);
      if (allSameGroup) {
        container.appendChild(makeIconBtn("ungroup", "Ungroup", () => state.ungroupSelected()));
      } else {
        container.appendChild(makeIconBtn("group", "Group", () => state.groupSelected()));
      }
    }
    // Recognize handwriting — one button, two engines under the hood:
    // strokes go to Google's stroke-based ML Kit recognizer (iPad
    // only), images (e.g. a rasterized stroke group) to Apple's
    // Vision raster path. Hidden when neither engine can serve the
    // selection (a strokes-only selection on desktop, in particular).
    if (access && isHandwritingRecognitionAvailable() && canRecognizeSelection(state)) {
      const btn = makeIconBtn("recognize-text", "Recognize handwriting", () => {
        void runRecognize(btn);
      });
      if (recognizeBusy) { btn.style.opacity = "0.4"; btn.style.pointerEvents = "none"; }
      container.appendChild(btn);
    }

    if (hasImage && selected.length === 1) {
      const isCropping = state.croppingImageId === selected[0].id;
      container.appendChild(makeIconBtn("crop", isCropping ? "Finish crop" : "Crop image", () => {
        if (isCropping) state.stopCropping();
        else state.startCropping(selected[0].id);
      }));
    }

    if (hasColorable || hasBgable) {
      const wrapper = h("div", { style: { position: "relative" } });
      const reopen = () => {
        closePopup();
        popupEl = makeColorsMenu(state, reopen, { hasColorable, hasBgable, hasText });
        popupWrapper = wrapper;
        activePopup = "colors";
        wrapper.appendChild(popupEl);
      };
      wrapper.appendChild(makeIconBtn("text-color", "Colors", () => {
        if (activePopup === "colors") { closePopup(); return; }
        reopen();
      }));
      container.appendChild(wrapper);
      if (savedPopup === "colors") reopen();
    }

    if (hasText) {
      const wrapper = h("div", { style: { position: "relative" } });
      wrapper.appendChild(makeIconBtn("text-size", "Text size", () => {
        const textShape = selected.find((s) => s.type === "text");
        const currentSize = textShape && textShape.type === "text" ? textShape.fontSize : state.fontSize;
        togglePopup("size", wrapper, () => makeSizeStepper(currentSize, (size) => {
          state.changeSelectedFontSize(size);
        }));
      }));
      container.appendChild(wrapper);
      if (savedPopup === "size") {
        const textShape = selected.find((s) => s.type === "text");
        const currentSize = textShape && textShape.type === "text" ? textShape.fontSize : state.fontSize;
        togglePopup("size", wrapper, () => makeSizeStepper(currentSize, (size) => {
          state.changeSelectedFontSize(size);
        }));
      }
    }

    // Tidy: re-layout the flowchart subtree under any selected text node
    // that has children. Mirrors steiner — root anchored, descendants
    // stacked so siblings don't overlap.
    const tidyableIds = selected
      .filter((s) => s.type === "text" && state.flowchart.childrenOf(s.id).length > 0)
      .map((s) => s.id);
    if (tidyableIds.length > 0) {
      container.appendChild(makeIconBtn("tidy", "Tidy subtree", () => {
        for (const id of tidyableIds) state.tidySubtree(id);
      }));
    }

    // Drag-area-only actions. Pinning keeps the box screen-anchored
    // while the canvas scrolls beneath it; the arrangement features
    // (grid layout + the two reorder modes) live together in one
    // flyout so they stop crowding the toolbar.
    if (selected.length === 1 && selected[0].type === "drag-area") {
      const dragArea = selected[0] as DragAreaShape;

      const pinBtn = makeIconBtn("pin", dragArea.pinned ? "Unpin" : "Pin (canvas scrolls beneath)", () => {
        state.togglePinDragArea(dragArea.id);
      });
      if (dragArea.pinned) {
        pinBtn.style.background = state.theme.accent;
        pinBtn.style.color = "#fff";
      }
      container.appendChild(pinBtn);

      const arrangeWrapper = h("div", { style: { position: "relative" } });
      arrangeWrapper.appendChild(makeIconBtn("grid-mode", "Arrange children (grid / reorder)", () => {
        togglePopup("arrange", arrangeWrapper, () => makeArrangeMenu(dragArea));
      }));
      container.appendChild(arrangeWrapper);
      if (savedPopup === "arrange") togglePopup("arrange", arrangeWrapper, () => makeArrangeMenu(dragArea));
    }

    // Rasterize: bake the whole selection (groups, drag-areas with
    // their contents, mixed shapes) into a single image. Pointless for
    // a lone image shape, so it's hidden there. Sits at the end of the
    // feature icons, right before Delete, for every object type.
    if (access && !(selected.length === 1 && selected[0].type === "image")) {
      container.appendChild(makeIconBtn("rasterize", "Rasterize as image", () => {
        rasterizeSelectionToImage({
          state, imageCache: access.getImageCache(), drawingLayer: access.getDrawingLayer(),
        });
      }));
    }

    container.appendChild(makeIconBtn("trash", "Delete", () => state.deleteSelected()));

    // Inline image rename
    if (hasImage && selected.length === 1 && selected[0].type === "image") {
      const imgShape = selected[0];
      const fullName = imgShape.name || "";
      const dotIdx = fullName.lastIndexOf(".");
      const baseName = dotIdx > 0 ? fullName.substring(0, dotIdx) : fullName;
      const ext = dotIdx > 0 ? fullName.substring(dotIdx) : "";

      const theme = state.theme;
      const nameEl = h("span", {
        text: baseName,
        style: { fontSize: "14px", color: theme.foreground, cursor: "pointer", whiteSpace: "nowrap", marginLeft: "4px", lineHeight: "28px" },
      });

      let committed = false;
      function commitRename() {
        if (committed) return;
        committed = true;
        isRenamingImage = false;
        nameEl.removeAttribute("contenteditable");
        nameEl.style.color = theme.foreground;
        nameEl.style.outline = "none";
        nameEl.style.minWidth = "";
        nameEl.removeEventListener("blur", commitRename);
        const newBase = (nameEl.textContent || "").trim();
        if (newBase && newBase !== baseName) {
          state.renameImage(imgShape.id, newBase + ext);
        }
      }

      nameEl.addEventListener("click", (e) => {
        e.stopPropagation();
        if (nameEl.getAttribute("contenteditable") === "true") return;
        committed = false;
        isRenamingImage = true;
        nameEl.setAttribute("contenteditable", "true");
        nameEl.style.color = theme.accent;
        nameEl.style.outline = "none";
        nameEl.style.minWidth = "40px";
        nameEl.focus();
        const range = document.createRange();
        range.selectNodeContents(nameEl);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      });
      nameEl.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); commitRename(); }
      });
      nameEl.addEventListener("blur", commitRename);
      nameEl.addEventListener("pointerdown", (e) => e.stopPropagation());

      container.appendChild(nameEl);
    }
  }

  state.addEventListener("change", update);
  update();
  return container;
}
