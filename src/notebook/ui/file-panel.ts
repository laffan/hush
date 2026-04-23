import type { DrawingState } from "../state";
import { saveNoteFile, openNoteFile } from "../file-io";
import { h } from "./dom-helpers";
import { icon } from "./icons";

export function createFilePanel(state: DrawingState): HTMLElement {
  const container = h("div", {
    style: { position: "relative", display: "flex", flexDirection: "row", gap: "4px" },
  });

  const btnStyle: Partial<CSSStyleDeclaration> = {
    width: "36px", height: "36px", border: "none", borderRadius: "8px",
    background: "rgba(255,255,255,0.9)", boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
    cursor: "pointer", backdropFilter: "blur(8px)",
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "#333",
  };

  // Save button
  const saveBtn = h("button", {
    title: "Save (.note)",
    style: { ...btnStyle },
    children: [icon("save", 20)],
    onClick: async () => {
      try {
        await saveNoteFile(state.shapes, state.layers, state.activeLayerId);
      } catch (err) {
        console.error("Save failed:", err);
      }
    },
  });
  container.appendChild(saveBtn);

  // Open button
  const openBtn = h("button", {
    title: "Open (.note)",
    style: { ...btnStyle },
    children: [icon("open", 20)],
    onClick: async () => {
      try {
        const result = await openNoteFile();
        if (!result) return;
        state.shapes = result.shapes;
        state.layers = result.layers;
        state.activeLayerId = result.activeLayerId;
        state.selectedIds = new Set();
        state.initHistory();
        state.notify("layers");
        state.notify("activeLayerId");
        state.notify("shapes");
        state.notify("selectedIds");
      } catch (err) {
        console.error("Open failed:", err);
      }
    },
  });
  container.appendChild(openBtn);

  return container;
}
