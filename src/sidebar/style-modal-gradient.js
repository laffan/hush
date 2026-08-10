/**
 * Gradient-layer options for the Background Layers section — the 2D pad
 * where colour nodes are added, removed, and dragged around, plus the
 * animate toggle. Split out of style-modal-background.js to keep files
 * under the 700-line cap.
 *
 * Node coords are stored normalized (0..1, y down) on the layer's
 * `nodes` array; the pad shows a CSS radial-gradient approximation of
 * the mesh as live feedback (the true render happens in the preview
 * pane / editor via the WebGL runtime).
 */
import { escAttr } from "./styles-panel-shared.js";

const MAX_NODES = 8;

// Selected node index — module-level (one modal at a time), re-seeded
// whenever the bound layer changes.
let _selIdx = 0;
let _selLayerId = null;

function padBackground(nodes) {
  return (nodes || []).map(n =>
    `radial-gradient(circle at ${Math.round(n.x * 100)}% ${Math.round(n.y * 100)}%, ${n.color} 0%, transparent 62%)`
  ).join(", ");
}

export function renderGradientOptions(layer) {
  const nodes = layer.nodes || [];
  if (_selLayerId !== layer.id) { _selLayerId = layer.id; _selIdx = 0; }
  if (_selIdx >= nodes.length) _selIdx = Math.max(0, nodes.length - 1);
  const sel = nodes[_selIdx] || null;
  return `
    <div class="style-grad-pad" style="background:${escAttr(padBackground(nodes))}">
      ${nodes.map((n, i) => `
        <button type="button" class="style-grad-node${i === _selIdx ? " selected" : ""}"
                data-node-idx="${i}"
                style="left:${n.x * 100}%;top:${n.y * 100}%;--node-color:${escAttr(n.color)}"></button>`).join("")}
    </div>
    <div class="style-editor-row">
      <label>Node color</label>
      <div class="style-color-group">
        <input type="color" id="style-grad-node-color" value="${escAttr(sel ? sel.color : "#888888")}" ${sel ? "" : "disabled"} />
      </div>
    </div>
    <div class="style-editor-row">
      <label>Nodes</label>
      <div class="style-grad-node-btns">
        <button type="button" id="style-grad-add" ${nodes.length >= MAX_NODES ? "disabled" : ""}>Add</button>
        <button type="button" id="style-grad-remove" ${nodes.length <= 2 ? "disabled" : ""}>Remove</button>
      </div>
    </div>
    <div class="style-editor-row">
      <label>Animate gradient</label>
      <div class="style-checkbox-group">
        <input type="checkbox" id="style-grad-animate" ${layer.animate ? "checked" : ""} />
      </div>
    </div>`;
}

/** Wire the pad + node controls. `onPreview` pushes the live preview
 *  (no save), `onCommit` previews + schedules a save, `rerender`
 *  redraws the options block (used after add / remove / select where
 *  the DOM structure changes). */
export function bindGradientOptions(container, layer, { onPreview, onCommit, rerender }) {
  const pad = container.querySelector(".style-grad-pad");
  if (!pad) return;
  const nodes = layer.nodes || (layer.nodes = []);

  const refreshPad = () => { pad.style.background = padBackground(nodes); };

  container.querySelectorAll(".style-grad-node").forEach((dot) => {
    const idx = parseInt(dot.dataset.nodeIdx, 10);
    dot.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Select on press (cheap in-place class/color sync — no rerender,
      // so the same gesture can continue straight into a drag).
      if (_selIdx !== idx) {
        _selIdx = idx;
        container.querySelectorAll(".style-grad-node").forEach((d) => d.classList.remove("selected"));
        dot.classList.add("selected");
        const colorInput = container.querySelector("#style-grad-node-color");
        if (colorInput && nodes[idx]) colorInput.value = nodes[idx].color;
      }
      // Coordinates clamp to the pad.
      const rect = pad.getBoundingClientRect();
      dot.setPointerCapture(e.pointerId);
      const onMove = (me) => {
        const x = Math.max(0, Math.min(1, (me.clientX - rect.left) / rect.width));
        const y = Math.max(0, Math.min(1, (me.clientY - rect.top) / rect.height));
        nodes[idx].x = x;
        nodes[idx].y = y;
        dot.style.left = x * 100 + "%";
        dot.style.top = y * 100 + "%";
        refreshPad();
        onPreview();
      };
      const onUp = () => {
        dot.removeEventListener("pointermove", onMove);
        dot.removeEventListener("pointerup", onUp);
        dot.removeEventListener("pointercancel", onUp);
        onCommit();
      };
      dot.addEventListener("pointermove", onMove);
      dot.addEventListener("pointerup", onUp);
      dot.addEventListener("pointercancel", onUp);
    });
  });

  const colorEl = container.querySelector("#style-grad-node-color");
  if (colorEl) {
    const handler = () => {
      if (!nodes[_selIdx]) return;
      nodes[_selIdx].color = colorEl.value;
      refreshPad();
      const dot = container.querySelector(`.style-grad-node[data-node-idx="${_selIdx}"]`);
      if (dot) dot.style.setProperty("--node-color", colorEl.value);
      onCommit();
    };
    colorEl.addEventListener("input", handler);
    colorEl.addEventListener("change", handler);
  }

  const addBtn = container.querySelector("#style-grad-add");
  if (addBtn) addBtn.addEventListener("click", () => {
    if (nodes.length >= MAX_NODES) return;
    // New nodes land slightly off-centre so consecutive adds don't stack.
    const jitter = (nodes.length % 4) * 0.08;
    nodes.push({ x: 0.42 + jitter, y: 0.42 + jitter, color: "#7a6ff0" });
    _selIdx = nodes.length - 1;
    rerender();
    onCommit();
  });

  const removeBtn = container.querySelector("#style-grad-remove");
  if (removeBtn) removeBtn.addEventListener("click", () => {
    if (nodes.length <= 2) return;
    nodes.splice(_selIdx, 1);
    _selIdx = Math.max(0, _selIdx - 1);
    rerender();
    onCommit();
  });

  const animEl = container.querySelector("#style-grad-animate");
  if (animEl) animEl.addEventListener("change", () => {
    layer.animate = animEl.checked;
    onCommit();
  });
}
