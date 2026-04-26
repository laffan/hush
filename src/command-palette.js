/**
 * Command Palette — Cmd+P overlay for quick access to modes and actions.
 *
 * Displays a centered, searchable list of all major commands with their
 * icons and keyboard shortcuts.  Items are filtered as the user types.
 * Commands are context-sensitive: shared, doc-only, or notebook-only.
 */
import { openFindReplace, openFindAll } from "./editor/find-replace.js";
import { openSettingsWindow } from "./settings/settings-ui.js";
import { findNodeByFileId } from "./state/tree-helpers.js";
import { deleteTreeNode } from "./state/state-tree.js";
import { getActivePaneId, fitActivePaneToLeftGap, createPane } from "./pane/pane-manager.js";
import newFileRaw from "./sidebar/sidebar_icons/newFile.svg?raw";
import filesRaw from "./sidebar/sidebar_icons/files.svg?raw";
import ratchetRaw from "./sidebar/sidebar_icons/ratchet.svg?raw";
import privateRaw from "./sidebar/sidebar_icons/private.svg?raw";
import typewriterRaw from "./sidebar/sidebar_icons/typewriter.svg?raw";
import dryRaw from "./sidebar/sidebar_icons/dry.svg?raw";
import focusRaw from "./sidebar/sidebar_icons/focus.svg?raw";
import versionsRaw from "./sidebar/sidebar_icons/versions.svg?raw";
import exportRaw from "./sidebar/sidebar_icons/export.svg?raw";
import stylesRaw from "./sidebar/sidebar_icons/styles.svg?raw";
import zoteroRaw from "./sidebar/sidebar_icons/zotero.svg?raw";
import iconDocRaw from "./sidebar/sidebar_icons/icon-doc.svg?raw";
import iconNotebookRaw from "./sidebar/sidebar_icons/icon-notebook.svg?raw";
import iconProjectRaw from "./sidebar/sidebar_icons/icon-project.svg?raw";

function svgInner(raw) {
  return raw.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "").trim();
}

const icons = {
  newFile: svgInner(newFileRaw),
  files: svgInner(filesRaw),
  ratchet: svgInner(ratchetRaw),
  private: svgInner(privateRaw),
  typewriter: svgInner(typewriterRaw),
  dry: svgInner(dryRaw),
  focus: svgInner(focusRaw),
  versions: svgInner(versionsRaw),
  export: svgInner(exportRaw),
  styles: svgInner(stylesRaw),
  zotero: svgInner(zoteroRaw),
  doc: svgInner(iconDocRaw),
  notebook: svgInner(iconNotebookRaw),
  project: svgInner(iconProjectRaw),
  // Mirrors the inline trash icon used in files-panel.js so the palette
  // matches the sidebar's visual language. Drawn on a 16-unit viewBox.
  trash: `<polyline points="2 4 4 4 14 4" /><path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" /><path d="M12 4v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4" />`,
};

