/**
 * Lightweight heading outline for doc columns inside a stack.
 * Mirrors the notebook shelf / PDF annotation shelf pattern —
 * a right-side panel within the column content area, toggled
 * via Cmd+Shift+\.
 */
import { EditorView } from "@codemirror/view";

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

function createStackDocOutline(contentEl, editorView) {
  const panel = document.createElement("div");
  panel.className = "stack-doc-outline longview";

  const header = document.createElement("div");
  header.className = "stack-doc-outline-header";
  header.textContent = "Outline";
  const closeBtn = document.createElement("button");
  closeBtn.className = "stack-doc-outline-close";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => {
    if (panel._cleanup) panel._cleanup();
    panel.remove();
  });
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const list = document.createElement("div");
  list.className = "stack-doc-outline-list";
  panel.appendChild(list);

  function render() {
    list.innerHTML = "";
    if (!editorView?.state) return;
    const doc = editorView.state.doc;
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const m = line.text.match(HEADING_RE);
      if (!m) continue;
      const level = m[1].length;
      const text = m[2].trim();
      const row = document.createElement("div");
      row.className = "stack-doc-outline-row";
      row.style.paddingLeft = (8 + (level - 1) * 14) + "px";
      row.textContent = text;
      const offset = line.from;
      row.addEventListener("click", () => {
        const safe = Math.max(0, Math.min(offset, editorView.state.doc.length));
        editorView.dispatch({
          selection: { anchor: safe },
          effects: EditorView.scrollIntoView(safe, { y: "start", yMargin: 80 }),
        });
        editorView.focus();
      });
      list.appendChild(row);
    }
    if (list.children.length === 0) {
      const empty = document.createElement("div");
      empty.className = "stack-doc-outline-empty";
      empty.textContent = "No headings";
      list.appendChild(empty);
    }
  }

  render();
  const interval = setInterval(render, 3000);
  panel._cleanup = () => clearInterval(interval);

  contentEl.appendChild(panel);
  return panel;
}

export function toggleStackDocOutline(contentEl, editorView) {
  const existing = contentEl.querySelector(".stack-doc-outline");
  if (existing) {
    if (existing._cleanup) existing._cleanup();
    existing.remove();
  } else {
    createStackDocOutline(contentEl, editorView);
  }
}
