/* src/notebook/ui/toolbar.ts
 *
 * Bottom toolbar host. Owns the main canvas-tool buttons (select,
 * text, drag-area, brainstorm) plus the layers and bookmarks panels.
 * The drawing-tools section (divider + brush slots + slice / erase /
 * lasso) is appended to this same DOM element by createDrawingToolPanel,
 * so the bar reads as one continuous strip — no inter-pill seam.
 *
 * Snap positions: state.drawingToolbarPosition is one of
 *   "top"    → pinned to top edge, centered horizontally (default)
 *   "bottom" → pinned to bottom edge, centered horizontally
 *   "left"   → pinned to left edge, centered vertically (vertical bar)
 *   "custom" → free-positioned by drawingToolbarOffset
 *
 * Responsive: if the natural width of the horizontal bar would overflow
 * the visible canvas (minus side insets), every child shrinks to 75%
 * and the bar wraps to two rows via flex-wrap.
 */

import type { DrawingState } from "../state";
import type { Tool } from "../types";
import { h } from "./dom-helpers";
import { icon } from "./icons";
import { createBookmarksPanel } from "./bookmarks-panel";
import { createLayersPanel } from "../drawing/layers-panel";

interface ToolDef { iconName: string; label: string; tool: Tool | "brainstorm"; shortcut: string }

const TOOLS: ToolDef[] = [
  { iconName: "select", label: "Select", tool: "select", shortcut: "1" },
  { iconName: "text", label: "Text", tool: "text", shortcut: "T" },
  { iconName: "drag-area", label: "Drag Area", tool: "drag-area", shortcut: "A" },
  { iconName: "brainstorm", label: "Brainstorm", tool: "brainstorm", shortcut: "B" },
];

const EDGE_PAD = 20;

export function createToolbar(state: DrawingState): HTMLElement {
  const buttons = new Map<string, HTMLButtonElement>();

  function makeBtn(def: ToolDef): HTMLButtonElement {
    const btn = h("button", {
      title: `${def.label} (${def.shortcut})`,
      style: { width: "36px", height: "36px", display: "flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: "8px", cursor: "pointer", background: "transparent", transition: "all 0.15s" },
      children: [icon(def.iconName, 20)],
      onClick: () => {
        if (state.isPanning) { state.isPanning = false; state.notify("isPanning"); }
        if (def.tool === "brainstorm") {
          state.brainstormMode = !state.brainstormMode;
          if (state.brainstormMode) { state.tool = "text"; state.notify("tool"); }
          state.notify("brainstormMode");
          return;
        }
        if (def.tool === "drag-area" && state.wrapSelectionInDragArea()) {
          return;
        }
        state.tool = def.tool;
        state.brainstormMode = false;
        state.notify("tool");
        state.notify("brainstormMode");
      },
    });
    buttons.set(def.tool, btn);
    return btn;
  }

  const bookmarksEl = createBookmarksPanel(state);
  const layersEl = createLayersPanel(state);

  const container = h("div", {
    style: {
      position: "absolute", top: "20px",
      display: "flex", alignItems: "center", gap: "4px", padding: "1px 8px",
      borderRadius: "0",
      boxShadow: "0 2px 12px rgba(0,0,0,0.12)", zIndex: "100", userSelect: "none",
      backdropFilter: "blur(8px)",
      flexWrap: "nowrap",
    },
    children: [
      ...TOOLS.map(makeBtn),
      layersEl.root,
      bookmarksEl,
    ],
  });
  container.classList.add("notebook-toolbar");

  function applyCompactMode(compact: boolean) {
    container.classList.toggle("notebook-toolbar-compact", compact);
    container.style.flexWrap = compact ? "wrap" : "nowrap";
    container.style.maxWidth = compact ? "calc(min(100%, 320px))" : "";
  }

  function update() {
    const theme = state.theme;
    container.style.background = theme.uiBackground;

    container.style.left = "auto";
    container.style.right = "auto";
    container.style.top = "auto";
    container.style.bottom = "auto";
    container.style.transform = "none";

    const leftInset = state.leftInset || 0;
    const rightInset = state.rightInset || 0;
    const offset = state.drawingToolbarOffset || { x: 0, y: 0 };
    const parentEl = container.parentElement;
    const parentW = parentEl?.clientWidth || window.innerWidth;
    const parentH = parentEl?.clientHeight || window.innerHeight;
    const usableW = Math.max(0, parentW - leftInset - rightInset);

    // Responsive compaction: applies in any horizontal layout.
    const vertical = state.drawingToolbarVertical;
    let compact = false;
    if (!vertical) {
      // Quick natural-width estimate: ~44px per visible child (36px button + 4px gap + padding).
      const childCount = Array.from(container.children).filter((c) => (c as HTMLElement).offsetParent !== null || true).length;
      const estimate = childCount * 44 + 64; // 64 for drag tab + bar padding
      compact = estimate > usableW - 80;
    }
    applyCompactMode(compact);

    switch (state.drawingToolbarPosition) {
      case "left": {
        container.style.flexDirection = "column";
        container.style.top = (parentH / 2) + "px";
        container.style.transform = "translateY(-50%)";
        container.style.left = `${leftInset + 16}px`;
        break;
      }
      case "bottom": {
        container.style.flexDirection = "row";
        const center = leftInset + usableW / 2;
        container.style.left = center + "px";
        container.style.transform = "translateX(-50%)";
        container.style.bottom = `${EDGE_PAD}px`;
        break;
      }
      case "custom": {
        container.style.flexDirection = "row";
        const center = leftInset + usableW / 2;
        container.style.left = (center + offset.x) + "px";
        container.style.transform = "translateX(-50%)";
        container.style.top = `${EDGE_PAD + offset.y}px`;
        break;
      }
      case "top":
      default: {
        container.style.flexDirection = "row";
        const center = leftInset + usableW / 2;
        container.style.left = center + "px";
        container.style.transform = "translateX(-50%)";
        container.style.top = `${EDGE_PAD}px`;
        break;
      }
    }

    const fg = theme.foreground;
    const accent = theme.accent;

    for (const [key, btn] of buttons) {
      let active: boolean;
      if (key === "brainstorm") {
        active = state.brainstormMode;
      } else {
        active = state.tool === key && !state.brainstormMode;
      }
      btn.style.color = active ? accent : fg;
      btn.style.opacity = active ? "1" : "0.6";
    }
  }

  state.addEventListener("change", update);
  window.addEventListener("resize", update);
  update();
  return container;
}
