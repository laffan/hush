/**
 * Command Palette — Cmd+P overlay for quick access to modes and actions.
 *
 * Displays a centered, searchable list of all major commands with their
 * icons and keyboard shortcuts.  Items are filtered as the user types.
 */
import { openFindReplace, openFindAll } from "./editor/find-replace.js";
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
};

/**
 * Build the canonical list of palette commands.  Each entry:
 *   { id, label, icon, shortcutKey?, action(state) }
 *
 * `shortcutKey` is the settings field name whose value holds the raw
 * shortcut string (e.g. `"shortcutTogglePrivate"`).
 */
function buildCommands(state) {
  return [
    {
      id: "new-file",
      label: "New file",
      icon: icons.newFile,
      shortcutKey: "shortcutNewFile",
      action: (s) => s.newFile(),
    },
    {
      id: "files",
      label: "Files",
      icon: icons.files,
      shortcutKey: "shortcutToggleSidebar",
      action: (s) => s.emit("toggle-left-panel"),
    },
    {
      id: "styles",
      label: "Styles",
      icon: icons.styles,
      shortcutKey: null,
      action: (s) => s.emit("show-styles-panel"),
    },
    {
      id: "ratchet",
      label: "Ratchet mode",
      icon: icons.ratchet,
      shortcutKey: null,
      action: (s) => s.emit("show-ratchet-dropdown"),
    },
    {
      id: "private",
      label: "Private mode",
      icon: icons.private,
      shortcutKey: "shortcutTogglePrivate",
      action: (s) => s.togglePrivate(),
    },
    {
      id: "typewriter",
      label: "Typewriter mode",
      icon: icons.typewriter,
      shortcutKey: "shortcutTypewriter",
      action: (s) => s.toggleTypewriter(),
    },
    {
      id: "dry",
      label: "Show repeats",
      icon: icons.dry,
      shortcutKey: "shortcutToggleDry",
      action: (s) => s.toggleDry(),
    },
    {
      id: "focus",
      label: "Highlight sentence",
      icon: icons.focus,
      shortcutKey: "shortcutToggleFocus",
      action: (s) => s.toggleFocus(),
    },
    {
      id: "zotero",
      label: "Insert reference",
      icon: icons.zotero,
      shortcutKey: "shortcutZotero",
      action: async (s) => {
        if (s.editor) {
          const { openZoteroModal } = await import("./zotero.js");
          openZoteroModal(s.editor.view, s);
        }
      },
    },
    {
      id: "versions",
      label: "Versions",
      icon: icons.versions,
      shortcutKey: null,
      action: (s) => s.emit("show-versions-panel"),
    },
    {
      id: "export",
      label: "Export",
      icon: icons.export,
      shortcutKey: null,
      action: (s) => s.emit("export-current-file"),
    },
    {
      id: "outline",
      label: "Outline view",
      icon: null,
      shortcutKey: "shortcutToggleOutline",
      action: (s) => s.emit("toggle-outline-panel"),
    },
    {
      id: "fullscreen",
      label: "Toggle fullscreen",
      icon: null,
      shortcutKey: "shortcutOpenFullscreen",
      action: (s) => s.toggleFullscreen(),
    },
    {
      id: "find",
      label: "Find & replace",
      icon: null,
      shortcutKey: "shortcutFind",
      action: (s) => {
        if (s.editor) openFindReplace(s.editor.view, s);
      },
    },
    {
      id: "find-all",
      label: "Find across files",
      icon: null,
      shortcutKey: "shortcutFindAll",
      action: (s) => {
        if (s.editor) openFindAll(s.editor.view, s);
      },
    },
  ];
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
let keyboardNav = false; // true after arrow keys, suppresses mouseenter

function isOpen() {
  return overlay !== null;
}

function close() {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
}

export function toggleCommandPalette(state) {
  if (isOpen()) {
    close();
    if (state.editor) state.editor.focus();
    return;
  }
  open(state);
}

/**
 * Build "Turn off X" entries for any currently active toggle modes.
 * These are prepended to the command list so they appear first.
 */
function buildActiveModeTurnoffs(state) {
  const modes = [
    { flag: "ratchetMode", label: "Turn off Ratchet mode", icon: icons.ratchet, action: (s) => s.stopRatchet() },
    { flag: "privateMode", label: "Turn off Private mode", icon: icons.private, shortcutKey: "shortcutTogglePrivate", action: (s) => s.togglePrivate() },
    { flag: "typewriterMode", label: "Turn off Typewriter mode", icon: icons.typewriter, shortcutKey: "shortcutTypewriter", action: (s) => s.toggleTypewriter() },
    { flag: "dryMode", label: "Turn off Show repeats", icon: icons.dry, shortcutKey: "shortcutToggleDry", action: (s) => s.toggleDry() },
    { flag: "focusMode", label: "Turn off Highlight sentence", icon: icons.focus, shortcutKey: "shortcutToggleFocus", action: (s) => s.toggleFocus() },
  ];
  return modes
    .filter(m => state[m.flag])
    .map(m => ({
      id: `turnoff-${m.flag}`,
      label: m.label,
      icon: m.icon,
      shortcutKey: m.shortcutKey || null,
      action: m.action,
    }));
}

function open(state) {
  const baseCommands = buildCommands(state);
  const turnoffs = buildActiveModeTurnoffs(state);
  allCommands = [...turnoffs, ...baseCommands];
  filteredCommands = [...allCommands];
  activeIndex = 0;
  keyboardNav = false;

  // Build DOM
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

  // --- Event handlers ---

  // Re-enable mouse selection after actual mouse movement
  overlay.addEventListener("mousemove", () => { keyboardNav = false; });

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      filteredCommands = [...allCommands];
    } else {
      filteredCommands = allCommands.filter(c => c.label.toLowerCase().includes(q));
    }
    activeIndex = 0;
    renderList(list, state);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      if (state.editor) state.editor.focus();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      keyboardNav = true;
      if (filteredCommands.length) {
        activeIndex = (activeIndex + 1) % filteredCommands.length;
        renderList(list, state);
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      keyboardNav = true;
      if (filteredCommands.length) {
        activeIndex = (activeIndex - 1 + filteredCommands.length) % filteredCommands.length;
        renderList(list, state);
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (filteredCommands[activeIndex]) {
        const cmd = filteredCommands[activeIndex];
        close();
        cmd.action(state);
      }
      return;
    }
  });

  // Close on click outside the palette
  overlay.addEventListener("mousedown", (e) => {
    if (!palette.contains(e.target)) {
      close();
      if (state.editor) state.editor.focus();
    }
  });
}