// Context: "shared" = always shown, "doc" = doc/project only, "notebook" = notebook only
function buildCommands(state) {
  const inNotebook = !!state.currentNotebookFileId;
  const hasActivePane = getActivePaneId() != null;

  const all = [
    // === SHARED ===
    { id: "new-doc", label: "New document", icon: icons.doc, shortcutKey: "shortcutNewFile", ctx: "shared",
      action: (s) => s.newFile() },
    { id: "new-notebook", label: "New notebook", icon: icons.notebook, shortcutKey: null, ctx: "shared",
      action: (s) => s.createNotebook("New Notebook") },
    { id: "new-doc-pane", label: "New document as pane", icon: icons.doc, shortcutKey: null, ctx: "shared",
      action: async (s) => {
        const created = await s.newFile(null, { openImmediately: false });
        if (created) createPane(created.fileId, created.name, "document", 62, 60);
      } },
    { id: "new-notebook-pane", label: "New notebook as pane", icon: icons.notebook, shortcutKey: null, ctx: "shared",
      action: async (s) => {
        const created = await s.createNotebook("New Notebook", null, { openImmediately: false });
        if (created) createPane(created.fileId, created.name, "notebook", 62, 60);
      } },
    { id: "open-file", label: "Open document or notebook", icon: icons.files, shortcutKey: null, ctx: "shared",
      keepOpen: true,
      action: (s, p) => enterFilePicker(p, s, "Open file…", (f) => {
        if (f.type === "notebook") s.openNotebook(f.fileId);
        else s.openFile(f.fileId);
      }) },
    { id: "open-pane", label: "Open document or notebook as pane", icon: icons.files, shortcutKey: null, ctx: "shared",
      keepOpen: true,
      action: (s, p) => enterFilePicker(p, s, "Open as pane…", (f) => {
        // Left-anchored: 50px (sidebar column) + 12px padding. Keeps
        // new panes near the source they were opened from instead of
        // tucked in the right gutter — closer to the user's reading flow.
        const x = 62;
        const y = 60;
        createPane(f.fileId, f.name, f.type, x, y);
      }) },
    { id: "delete-current", label: "Delete current file", icon: icons.trash, iconViewBox: "0 0 16 16", shortcutKey: null, ctx: "shared",
      action: async (s) => {
        const fileId = s.currentNotebookFileId || s.currentFileId;
        if (!fileId) return;
        const node = findNodeByFileId(s.fileTree, fileId);
        if (!node) return;
        const ok = window.confirm(`Move "${node.name || "Untitled"}" to Trash?`);
        if (!ok) return;
        await deleteTreeNode(s, node.id);
      } },
    { id: "files", label: "Files", icon: icons.files, shortcutKey: "shortcutToggleSidebar", ctx: "shared",
      action: (s) => s.emit("toggle-left-panel") },
    { id: "styles", label: "Styles", icon: icons.styles, shortcutKey: null, ctx: "shared",
      action: (s) => s.emit("show-styles-panel") },
    { id: "zotero", label: "Insert reference", icon: icons.zotero, shortcutKey: "shortcutZotero", ctx: "shared",
      action: async (s) => { if (s.editor) { const { openZoteroModal } = await import("./zotero.js"); openZoteroModal(s.editor.view, s); } } },
    { id: "versions", label: "Versions", icon: icons.versions, shortcutKey: null, ctx: "shared",
      action: (s) => s.emit("show-versions-panel") },
    { id: "export", label: "Export", icon: icons.export, shortcutKey: null, ctx: "shared",
      action: (s) => s.emit("export-current-file") },
    { id: "fullscreen", label: "Toggle fullscreen", icon: null, shortcutKey: "shortcutOpenFullscreen", ctx: "shared",
      action: (s) => s.toggleFullscreen() },
    { id: "find", label: "Find & replace", icon: null, shortcutKey: "shortcutFind", ctx: "shared",
      action: (s) => { if (s.editor) openFindReplace(s.editor.view, s); } },
    { id: "find-all", label: "Find across files", icon: null, shortcutKey: "shortcutFindAll", ctx: "shared",
      action: (s) => { if (s.editor) openFindAll(s.editor.view, s); } },
    { id: "settings", label: "Settings", icon: null, shortcutKey: null, ctx: "shared",
      action: (s) => openSettingsWindow(s) },

    // === DOC ONLY ===
    { id: "ratchet", label: "Ratchet mode", icon: icons.ratchet, shortcutKey: null, ctx: "doc",
      action: (s) => s.emit("show-ratchet-dropdown") },
    { id: "private", label: "Private mode", icon: icons.private, shortcutKey: "shortcutTogglePrivate", ctx: "doc",
      action: (s) => s.togglePrivate() },
    { id: "typewriter", label: "Typewriter mode", icon: icons.typewriter, shortcutKey: "shortcutTypewriter", ctx: "doc",
      action: (s) => s.toggleTypewriter() },
    { id: "dry", label: "Show repeats", icon: icons.dry, shortcutKey: "shortcutToggleDry", ctx: "doc",
      action: (s) => s.toggleDry() },
    { id: "focus", label: "Highlight sentence", icon: icons.focus, shortcutKey: "shortcutToggleFocus", ctx: "doc",
      action: (s) => s.toggleFocus() },
    { id: "word-count", label: "Toggle word count", icon: null, shortcutKey: "shortcutToggleWordCount", ctx: "doc",
      action: async (s) => { const { toggleWordCount } = await import("./editor/plugins/word-count.js"); toggleWordCount(s); } },
    { id: "outline", label: "Outline view", icon: null, shortcutKey: "shortcutToggleOutline", ctx: "doc",
      action: (s) => s.emit("toggle-outline-panel") },

    // === ACTIVE PANE ONLY (doc or notebook) ===
    { id: "fit-pane-left", label: "Fit pane to left gap", icon: null, shortcutKey: null, ctx: "pane",
      action: () => fitActivePaneToLeftGap() },

    // === NOTEBOOK ONLY ===
    { id: "nb-shelf", label: "Open shelf", icon: null, shortcutKey: null, ctx: "notebook",
      action: (s) => s.emit("notebook-toggle-shelf") },
    { id: "nb-brainstorm", label: "Start brainstorm", icon: null, shortcutKey: "shortcutNbBrainstorm", ctx: "notebook",
      action: (s) => s.emit("notebook-toggle-brainstorm") },
  ];

  return all.filter(cmd => {
    if (cmd.ctx === "shared") return true;
    if (cmd.ctx === "doc") return !inNotebook;
    if (cmd.ctx === "notebook") return inNotebook;
    if (cmd.ctx === "pane") return hasActivePane;
    return true;
  });
}

