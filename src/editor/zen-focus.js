/**
 * Zen Focus — fullscreen distraction-free overlay.
 *
 * Picks the editor the user is currently working with (notebook text
 * shape > active doc pane > main editor), moves its DOM into a
 * fullscreen overlay, bumps the font size, and fades over every other
 * piece of chrome. Exits on Esc or the toggle shortcut, restoring the
 * editor to its original parent.
 *
 * The DOM-move keeps editing live: there's no shadow editor and no
 * content sync — typing in Zen IS typing in the source. CodeMirror
 * tolerates being reparented; the textarea overlay tolerates it too as
 * long as we override its absolute positioning while it's in Zen.
 */

import { panes } from "../pane/pane-state.js";
import { getActivePaneId } from "../pane/pane-manager.js";

let active = null; // { source, target, parent, nextSibling, overlay, hint, listeners }
let hintFadeTimer = null;

const HINT_FADE_MS = 1500;

export function initZenFocus(state) {
  state.on("zen-focus-changed", () => {
    if (state.zenFocus) {
      enterZenFocus(state);
    } else {
      exitZenFocus(state);
    }
  });
  state.on("settings-changed", () => {
    if (active && active.overlay) {
      const px = state.settings.zenFocusFontSize || 30;
      active.overlay.style.setProperty("--zen-font-size", `${px}px`);
    }
  });
}

/** Find the right element to host inside the Zen overlay. Priority:
 *  notebook text-shape editor > active doc pane editor > main editor.
 *  Returns null if there's nothing prose-shaped to focus on. */
function pickZenSource(state) {
  // Notebook text-shape inline editor (highest priority — the user is
  // mid-edit on a shape).
  const nbHandle = (typeof window !== "undefined")
    ? window.__activeNotebookTextEditor
    : null;
  if (nbHandle && nbHandle.textarea && document.contains(nbHandle.textarea)) {
    return { kind: "notebook-text", element: nbHandle.textarea, handle: nbHandle };
  }
  // Active doc pane (notebook panes are skipped — no prose to focus on).
  const paneId = getActivePaneId();
  if (paneId) {
    const pane = panes.get(paneId);
    if (pane && pane.fileType === "document" && pane.editor?.view?.dom) {
      return { kind: "pane", element: pane.editor.view.dom, pane };
    }
  }
  // Main editor — only meaningful in doc mode.
  if (!state.currentNotebookFileId && state.editor?.view?.dom) {
    return { kind: "main", element: state.editor.view.dom, view: state.editor.view };
  }
  return null;
}

export function enterZenFocus(state) {
  if (active) return;
  const source = pickZenSource(state);
  if (!source) {
    // No suitable source; quietly clear the flag so the toggle isn't
    // stuck in an inconsistent state.
    state.zenFocus = false;
    return;
  }

  const target = source.element;
  const parent = target.parentNode;
  const nextSibling = target.nextSibling;
  const savedInline = target.getAttribute("style");

  const overlay = document.createElement("div");
  overlay.className = "zen-focus-overlay";
  overlay.style.setProperty("--zen-font-size", `${state.settings.zenFocusFontSize || 30}px`);

  const stage = document.createElement("div");
  stage.className = "zen-focus-stage";
  overlay.appendChild(stage);

  const hint = document.createElement("div");
  hint.className = "zen-focus-hint";
  hint.textContent = formatShortcutForHint(state.settings.shortcutZenFocus || "Mod+Shift+S");
  overlay.appendChild(hint);

  document.body.classList.add("zen-focus-active");
  document.body.appendChild(overlay);
  stage.appendChild(target);
  // Mark the target so CSS can override its inline positioning while
  // it's hosted by the overlay (the notebook textarea is positioned
  // absolutely in canvas coords; CodeMirror editors carry their own
  // sizing). The class is removed on exit.
  target.classList.add("zen-focus-target");

  const onKeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      state.toggleZenFocus();
    }
  };
  const onMouseMove = () => showHint(hint);
  document.addEventListener("keydown", onKeydown, true);
  overlay.addEventListener("mousemove", onMouseMove);

  // Move focus into the editor so the user can type immediately.
  // CodeMirror exposes view.focus(); the textarea exposes .focus() too.
  if (source.kind === "main" && source.view) source.view.focus();
  else if (source.kind === "pane" && source.pane?.editor?.focus) source.pane.editor.focus();
  else if (source.kind === "notebook-text" && source.handle?.focus) source.handle.focus();

  // Prime the hint visible briefly so the user discovers the shortcut
  // without having to wave the mouse around first.
  showHint(hint);

  active = {
    source,
    target,
    parent,
    nextSibling,
    savedInline,
    overlay,
    hint,
    onKeydown,
    onMouseMove,
  };
}

export function exitZenFocus(state) {
  if (!active) return;
  const a = active;
  active = null;

  document.removeEventListener("keydown", a.onKeydown, true);
  a.overlay.removeEventListener("mousemove", a.onMouseMove);
  if (hintFadeTimer) { clearTimeout(hintFadeTimer); hintFadeTimer = null; }

  a.target.classList.remove("zen-focus-target");
  if (a.savedInline == null) a.target.removeAttribute("style");
  else a.target.setAttribute("style", a.savedInline);

  // Restore the target to its original spot. If the next sibling is
  // gone (e.g. the parent rebuilt while Zen was open), append at end.
  if (a.nextSibling && a.nextSibling.parentNode === a.parent) {
    a.parent.insertBefore(a.target, a.nextSibling);
  } else if (a.parent && document.contains(a.parent)) {
    a.parent.appendChild(a.target);
  }

  a.overlay.remove();
  document.body.classList.remove("zen-focus-active");

  // Return focus to the source so the user lands back where they were.
  if (a.source.kind === "main" && state.editor?.view) state.editor.view.focus();
  else if (a.source.kind === "pane" && a.source.pane?.editor?.focus) a.source.pane.editor.focus();
  else if (a.source.kind === "notebook-text" && a.source.handle?.focus) a.source.handle.focus();
}

export function toggleZenFocus(state) {
  state.toggleZenFocus();
}

function showHint(hint) {
  hint.classList.add("visible");
  if (hintFadeTimer) clearTimeout(hintFadeTimer);
  hintFadeTimer = setTimeout(() => {
    hint.classList.remove("visible");
    hintFadeTimer = null;
  }, HINT_FADE_MS);
}

/** Render a shortcut string like "Mod+Shift+S" with platform glyphs. */
function formatShortcutForHint(shortcut) {
  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || "");
  const parts = String(shortcut || "").split("+").map((p) => p.trim()).filter(Boolean);
  return parts.map((p) => {
    const key = p.toLowerCase();
    if (key === "mod" || key === "cmdorctrl") return isMac ? "⌘" : "Ctrl";
    if (key === "cmd") return isMac ? "⌘" : "Win";
    if (key === "ctrl") return "Ctrl";
    if (key === "alt" || key === "option") return isMac ? "⌥" : "Alt";
    if (key === "shift") return "⇧";
    return p.length === 1 ? p.toUpperCase() : p;
  }).join(isMac ? "" : "+") + "  to exit";
}