function renderList(listEl, state) {
  listEl.innerHTML = "";
  filteredCommands.forEach((cmd, i) => {
    const row = document.createElement("div");
    row.className = "cmd-palette-item" + (i === activeIndex ? " active" : "");

    // Icon
    const iconEl = document.createElement("span");
    iconEl.className = "cmd-palette-icon";
    if (cmd.icon) {
      iconEl.innerHTML = `<svg viewBox="0 0 24 24">${cmd.icon}</svg>`;
    }
    row.appendChild(iconEl);

    // Label
    const labelEl = document.createElement("span");
    labelEl.className = "cmd-palette-label";
    labelEl.textContent = cmd.label;
    row.appendChild(labelEl);

    // Shortcut
    const shortcutRaw = cmd.shortcutKey ? state.settings[cmd.shortcutKey] : null;
    if (shortcutRaw) {
      const shortcutEl = document.createElement("span");
      shortcutEl.className = "cmd-palette-shortcut";
      shortcutEl.innerHTML = formatShortcutKeys(shortcutRaw);
      row.appendChild(shortcutEl);
    }

    row.addEventListener("click", () => {
      close();
      cmd.action(state);
    });

    row.addEventListener("mouseenter", () => {
      if (keyboardNav) return; // ignore until mouse actually moves
      activeIndex = i;
      listEl.querySelectorAll(".cmd-palette-item").forEach((el, j) => {
        el.classList.toggle("active", j === i);
      });
    });

    listEl.appendChild(row);
  });

  // Scroll the active item into view
  const activeEl = listEl.querySelector(".cmd-palette-item.active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}