/** Walk the file tree and return real document/notebook leaves, skipping
 *  the Images and Trash subtrees. */
function collectFileLeaves(fileTree) {
  const out = [];
  function walk(nodes, skip) {
    for (const n of nodes) {
      if (n.id === "__trash__" || n.id === "__images__") continue;
      if ((n.type === "document" || n.type === "notebook") && n.fileId) {
        out.push({ id: n.id, name: n.name || "Untitled", type: n.type, fileId: n.fileId });
      }
      if (n.children?.length) walk(n.children, skip);
    }
  }
  walk(fileTree || [], false);
  return out;
}

/** Replace the palette's command list with file rows that pipe back into
 *  `onPick(fileLeaf)` on selection. Used by both "Open…" commands. */
function enterFilePicker(palette, state, placeholder, onPick) {
  const leaves = collectFileLeaves(state.fileTree);
  const items = leaves.map((f) => ({
    id: "file-" + f.id,
    label: f.name,
    icon: f.type === "notebook" ? icons.notebook : icons.doc,
    shortcutKey: null,
    action: () => onPick(f),
  }));
  palette.setItems(items, placeholder);
}

/** Format a stored shortcut string into keycap HTML. */
function formatShortcutKeys(raw) {
  if (!raw) return "";
  const isMac = navigator.platform?.includes("Mac") || navigator.userAgent?.includes("Mac");
  const parts = raw.split("+");
  return parts.map(p => {
    let label = p;
    if (isMac) {
      if (/^(CmdOrCtrl|Mod)$/i.test(p)) label = "\u2318";
      else if (/^Shift$/i.test(p)) label = "\u21e7";
      else if (/^Alt$/i.test(p)) label = "\u2325";
      else if (/^ArrowUp$/i.test(p)) label = "\u2191";
      else if (/^ArrowDown$/i.test(p)) label = "\u2193";
      else if (/^ArrowLeft$/i.test(p)) label = "\u2190";
      else if (/^ArrowRight$/i.test(p)) label = "\u2192";
      else if (p === "\\\\") label = "\\";
      else label = p.length === 1 ? p.toUpperCase() : p;
    } else {
      if (/^(CmdOrCtrl|Mod)$/i.test(p)) label = "Ctrl";
      else if (/^ArrowUp$/i.test(p)) label = "\u2191";
      else if (/^ArrowDown$/i.test(p)) label = "\u2193";
      else if (/^ArrowLeft$/i.test(p)) label = "\u2190";
      else if (/^ArrowRight$/i.test(p)) label = "\u2192";
      else label = p.length === 1 ? p.toUpperCase() : p;
    }
    const el = document.createElement("span");
    el.textContent = label;
    return `<kbd>${el.innerHTML}</kbd>`;
  }).join("");
}

