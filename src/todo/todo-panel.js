/**
 * To-do list — the floating panel. App-wide: it flies in from the right,
 * floating 20 px inside the window's edges with every corner showing,
 * over everything but the modal band (`--z-todo`). ⌘ tapped twice
 * (triple-tap-triggers.js) or "To-do List" in the command palette
 * toggles it; Escape closes it.
 *
 * The list inside is todo-list.js, which the Desk Dashboard's sidebar
 * mounts too. This module is only the shell: the element, its fly in and
 * out, the keyboard taken on open and handed back on close. Here the
 * list runs with `fileContext`: opened over a file, its top is that
 * file's to-do (or a draft of one), and the keyboard goes into its note;
 * otherwise into the composer's title.
 *
 * While the Desk Dashboard is open its own list is on screen, so the
 * toggle goes there — the keyboard into its composer — rather than
 * raising a second list under the dashboard.
 */
import { mountTodoList, embeddedTodoList } from "./todo-list.js";

let panel = null; // the live handle

export function isTodoPanelOpen() { return !!panel; }

export function toggleTodoPanel(state) {
  if (!panel && embeddedTodoList()) { embeddedTodoList().focusInput(); return; }
  if (panel) panel.close();
  else openTodoPanel(state);
}

export function openTodoPanel(state) {
  const embedded = embeddedTodoList();
  if (embedded) { embedded.focusInput(); return; }
  if (panel) { panel.focusFirst(); return; }
  panel = mountPanel(state);
}

export function closeTodoPanel() { panel?.close(); }

function mountPanel(state) {
  // Where the keyboard was, to hand it back on close.
  const returnFocus = document.activeElement;
  const el = document.createElement("aside");
  el.className = "todo-panel";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "To-do list");
  document.body.appendChild(el);

  let closing = false;
  const list = mountTodoList(state, el, { onClose: close, onEscape: close, fileContext: true });

  function close() {
    if (closing) return;
    closing = true;
    list.destroy();
    el.classList.remove("shown");
    const done = () => el.remove();
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) done();
    else { el.addEventListener("transitionend", done, { once: true }); setTimeout(done, 400); }
    if (panel?.el === el) panel = null;
    // Give the keyboard back to what was being written in, if it is
    // still there — never to the main editor by default: behind a
    // notebook that is a hidden document.
    if (el.contains(document.activeElement) && returnFocus instanceof HTMLElement && returnFocus.isConnected) {
      returnFocus.focus();
    }
  }

  // Fly in: one frame at the parked position, then the shown one.
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("shown")));
  // Take the keyboard — into the file's to-do over a file, else the
  // composer — so it stops going into the document and Escape reaches
  // the panel.
  list.focusInput();

  return { el, close, focusFirst: list.focusFirst };
}
