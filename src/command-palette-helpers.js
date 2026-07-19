/**
 * Small helpers used by the command palette. Extracted from
 * command-palette.js so that file stays under the 700-line cap.
 */
import { findNodeByFileId, findParentOfNode } from "./state/tree-helpers.js";
import { applyAppearance } from "./settings/settings-ui.js";
import appearanceDarkRaw from "./sidebar/sidebar_icons/appearance-dark.svg?raw";
import appearanceLightRaw from "./sidebar/sidebar_icons/appearance-light.svg?raw";
import appearanceAutoRaw from "./sidebar/sidebar_icons/appearance-auto.svg?raw";

const _appearanceInner = (raw) => raw.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "").trim();
const _appearanceIcons = {
  dark: `<svg viewBox="0 0 24 24">${_appearanceInner(appearanceDarkRaw)}</svg>`,
  light: `<svg viewBox="0 0 24 24">${_appearanceInner(appearanceLightRaw)}</svg>`,
  auto: `<svg viewBox="0 0 24 24">${_appearanceInner(appearanceAutoRaw)}</svg>`,
};

/** Appearance switcher rows — mirrors the toggle on Edit Styles. */
export function buildAppearanceCommands(state) {
  const current = state.settings?.appearance || "auto";
  const modes = [
    ["dark", "Dark appearance"],
    ["light", "Light Appearance"],
    ["auto", "System Appearance"],
  ];
  return modes.map(([id, label]) => ({
    id: `appearance-${id}`, label: `${label}${current === id ? " ✓" : ""}`,
    icon: _appearanceIcons[id], shortcutKey: null, ctx: "shared",
    action: (s) => {
      if ((s.settings?.appearance || "auto") === id) return;
      s.updateSettings({ appearance: id });
      applyAppearance(id);
      s.emit("style-changed");
      s.emit("theme-changed");
    },
  }));
}

/** Walk the file tree and return real document/notebook leaves plus
 *  user-created project nodes, skipping the Images, Trash, and Inbox
 *  subtrees. Inbox is internally typed as a project but functions as a
 *  folder, so it's filtered out of the picker — only "real" projects
 *  (the ones the user can click in the sidebar to open the joined view)
 *  appear here. */
export function collectFileLeaves(fileTree) {
  const out = [];
  function walk(nodes) {
    for (const n of nodes) {
      if (n.id === "__trash__" || n.id === "__images__"
          || n.id?.startsWith("__trash__:") || n.id?.startsWith("__images__:")) continue;
      // Project PDF aliases mirror a desk PDF that's already listed.
      if (n.pdfAlias) continue;
      if ((n.type === "document" || n.type === "notebook" || n.type === "stack" || n.type === "pdf") && n.fileId) {
        out.push({ id: n.id, name: n.name || "Untitled", type: n.type, fileId: n.fileId });
      }
      if (n.type === "project" && n.id !== "__inbox__" && !n.id?.startsWith("__inbox__:")) {
        out.push({ id: n.id, name: n.name || "Untitled", type: "project", fileId: n.id });
      }
      if (n.children?.length) walk(n.children);
    }
  }
  walk(fileTree || []);
  return out;
}

/** Active desk's children — Cmd+O / "Open as pane…" scope to this so
 *  the picker only surfaces files from the desk the user is in. */
export function activeDeskSubtree(s) {
  const t = s.fileTree || [], d = t.filter((n) => n.type === "desk");
  return d.length ? ((d.find((x) => x.id === s.settings?.activeDeskId) || d[0]).children || []) : t;
}

/** Format a stored shortcut string into keycap HTML for the palette
 *  row's trailing keycap pill. Returns "" when no shortcut is stored. */
export function formatShortcutKeys(raw) {
  if (!raw) return "";
  const isMac = navigator.platform?.includes("Mac") || navigator.userAgent?.includes("Mac");
  const parts = raw.split("+");
  return parts.map((p) => {
    let label = p;
    if (isMac) {
      if (/^(CmdOrCtrl|Mod)$/i.test(p)) label = "⌘";
      else if (/^Shift$/i.test(p)) label = "⇧";
      else if (/^Alt$/i.test(p)) label = "⌥";
      else if (/^ArrowUp$/i.test(p)) label = "↑";
      else if (/^ArrowDown$/i.test(p)) label = "↓";
      else if (/^ArrowLeft$/i.test(p)) label = "←";
      else if (/^ArrowRight$/i.test(p)) label = "→";
      else if (p === "\\\\") label = "\\";
      else label = p.length === 1 ? p.toUpperCase() : p;
    } else {
      if (/^(CmdOrCtrl|Mod)$/i.test(p)) label = "Ctrl";
      else if (/^ArrowUp$/i.test(p)) label = "↑";
      else if (/^ArrowDown$/i.test(p)) label = "↓";
      else if (/^ArrowLeft$/i.test(p)) label = "←";
      else if (/^ArrowRight$/i.test(p)) label = "→";
      else label = p.length === 1 ? p.toUpperCase() : p;
    }
    const el = document.createElement("span");
    el.textContent = label;
    return `<kbd>${el.innerHTML}</kbd>`;
  }).join("");
}

/** Desktop Tauri detection (iOS / iPadOS Tauri exposes a single window
 *  surface, so spawn-window commands gate on this). */
export function isDesktopTauri() {
  if (typeof window === "undefined") return false;
  if (!window.__TAURI_INTERNALS__) return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return false;
  const platform = navigator.platform || "";
  const tp = typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0;
  if (/Mac/i.test(platform) && tp > 0) return false;
  return true;
}

/** iOS / iPadOS Tauri detection — the inverse surface of
 *  `isDesktopTauri()`. Gates the iPad single-file "Open in New Window"
 *  command, which spawns a native UIScene rather than a WebviewWindow. */
export function isIOSTauri() {
  if (typeof window === "undefined") return false;
  if (!window.__TAURI_INTERNALS__) return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  const platform = navigator.platform || "";
  const tp = typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0;
  return /Mac/i.test(platform) && tp > 0;
}

/** Gate the "Use as note" / "Stop using as note" palette entries —
 *  `wantNote` true asks "is this doc already a note?", false asks "is
 *  it a regular doc inside a real project?". */
export function canUseAsNote(state, wantNote) {
  if (!state.currentFileId || state.currentNotebookFileId) return false;
  const n = findNodeByFileId(state.fileTree, state.currentFileId);
  if (!n || n.type !== "document") return false;
  if (wantNote) return !!n.useAsNote;
  if (n.useAsNote) return false;
  const p = findParentOfNode(state.fileTree, n.id);
  return !!p && p.type === "project" && p.id !== "__inbox__" && !p.id?.startsWith("__inbox__:");
}
