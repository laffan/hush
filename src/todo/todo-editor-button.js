/**
 * The to-do button in the editor's upper right corner: while the Doc in
 * front has an outstanding to-do — one linked to it and not completed —
 * a small to-do icon sits there, and a click brings up the To-do list,
 * which opens over the Doc on that to-do (todo-list.js's file section).
 *
 * Docs only: a notebook, a stack or a PDF has chrome of its own in that
 * corner. The button keeps clear of the right-hand bars (the Overview and
 * the comments) and of a right-docked pane, fades while typing as the
 * right edge's trigger does, and steps aside for Zen and the Project
 * Overview (todo.css).
 *
 * Loaded after boot (main.js), so the to-do modules stay out of the entry
 * chunk; the list itself loads on the first click.
 */
import { statusOf } from "./todo-status.js";
import { contextFile } from "./todo-file-context.js";

const ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="6" height="6" rx="1.5"/><path d="M5 8 L6.3 9.3 L8.4 6.8"/><path d="M13 8 H20.5 M5 16 H20.5"/></svg>`;

/** The to-dos still open for `fileId`. */
function openCount(state, fileId) {
  const todos = Array.isArray(state.settings?.todos) ? state.settings.todos : [];
  return todos.filter((t) => t && t.fileId === fileId && statusOf(t) !== "complete").length;
}

export function installTodoEditorButton(state) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "todo-editor-btn";
  btn.hidden = true;
  btn.innerHTML = ICON;
  document.body.appendChild(btn);

  // The caret stays in the Doc: the list hands the keyboard back to it
  // when it closes, which it would not if the press had taken it.
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", async () => {
    const { toggleTodoPanel } = await import("./todo-panel.js");
    toggleTodoPanel(state);
  });

  function update() {
    const ctx = contextFile(state);
    const n = ctx && ctx.type === "document" ? openCount(state, ctx.fileId) : 0;
    btn.hidden = !n;
    if (!n) return;
    const label = n === 1 ? "To-do for this document" : `${n} to-dos for this document`;
    btn.dataset.tooltip = label;
    btn.setAttribute("aria-label", label);
  }

  const EVENTS = [
    "file-opened", "no-file-state", "notebook-open", "notebook-unmount", "pdf-open", "pdf-unmount",
    "stack-open", "stack-unmount", "todos-changed", "files-changed", "active-desk-changed", "remote-settings-merged",
  ];
  for (const ev of EVENTS) state.on(ev, update);
  update();
}
