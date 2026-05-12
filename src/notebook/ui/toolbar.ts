/* src/notebook/ui/toolbar.ts
 *
 * Bottom toolbar host. Owns the main canvas-tool buttons (select,
 * text, drag-area, brainstorm) plus the layers and bookmarks panels.
 * The drawing-tools section (divider + brush slots + slice / erase /
 * lasso) is appended to this same DOM element by createDrawingToolPanel,
 * so the bar reads as one continuous strip — no inter-pill seam.
 *
 * Background settings, drag, and rotate now live as separate end-cap
 * buttons created by tool-panel.ts.
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

export function createToolbar(state: DrawingState): HTMLElement {
  const buttons = new Map<string, HTMLButtonElement>();

  function makeBtn(def: ToolDef): HTMLButtonElement {
    const btn = h("button", {
      title: `${def.label} (${def.shortcut})`,
      style: { width: "36px", height: "36px", display: "flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: "8px", cursor: "pointer", background: "transparent", transition: "all 0.15s" },
      children: [icon(def.iconName, 20)],
      onClick: () => {
        // Any tool press clears an active pan — a persistent grab and
        // a functional tool shouldn't be layered.
        if (state.isPanning) { state.isPanning = false; state.notify("isPanning"); }
        if (def.tool === "brainstorm") {
          state.brainstormMode = !state.brainstormMode;
          if (state.brainstormMode) { state.tool = "text"; state.notify("tool"); }
          state.notify("brainstormMode");
          return;
        }
        // Drag Area shortcut: when 2+ shapes are already selected,
        // pressing Drag Area wraps the selection in a new container
        // instead of entering draw-an-area mode. Falls through to the
        // normal tool switch when the wrap can't apply.
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

  // Pan: keyboard shortcut (space) and two-finger drag are the only
  // entry points now — the dedicated grab button was removed when the
  // bottom toolbar was attached to the drawing toolbar (the combined
  // unit is too wide to keep a button that's already covered by other
  // gestures).

  const container = h("div", {
    style: {
      position: "absolute", top: "20px",
      display: "flex", alignItems: "center", gap: "4px", padding: "1px 8px",
      // Flush with the rotate tab on the left and the bg-settings
      // tab on the right — they form one continuous bar.
      borderRadius: "0",
      boxShadow: "0 2px 12px rgba(0,0,0,0.12)", zIndex: "100", userSelect: "none",
      backdropFilter: "blur(8px)",
    },
    children: [
      ...TOOLS.map(makeBtn),
      layersEl.root,
      bookmarksEl,
    ],
  });
  container.classList.add("notebook-toolbar");

  function update() {
    const theme = state.theme;
    container.style.background = theme.uiBackground;

    // Reset both axis anchors before re-applying — flipping
    // orientation otherwise leaves a stale axis pinned.
    container.style.left = "auto";
    container.style.right = "auto";
    container.style.top = "auto";
    container.style.bottom = "auto";
    container.style.transform = "none";

    const inset = state.leftInset || 0;
    const offset = state.drawingToolbarOffset || { x: 0, y: 0 };

    if (state.drawingToolbarVertical) {
      container.style.flexDirection = "column";
      const parentEl = container.parentElement;
      const parentH = parentEl?.clientHeight || window.innerHeight;
      container.style.top = ((parentH / 2) + offset.y) + "px";
      container.style.transform = "translateY(-50%)";
      container.style.left = `calc(${inset}px + 16px + ${offset.x}px)`;
    } else {
      container.style.flexDirection = "row";
      const parentW = container.parentElement?.clientWidth || window.innerWidth;
      const center = inset + (parentW - inset) / 2;
      container.style.left = (center + offset.x) + "px";
      container.style.transform = "translateX(-50%)";
      container.style.top = `calc(20px + ${offset.y}px)`;
    }

    const fg = theme.foreground;
    const accent = theme.accent;
    const collapsed = state.drawingToolbarCollapsed;
    // Class-based hide (see notebook.css) so each button's inline
    // `display: flex` survives — clearing the inline style would
    // stack icons vertically instead of laying them out in a row.
    const HIDE = "notebook-toolbar-collapse-hidden";

    for (const [key, btn] of buttons) {
      let active: boolean;
      if (key === "brainstorm") {
        active = state.brainstormMode;
      } else {
        active = state.tool === key && !state.brainstormMode;
      }
      btn.style.color = active ? accent : fg;
      btn.style.opacity = active ? "1" : "0.6";
      // Collapsed: only the active main tool stays in the bar — its
      // sibling buttons and the Layers / Bookmarks panel triggers hide.
      btn.classList.toggle(HIDE, collapsed && !active);
    }
    // Layers + Bookmarks panel triggers are siblings of the tool
    // buttons — neither is a "tool", so both hide while collapsed.
    layersEl.root.classList.toggle(HIDE, collapsed);
    bookmarksEl.classList.toggle(HIDE, collapsed);
  }

  state.addEventListener("change", update);
  update();
  return container;
}
