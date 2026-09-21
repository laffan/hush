/**
 * Lightweight heading Overview for doc columns inside a stack.
 * Mirrors the notebook shelf / PDF annotation shelf pattern —
 * a right-side panel within the column content area, toggled
 * via Cmd+Shift+\.
 */
import { EditorView } from "@codemirror/view";

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

function createStackDocOverview(contentEl, editorView) {
  const panel = document.createElement("div");
  panel.className = "stack-doc-overview overview";

  const header = document.createElement("div");
  header.className = "stack-doc-overview-header";
  header.textContent = "Overview";
  const closeBtn = document.createElement("button");
  closeBtn.className = "stack-doc-overview-close";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => {
    if (panel._cleanup) panel._cleanup();
    panel.remove();
  });
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const list = document.createElement("div");
  list.className = "stack-doc-overview-list";
  panel.appendChild(list);

  let lastSig = null;
  function render() {
    if (!editorView?.state) return;
    const doc = editorView.state.doc;
    // Collect headings first and fingerprint them. The Overview polls every
    // 3 s; in the common case nothing changed, so skip the DOM teardown +
    // rebuild (and the per-row listener re-attach) unless the heading set
    // actually moved.
    const headings = [];
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const m = line.text.match(HEADING_RE);
      if (!m) continue;
      headings.push({ level: m[1].length, text: m[2].trim(), offset: line.from });
    }
    const sig = headings.map((h) => `${h.level}:${h.offset}:${h.text}`).join("\n");
    if (sig === lastSig) return;
    lastSig = sig;

    list.innerHTML = "";
    for (const h of headings) {
      const row = document.createElement("div");
      row.className = "stack-doc-overview-row";
      row.style.paddingLeft = (8 + (h.level - 1) * 14) + "px";
      row.textContent = h.text;
      const offset = h.offset;
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
      empty.className = "stack-doc-overview-empty";
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

export function toggleStackDocOverview(contentEl, editorView) {
  const existing = contentEl.querySelector(".stack-doc-overview");
  if (existing) {
    if (existing._cleanup) existing._cleanup();
    existing.remove();
  } else {
    createStackDocOverview(contentEl, editorView);
  }
}
