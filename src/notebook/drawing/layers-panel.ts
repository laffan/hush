/* src/notebook/drawing/layers-panel.ts
 *
 * Layers panel: a dropdown popover hung off a trigger button, same
 * shape as the Bookmarks panel. Backed by notebook state (not the
 * engine directly) so future non-drawing shape types on layers get
 * the same UI for free.
 *
 * Layout per row:  [●/○] [name] [↑] [↓] [eye] [lock] [trash]
 *   ● = active-layer radio; ○ = inactive. Click to activate.
 *   name: double-click to rename.
 *   arrows: reorder. Disabled at top/bottom.
 *   eye: visibility toggle.
 *   lock: layer lock toggle.
 *   trash: delete (disabled when only one layer remains).
 */

import type { DrawingState } from "../state";
import { h, clearChildren } from "../ui/dom-helpers";
import { icon } from "../ui/icons";

export interface LayersPanelHandle {
  /** Trigger button — add this to the tool panel. */
  root: HTMLElement;
  /** Force a rerender (e.g. on theme change). */
  refresh(): void;
}

export function createLayersPanel(state: DrawingState): LayersPanelHandle {
  const wrapper = h("div", { style: { position: "relative" } });

  const toggleBtn = h("button", {
    title: "Layers",
    style: {
      width: "36px", height: "36px",
      display: "flex", alignItems: "center", justifyContent: "center",
      border: "none", borderRadius: "8px", cursor: "pointer",
      background: "transparent", transition: "all 0.15s",
    },
    children: [icon("layers-stack", 20)],
    onClick: (e) => { e.stopPropagation(); open = !open; render(); },
  });
  wrapper.appendChild(toggleBtn);

  const panel = h("div", {
    style: {
      // Anchor above the trigger button; matches the Bookmarks panel
      // so it reads consistent in the bottom notebook toolbar.
      position: "absolute", bottom: "100%", left: "0",
      marginBottom: "6px",
      minWidth: "280px",
      padding: "6px",
      borderRadius: "10px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
      zIndex: "200",
      display: "none",
      backdropFilter: "blur(8px)",
    },
  });
  panel.addEventListener("pointerdown", (e) => e.stopPropagation());
  wrapper.appendChild(panel);

  let open = false;

  document.addEventListener("pointerdown", (e) => {
    if (!open) return;
    const t = e.target as Node;
    if (wrapper.contains(t)) return;
    open = false; render();
  });
  document.addEventListener("keydown", (e) => {
    if (open && e.key === "Escape") { open = false; render(); }
  });

  function render() {
    const theme = state.theme;
    toggleBtn.style.color = theme.foreground;
    // Match the main toolbar's utility-icon convention: 0.6 opacity
    // when closed, 1.0 when open (same treatment as the Grid button).
    toggleBtn.style.opacity = open ? "1" : "0.6";
    panel.style.display = open ? "block" : "none";
    panel.style.background = theme.uiBackground;
    panel.style.border = `1px solid ${theme.uiBorder}`;
    panel.style.color = theme.foreground;
    if (!open) return;

    clearChildren(panel);

    // Add button
    const addBtn = h("button", {
      style: {
        width: "100%",
        padding: "6px 8px",
        border: `1px dashed ${theme.uiBorder}`,
        borderRadius: "6px",
        background: "transparent",
        color: theme.foreground,
        cursor: "pointer",
        display: "flex", alignItems: "center", gap: "6px",
        marginBottom: "4px",
        justifyContent: "center",
        fontSize: "12px",
      },
      onClick: () => { state.addLayer(); render(); },
    });
    addBtn.appendChild(icon("plus", 14));
    addBtn.appendChild(document.createTextNode("Add layer"));
    panel.appendChild(addBtn);

    const list = h("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } });
    panel.appendChild(list);

    state.layers.forEach((layer, idx) => {
      const active = layer.id === state.activeLayerId;
      const row = h("div", {
        style: {
          display: "flex", alignItems: "center", gap: "2px",
          padding: "4px 6px",
          borderRadius: "6px",
          background: active ? "rgba(66, 133, 244, 0.1)" : "transparent",
        },
      });

      const activeBtn = h("button", {
        title: "Make active",
        style: {
          width: "22px", height: "22px", padding: "0",
          border: "none", borderRadius: "4px",
          background: "transparent",
          color: theme.accent,
          cursor: "pointer",
          fontSize: "14px", lineHeight: "1",
        },
        text: active ? "●" : "○",
        onClick: () => { state.setActiveLayer(layer.id); render(); },
      });
      row.appendChild(activeBtn);

      const name = h("span", {
        text: layer.name,
        style: {
          flex: "1", padding: "0 6px",
          fontSize: "12px",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          cursor: "text",
        },
      });
      name.addEventListener("dblclick", () => {
        const input = h("input", {
          attrs: { type: "text", value: layer.name },
          style: {
            flex: "1", padding: "1px 6px", margin: "-1px 0",
            fontSize: "12px",
            border: `1px solid ${theme.accent}`, borderRadius: "4px",
            background: theme.canvasBackground, color: theme.foreground,
            outline: "none",
          },
        }) as HTMLInputElement;
        input.value = layer.name;
        input.addEventListener("blur", () => {
          const v = input.value.trim();
          if (v && v !== layer.name) state.renameLayer(layer.id, v);
          render();
        });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") input.blur();
          if (e.key === "Escape") { input.value = layer.name; input.blur(); }
        });
        name.replaceWith(input);
        input.focus(); input.select();
      });
      row.appendChild(name);

      row.appendChild(iconBtn("chevron-up", "Move up", idx > 0, () => {
        state.moveLayerUp(layer.id); render();
      }));
      row.appendChild(iconBtn("chevron-down", "Move down", idx < state.layers.length - 1, () => {
        state.moveLayerDown(layer.id); render();
      }));
      const hideBtn = iconBtn(
        layer.hidden ? "eye-off" : "eye",
        layer.hidden ? "Show layer" : "Hide layer",
        true,
        () => { state.setLayerHidden(layer.id, !layer.hidden); render(); },
      );
      if (layer.hidden) hideBtn.style.opacity = "0.5";
      row.appendChild(hideBtn);
      row.appendChild(iconBtn(
        layer.locked ? "lock-closed" : "lock-open",
        layer.locked ? "Unlock" : "Lock",
        true,
        () => { state.setLayerLocked(layer.id, !layer.locked); render(); },
      ));
      const delBtn = iconBtn("trash", "Delete layer", state.layers.length > 1, () => {
        state.deleteLayer(layer.id); render();
      });
      delBtn.dataset.danger = "1";
      row.appendChild(delBtn);

      list.appendChild(row);
    });
  }

  function iconBtn(iconName: string, title: string, enabled: boolean, onClick: () => void): HTMLButtonElement {
    const b = h("button", {
      title,
      style: {
        width: "24px", height: "24px", padding: "0",
        border: "none", borderRadius: "4px",
        background: "transparent",
        color: state.theme.foreground,
        opacity: enabled ? "0.7" : "0.25",
        cursor: enabled ? "pointer" : "default",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
      },
      children: [icon(iconName, 14)],
    }) as HTMLButtonElement;
    if (enabled) b.addEventListener("click", onClick);
    b.addEventListener("mouseenter", () => {
      if (!enabled) return;
      b.style.background = b.dataset.danger === "1" ? "rgba(234, 67, 53, 0.12)" : "rgba(0,0,0,0.06)";
      b.style.color = b.dataset.danger === "1" ? "#ea4335" : state.theme.foreground;
      b.style.opacity = "1";
    });
    b.addEventListener("mouseleave", () => {
      b.style.background = "transparent";
      b.style.color = state.theme.foreground;
      b.style.opacity = enabled ? "0.7" : "0.25";
    });
    return b;
  }

  state.addEventListener("change", ((e: CustomEvent) => {
    const keys: string[] = (e.detail && e.detail.keys) || [];
    // Theme changes must re-render even when closed so the toggle
    // button's color/opacity stays in sync with the rest of the
    // toolbar. layers/activeLayerId only matter when the panel is
    // visible.
    if (keys.includes("theme")) {
      render();
    } else if (open && (keys.includes("layers") || keys.includes("activeLayerId"))) {
      render();
    }
  }) as EventListener);

  render();
  return { root: wrapper, refresh: render };
}
