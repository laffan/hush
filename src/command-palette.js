/**
 * Command Palette — Cmd+P overlay for quick access to modes and actions.
 *
 * Displays a centered, searchable list of all major commands with their
 * icons and keyboard shortcuts.  Items are filtered as the user types.
 * Commands are context-sensitive: shared, doc-only, or notebook-only.
 */
import { formatShortcutKeys } from "./command-palette-helpers.js";
import {
  paneAnchorClickPoint, enterFilePicker, enterDeskPicker,
} from "./command-palette-pickers.js";
import { createPane } from "./pane/pane-manager.js";
import { icons, buildCommands, buildActiveModeTurnoffs } from "./command-palette-commands.js";

let overlay = null;
let activeIndex = 0;
let filteredCommands = [];
let allCommands = [];
let keyboardNav = false;
// When the palette opens over an active notebook text editor, we suspend
// that editor's commit-on-blur so navigating to a command doesn't
// quietly commit the text shape. The handle is restored in close().
let suspendedNotebookText = null;

function isOpen() { return overlay !== null; }
function close() {
  if (overlay) { overlay.remove(); overlay = null; }
  // Hand focus back to a suspended notebook text editor and resume
  // its blur-commit. Actions that need the editor alive (Zotero) null
  // suspendedNotebookText before calling close() so this no-ops.
  if (suspendedNotebookText) {
    const h = suspendedNotebookText;
    suspendedNotebookText = null;
    try { h.focus(); } catch (_) {}
    try { h.resumeCommitOnBlur(); } catch (_) {}
  }
}

/**
 * Open the palette directly into file-picker mode. `mode` is either
 * "open" (open the picked file in the main editor) or "pane" (open it
 * as a floating pane). Used by the Cmd+O / Cmd+Shift+O shortcuts —
 * skips the user from having to first hit Cmd+P then pick "Open…".
 */
export function openFilePalette(state, mode) {
  // If the palette's already up, close it first so we re-open fresh
  // into the file-picker rather than stacking modes.
  if (isOpen()) close();
  // Same suspend-notebook-text dance as toggleCommandPalette so an
  // active inline text shape isn't committed when we steal focus.
  suspendedNotebookText = null;
  try {
    const handle = typeof window !== "undefined" ? window.__activeNotebookTextEditor : null;
    if (handle && typeof handle.suspendCommitOnBlur === "function") {
      handle.suspendCommitOnBlur();
      suspendedNotebookText = handle;
    }
  } catch (_) { /* no active notebook text editor */ }
  open(state);
  // After open() the palette element exists; immediately swap it into
  // file-picker mode — this matches what selecting "Open…" / "Open as
  // pane…" from the palette does.
  const api = paletteApi(state);
  if (mode === "pane") {
    enterFilePicker(api, state, "Open as pane…", (f) => {
      // Pane lands in the gap opposite the editor column shift.
      const { x, y } = paneAnchorClickPoint(state);
      createPane(f.fileId, f.name, f.type, x, y);
    });
  } else {
    enterFilePicker(api, state, "Open file…", (f) => {
      if (f.type === "notebook") state.openNotebook(f.fileId);
      else if (f.type === "project") state.openProject(f.fileId);
      else state.openFile(f.fileId);
    }, { includeProjects: true });
  }
}

/**
 * Open the palette directly into desk-picker mode — the keyboard
 * shortcut entry point for "Switch Desks". Mirrors openFilePalette so
 * the picker carries the command palette's look and arrow-key / return
 * navigation. No-ops with fewer than two desks.
 */
export function openDeskPalette(state) {
  if ((state.settings?.desks || []).length < 2) return;
  if (isOpen()) close();
  open(state);
  enterDeskPicker(paletteApi(state), state);
}

/** Internal handle to the currently-open palette so openFilePalette can
 *  swap it into file-picker mode without re-implementing the open()
 *  state machine. Mirrors the `paletteHandle` shape that open() builds
 *  for keepOpen-style commands. */