let overlay = null;
let activeIndex = 0;
let filteredCommands = [];
let allCommands = [];
let keyboardNav = false;
// When the palette opens over an active notebook text editor, we suspend
// that editor's commit-on-blur so the user can navigate to "Insert
// Reference" (or any command) without their text shape quietly
// committing. The handle is remembered here so close() can restore it.
let suspendedNotebookText = null;

function isOpen() { return overlay !== null; }
function close() {
  if (overlay) { overlay.remove(); overlay = null; }
  // If the palette opened over an active notebook text shape, hand
  // focus back and resume its normal blur-commit behaviour. Actions
  // that need the editor to stay alive (Zotero) null this reference
  // out before calling close() so this branch no-ops for them.
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
      // Left side: 50px sidebar + 12px padding. Cmd+Shift+O is a
      // reach-for-context gesture; landing the pane on the left puts
      // it where the user expects a secondary reading column.
      const x = 62;
      const y = 60;
      createPane(f.fileId, f.name, f.type, x, y);
    });
  } else {
    enterFilePicker(api, state, "Open file…", (f) => {
      if (f.type === "notebook") state.openNotebook(f.fileId);
      else state.openFile(f.fileId);
    });
  }
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

function buildActiveModeTurnoffs(state) {
  // Only show turn-offs for doc modes when not in notebook
  if (state.currentNotebookFileId) return [];
  const modes = [
    { flag: "ratchetMode", label: "Turn off Ratchet mode", icon: icons.ratchet, action: (s) => s.stopRatchet() },
    { flag: "privateMode", label: "Turn off Private mode", icon: icons.private, shortcutKey: "shortcutTogglePrivate", action: (s) => s.togglePrivate() },
    { flag: "typewriterMode", label: "Turn off Typewriter mode", icon: icons.typewriter, shortcutKey: "shortcutTypewriter", action: (s) => s.toggleTypewriter() },
    { flag: "dryMode", label: "Turn off Show repeats", icon: icons.dry, shortcutKey: "shortcutToggleDry", action: (s) => s.toggleDry() },
    { flag: "focusMode", label: "Turn off Highlight sentence", icon: icons.focus, shortcutKey: "shortcutToggleFocus", action: (s) => s.toggleFocus() },
  ];
  return modes
    .filter(m => state[m.flag])
    .map(m => ({ id: `turnoff-${m.flag}`, label: m.label, icon: m.icon, shortcutKey: m.shortcutKey || null, action: m.action }));
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
  input.placeholder = "Type a command\u2026";
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

  overlay.addEventListener("mousemove", () => { keyboardNav = false; });

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    filteredCommands = !q ? [...allCommands] : allCommands.filter(c => c.label.toLowerCase().includes(q));
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
    if (cmd.icon) iconEl.innerHTML = `<svg viewBox="${cmd.iconViewBox || "0 0 24 24"}">${cmd.icon}</svg>`;
    row.appendChild(iconEl);
    const labelEl = document.createElement("span");
    labelEl.className = "cmd-palette-label";
    labelEl.textContent = cmd.label;
    row.appendChild(labelEl);
    const shortcutRaw = cmd.shortcutKey ? state.settings[cmd.shortcutKey] : null;
    if (shortcutRaw) {
      const shortcutEl = document.createElement("span");
      shortcutEl.className = "cmd-palette-shortcut";
      shortcutEl.innerHTML = formatShortcutKeys(shortcutRaw);
      row.appendChild(shortcutEl);
    }
    row.addEventListener("click", () => {
      const run = listEl.__runCommand;
      if (run) run(cmd);
      else { close(); cmd.action(state); }
    });
    row.addEventListener("mouseenter", () => {
      if (keyboardNav) return;
      activeIndex = i;
      listEl.querySelectorAll(".cmd-palette-item").forEach((el, j) => el.classList.toggle("active", j === i));
    });
    listEl.appendChild(row);
  });
  const activeEl = listEl.querySelector(".cmd-palette-item.active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}
