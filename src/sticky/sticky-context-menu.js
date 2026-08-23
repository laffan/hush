/**
 * Sticky-note context switcher — the Document / Desk / App popup behind
 * the header's scope glyph, plus the re-scope it performs.
 *
 * Split out of sticky-notes.js for the 700-line cap, and wired the same
 * way `sticky-interact.js` is: everything that belongs to the note
 * registry (activation, z-order, the container, visibility, persistence)
 * arrives through a `hooks` object so this module never imports back
 * into its owner.
 *
 *   {
 *     appState(), currentFileContext(), container(), nextZ(),
 *     activate(note), labelFor(note), refreshVisibility(), persist(),
 *     stickiesChanged(),
 *   }
 */
import { CTX_ICON, CTX_MENU, ctxIconFor } from "./sticky-shared.js";

let activeMenu = null;
let activeMenuCleanup = null;

export function closeContextMenu() {
  if (activeMenu) { activeMenu.remove(); activeMenu = null; }
  if (activeMenuCleanup) { activeMenuCleanup(); activeMenuCleanup = null; }
}

/** Does scope `key` describe the note's current attachment? Project and
 *  file notes both read as "Document" (they share the pink body). */
function contextKeyMatches(kind, key) {
  if (key === "file") return kind === "file" || kind === "project" || kind === "desktop";
  return kind === key;
}

/** Can the note be switched to scope `key` right now? Document needs a
 *  file on screen to attach to; Desk needs an active desk; App is always
 *  available. */
function contextAvailable(key, hooks) {
  if (key === "file") return !!hooks.currentFileContext();
  if (key === "desk") return !!(hooks.appState()?.getActiveDesk?.()?.id);
  return true;
}

export function toggleContextMenu(note, anchorBtn, hooks) {
  if (activeMenu && activeMenu._noteId === note.id) { closeContextMenu(); return; }
  closeContextMenu();
  hooks.activate(note);

  const menu = document.createElement("div");
  menu.className = "sticky-context-menu";
  menu._noteId = note.id;
  for (const opt of CTX_MENU) {
    const isCurrent = contextKeyMatches(note.kind, opt.key);
    const available = contextAvailable(opt.key, hooks);
    const row = document.createElement("button");
    row.className = "sticky-context-option" + (isCurrent ? " current" : "");
    row.innerHTML = `<span class="sticky-ctx-ico">${CTX_ICON[opt.key]}</span><span>${opt.label}</span>`;
    if (!available && !isCurrent) row.disabled = true;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      closeContextMenu();
      if (available && !isCurrent) changeContext(note, opt.key, hooks);
    });
    menu.appendChild(row);
  }

  // The note itself is overflow:hidden, so the menu lives in the
  // full-screen sticky container and is positioned to the button. It
  // must out-stack the notes too — every note carries an inline
  // z-index from zCounter, and a z:auto sibling would paint *behind*
  // the very note that opened it (the menu overlaps the note body).
  const rect = anchorBtn.getBoundingClientRect();
  menu.style.left = Math.round(rect.left) + "px";
  menu.style.top = Math.round(rect.bottom + 4) + "px";
  menu.style.zIndex = hooks.nextZ();
  hooks.container().appendChild(menu);
  activeMenu = menu;
  // Nudge back on screen if it would spill off the right / bottom edge.
  const mrect = menu.getBoundingClientRect();
  if (mrect.right > window.innerWidth - 8) {
    menu.style.left = Math.round(window.innerWidth - 8 - mrect.width) + "px";
  }
  if (mrect.bottom > window.innerHeight - 8) {
    menu.style.top = Math.round(rect.top - 4 - mrect.height) + "px";
  }

  const onDown = (e) => {
    // Clicks inside the menu are handled by the option buttons; clicks on
    // a context button are left for its own handler to toggle the menu.
    if (e.target instanceof Element
        && e.target.closest(".sticky-context-menu, .sticky-note-context")) return;
    closeContextMenu();
  };
  const onKey = (e) => { if (e.key === "Escape") closeContextMenu(); };
  setTimeout(() => {
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
  }, 0);
  activeMenuCleanup = () => {
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
  };
}

/** Re-attach the note to a new scope, repaint its colour + glyph, and
 *  re-evaluate whether it's visible on the current surface. */
function changeContext(note, key, hooks) {
  let target = null;
  if (key === "file") {
    target = hooks.currentFileContext();
    if (!target) return;
  } else if (key === "desk") {
    target = hooks.appState()?.getActiveDesk?.()?.id || null;
    if (!target) return;
  }
  note.el.classList.remove("sticky-file", "sticky-project", "sticky-desk", "sticky-global", "sticky-desktop");
  delete note.wx;
  delete note.wy;
  note.kind = key;
  note.target = target;
  note.el.classList.add("sticky-" + key);
  if (note._ctxBtn) {
    note._ctxBtn.innerHTML = ctxIconFor(key);
    note._ctxBtn.title = hooks.labelFor(note);
  }
  hooks.refreshVisibility();
  hooks.persist();
  hooks.stickiesChanged();
}