function paletteApi(state) {
  const input = overlay?.querySelector(".cmd-palette-input");
  const list = overlay?.querySelector(".cmd-palette-list");
  return {
    setItems(items, placeholder) {
      allCommands = items;
      filteredCommands = [...items];
      activeIndex = 0;
      if (placeholder !== undefined && input) input.placeholder = placeholder;
      if (input) { input.value = ""; input.focus(); }
      if (list) renderList(list, state);
    },
    close() { close(); },
  };
}

export function toggleCommandPalette(state) {
  if (isOpen()) { close(); if (state.editor) state.editor.focus(); return; }
  // If the user is mid-edit on a notebook text shape, preserve that
  // editor across the palette's lifetime — the input we're about to
  // focus would otherwise blur the textarea and commit the shape
  // before a command like "Insert Reference" can run. The text-editor
  // mirrors its active handle on `window` so we can read it
  // synchronously (an async import() would race the blur).
  suspendedNotebookText = null;
  try {
    const handle = typeof window !== "undefined" ? window.__activeNotebookTextEditor : null;
    if (handle && typeof handle.suspendCommitOnBlur === "function") {
      handle.suspendCommitOnBlur();
      suspendedNotebookText = handle;
    }
  } catch (_) { /* no active notebook text editor */ }
  open(state);
}

function open(state) {
  const baseCommands = buildCommands(state);
  const turnoffs = buildActiveModeTurnoffs(state);
  allCommands = [...turnoffs, ...baseCommands];
  filteredCommands = [...allCommands];
  activeIndex = 0;
  keyboardNav = false;

  overlay = document.createElement("div");
  overlay.className = "cmd-palette-overlay";
  const palette = document.createElement("div");
  palette.className = "cmd-palette";
  const input = document.createElement("input");
  input.className = "cmd-palette-input";
  input.type = "text";
  input.placeholder = "Type a command…";
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  palette.appendChild(input);
  const list = document.createElement("div");
  list.className = "cmd-palette-list";
  palette.appendChild(list);
  overlay.appendChild(palette);
  document.body.appendChild(overlay);
  renderList(list, state);
  input.focus();

  // Handle exposed to keepOpen-style commands so they can swap the palette
  // into a file-picker (or any other) sub-mode without closing it.
  const paletteHandle = {
    setItems(items, placeholder) {
      allCommands = items;
      filteredCommands = [...items];
      activeIndex = 0;
      if (placeholder !== undefined) input.placeholder = placeholder;
      input.value = "";
      input.focus();
      renderList(list, state);
    },
    close() { close(); },
  };

  // keyboardNav clears in the row pointerenter handler (mouse only);
  // an overlay-wide pointermove would fire per touch frame on iPad.

  // Matches the visible label plus an optional `keywords` string — the
  // hidden half of a command's name. A command that got renamed keeps
  // its old wording searchable there, so muscle memory still lands.
  const matches = (c, q) =>
    c.label.toLowerCase().includes(q) || (c.keywords || "").toLowerCase().includes(q);

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    filteredCommands = !q ? [...allCommands] : allCommands.filter(c => matches(c, q));
    activeIndex = 0;
    renderList(list, state);
  });

  // Focus the main editor after close(), but only if we weren't hosting
  // an active notebook text shape — close() already handed focus back
  // to the textarea, and stealing it away to the hidden main editor
  // would blur the textarea and (after the 150ms timer fires) commit
  // the shape anyway.
  const focusMainEditorIfAppropriate = () => {
    if (suspendedNotebookText) return; // close() will focus the textarea
    if (state.editor) state.editor.focus();
  };

  function runCommand(cmd) {
    if (!cmd) return;
    if (cmd.keepOpen) {
      cmd.action(state, paletteHandle);
      return;
    }
    // Zotero's modal needs to stay the owner of the notebook text handle
    // through its own open/close lifecycle — null the palette's reference
    // here so close() doesn't resume commit on a handle the modal is
    // about to re-suspend anyway.
    if (cmd.id === "zotero") suspendedNotebookText = null;
    close();
    cmd.action(state, paletteHandle);
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); focusMainEditorIfAppropriate(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); keyboardNav = true; if (filteredCommands.length) { activeIndex = (activeIndex + 1) % filteredCommands.length; renderList(list, state); } return; }
    if (e.key === "ArrowUp") { e.preventDefault(); keyboardNav = true; if (filteredCommands.length) { activeIndex = (activeIndex - 1 + filteredCommands.length) % filteredCommands.length; renderList(list, state); } return; }
    if (e.key === "Enter") {
      e.preventDefault();
      runCommand(filteredCommands[activeIndex]);
      return;
    }
  });

  overlay.addEventListener("mousedown", (e) => {
    if (!palette.contains(e.target)) { close(); focusMainEditorIfAppropriate(); }
  });

  // Real mouse movement (mouse-only event, never fired by touch) hands
  // the highlight back to hover-driven selection. Until that happens,
  // `keyboardNav` stays true and the per-row `pointerenter` no-ops so
  // arrow keys aren't yanked back to the cursor's resting position.
  overlay.addEventListener("mousemove", () => { keyboardNav = false; });

  // Expose runCommand on the list element so renderList's per-row click
  // handlers can route through the same keepOpen-aware path.
  list.__runCommand = runCommand;
}

function renderList(listEl, state) {
  listEl.innerHTML = "";
  filteredCommands.forEach((cmd, i) => {
    const row = document.createElement("div");
    row.className = "cmd-palette-item" + (i === activeIndex ? " active" : "");
    const iconEl = document.createElement("span");
    iconEl.className = "cmd-palette-icon";
    if (cmd.icon) iconEl.innerHTML = cmd.icon;
    row.appendChild(iconEl);
    const labelEl = document.createElement("span");
    labelEl.className = "cmd-palette-label";
    labelEl.textContent = cmd.label;
    row.appendChild(labelEl);
    // Small badge markup that rides directly after the label (the desk
    // picker's ratchet glyph). Kept out of `label` so filtering still
    // matches on the plain text.
    if (cmd.labelSuffix) {
      const suffixEl = document.createElement("span");
      suffixEl.className = "cmd-palette-label-suffix";
      suffixEl.innerHTML = cmd.labelSuffix;
      row.appendChild(suffixEl);
    }
    const shortcutRaw = cmd.shortcutKey ? state.settings[cmd.shortcutKey] : null;
    if (shortcutRaw) {
      const shortcutEl = document.createElement("span");
      shortcutEl.className = "cmd-palette-shortcut";
      shortcutEl.innerHTML = formatShortcutKeys(shortcutRaw);
      row.appendChild(shortcutEl);
    }
    // File-picker rows surface pane indicators on the right.
    if (cmd.paneIndicators instanceof Node) {
      const wrap = document.createElement("span");
      wrap.className = "cmd-palette-pane-indicators";
      wrap.appendChild(cmd.paneIndicators);
      row.appendChild(wrap);
    }
    row.addEventListener("click", () => {
      const run = listEl.__runCommand;
      if (run) run(cmd);
      else { close(); cmd.action(state); }
    });
    // Mouse-only hover handling: iOS synthetic mouseenter would cause
    // a full reflow per crossed row on touch scrolls, and keyboard-nav
    // would otherwise yank the highlight back to the cursor's resting
    // position (cleared by the overlay's mousemove listener).
    row.addEventListener("pointerenter", (e) => {
      if (e.pointerType && e.pointerType !== "mouse") return;
      if (keyboardNav) return;
      if (activeIndex === i) return;
      const prev = listEl.children[activeIndex];
      if (prev) prev.classList.remove("active");
      activeIndex = i;
      row.classList.add("active");
    });
    listEl.appendChild(row);
  });
  const activeEl = listEl.querySelector(".cmd-palette-item.active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}
