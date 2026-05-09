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
import { canUseAsNote, isDesktopTauri } from "./command-palette-helpers.js";
import { deleteTreeNode } from "./state/state-tree.js";
import { getActivePaneId, fitActivePaneToGap, createPane, getInitialPanePosition, replacePaneContent } from "./pane/pane-manager.js";
import { DEFAULT_WIDTH as PANE_DEFAULT_WIDTH, TITLEBAR_HEIGHT as PANE_TITLEBAR_HEIGHT } from "./pane/pane-state.js";
import { createNewFromSelected, sendSelectedToFile } from "./selection-extract.js";
import { openInNewWindow } from "./multi-window.js";
import { getLockedStyleId, setLockedStyleId } from "./sidebar/styles-panel.js";
import newFileRaw from "./sidebar/sidebar_icons/newFile.svg?raw";
import filesRaw from "./sidebar/sidebar_icons/files.svg?raw";
import deskRaw from "./sidebar/sidebar_icons/desk.svg?raw";
import paneRaw from "./sidebar/sidebar_icons/pane.svg?raw";
import ratchetRaw from "./sidebar/sidebar_icons/ratchet.svg?raw";
import privateRaw from "./sidebar/sidebar_icons/private.svg?raw";
import typewriterRaw from "./sidebar/sidebar_icons/typewriter.svg?raw";
import dryRaw from "./sidebar/sidebar_icons/dry.svg?raw";
import focusRaw from "./sidebar/sidebar_icons/focus.svg?raw";
import versionsRaw from "./sidebar/sidebar_icons/versions.svg?raw";
import exportRaw from "./sidebar/sidebar_icons/export.svg?raw";
import stylesRaw from "./sidebar/sidebar_icons/styles.svg?raw";
import zoteroRaw from "./sidebar/sidebar_icons/zotero.svg?raw";
import { typeIcons } from "./sidebar/files-panel-shared.js";

/** Resolve the current "this file" tree-node id — the node behind
 *  the open notebook, doc, or project (in that priority). Used to
 *  drive desk send/copy commands. Returns null if nothing's open. */
function currentFileTreeNodeId(s) {
  const fileId = s.currentNotebookFileId || s.currentFileId;
  if (fileId) {
    const node = findNodeByFileId(s.fileTree, fileId);
    if (node) return node.id;
  }
  if (s.currentProjectId) return s.currentProjectId;
  return null;
}

/** Wrap inner SVG markup (paths / polygons / etc.) in an `<svg>` of the
 *  given viewBox so it can be dropped straight into an `iconEl`. */
function wrapSvg(inner, viewBox = "0 0 24 24") {
  return `<svg viewBox="${viewBox}">${inner}</svg>`;
}

function svgInner(raw) {
  return raw.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "").trim();
}

/** createPane treats (x, y) as a click-point and centres the pane on
 *  it. To land a pane's *top-left* at the position computed by
 *  `getInitialPanePosition`, pre-add half the default size so the
 *  centring math cancels out. */
function paneAnchorClickPoint(state) {
  const pos = getInitialPanePosition(state);
  return {
    x: pos.x + PANE_DEFAULT_WIDTH / 2,
    y: pos.y + PANE_TITLEBAR_HEIGHT / 2,
  };
}

/** Each icon is the full `<svg …>…</svg>` markup so a row can drop it
 *  straight into the icon slot without the renderer needing to know
 *  about per-icon viewBox sizing. The doc / notebook / project /
 *  inbox / images / trash glyphs are reused verbatim from the sidebar
 *  via `typeIcons` so the palette and the file tree show the exact
 *  same visual language. */
const icons = {
  newFile: wrapSvg(svgInner(newFileRaw)),
  files: wrapSvg(svgInner(filesRaw)),
  desk: wrapSvg(svgInner(deskRaw)),
  pane: wrapSvg(svgInner(paneRaw)),
  ratchet: wrapSvg(svgInner(ratchetRaw)),
  private: wrapSvg(svgInner(privateRaw)),
  typewriter: wrapSvg(svgInner(typewriterRaw)),
  dry: wrapSvg(svgInner(dryRaw)),
  focus: wrapSvg(svgInner(focusRaw)),
  versions: wrapSvg(svgInner(versionsRaw)),
  export: wrapSvg(svgInner(exportRaw)),
  styles: wrapSvg(svgInner(stylesRaw)),
  zotero: wrapSvg(svgInner(zoteroRaw)),
  // "Aa" with a shallow cross laid over it. Stroke-only — picks up
  // `stroke: currentColor; fill: none` from the palette icon CSS.
  proofread: `<svg viewBox="0 0 24 24"><path d="M3 19 L7 5 L11 19 M4.5 14 H9.5"/><circle cx="17" cy="14.5" r="3.5"/><path d="M20.5 11.5 V18"/><line x1="2" y1="14" x2="22" y2="10"/><line x1="2" y1="10" x2="22" y2="14"/></svg>`,
  doc: typeIcons.document,
  notebook: typeIcons.notebook,
  project: typeIcons.project,
  trash: typeIcons.trash,
};

// Context: "shared" = always shown, "doc" = doc/project only, "notebook" = notebook only
function buildCommands(state) {
  const inNotebook = !!state.currentNotebookFileId;
  const hasActivePane = getActivePaneId() != null;
  const desktop = isDesktopTauri();

  const all = [
    // === SHARED ===
    { id: "new-doc", label: "New document", icon: icons.doc, shortcutKey: "shortcutNewFile", ctx: "shared",
      action: (s) => s.newFile() },
    { id: "new-notebook", label: "New notebook", icon: icons.notebook, shortcutKey: null, ctx: "shared",
      action: (s) => s.createNotebook("New Notebook") },
    { id: "new-doc-pane", label: "New document as pane", icon: icons.pane, shortcutKey: null, ctx: "shared",
      action: async (s) => {
        const created = await s.newFile(null, { openImmediately: false });
        if (created) {
          const { x, y } = paneAnchorClickPoint(s);
          createPane(created.fileId, created.name, "document", x, y);
        }
      } },
    { id: "new-notebook-pane", label: "New notebook as pane", icon: icons.pane, shortcutKey: null, ctx: "shared",
      action: async (s) => {
        const created = await s.createNotebook("New Notebook", null, { openImmediately: false });
        if (created) {
          const { x, y } = paneAnchorClickPoint(s);
          createPane(created.fileId, created.name, "notebook", x, y);
        }
      } },
    { id: "open-file", label: "Open document, notebook, or project", icon: icons.files, shortcutKey: null, ctx: "shared",
      keepOpen: true,
      action: (s, p) => enterFilePicker(p, s, "Open file…", (f) => {
        if (f.type === "notebook") s.openNotebook(f.fileId);
        else if (f.type === "project") s.openProject(f.fileId);
        else s.openFile(f.fileId);
      }, { includeProjects: true }) },
    { id: "open-pane", label: "Open document or notebook as pane", icon: icons.pane, shortcutKey: null, ctx: "shared",
      keepOpen: true,
      action: (s, p) => enterFilePicker(p, s, "Open as pane…", (f) => {
        // Place the pane in the gap opposite the editor column shift —
        // see `getInitialPanePosition`. Falls back to the left gutter
        // when "Shift column to" is on the default ("right").
        const { x, y } = paneAnchorClickPoint(s);
        createPane(f.fileId, f.name, f.type, x, y);
      }) },
    { id: "extract-selected", label: "Create New From Selected", icon: icons.newFile, shortcutKey: null, ctx: "shared",
      action: (s) => createNewFromSelected(s) },
    { id: "send-selected", label: "Send Selected", icon: icons.export, shortcutKey: null, ctx: "shared",
      keepOpen: true,
      action: (s, p) => enterSendSelectedPicker(p, s) },
    { id: "open-in-new-window", label: "Open in new window", icon: icons.files, shortcutKey: null, ctx: "desktop",
      action: (s) => {
        const fileId = s.currentNotebookFileId || s.currentProjectId || s.currentFileId;
        const fileType = s.currentNotebookFileId
          ? "notebook"
          : s.currentProjectId ? "project"
          : s.currentFileId ? "document" : null;
        if (!fileId || !fileType) return;
        openInNewWindow(fileId, fileType);
      } },
    { id: "delete-current", label: "Delete current file", icon: icons.trash, shortcutKey: null, ctx: "shared",
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
    { id: "style-lock", label: "Lock style to document", icon: icons.styles, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !s.currentFileId || !!getLockedStyleId(s),
      action: async (s) => { await setLockedStyleId(s, s.settings.activeStyleId || "__default__"); } },
    { id: "use-as-note", label: "Use as note", icon: icons.doc, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !canUseAsNote(s, false),
      action: async (s) => { const n = findNodeByFileId(s.fileTree, s.currentFileId); if (n) await s.toggleUseAsNote(n.id); } },
    { id: "stop-use-as-note", label: "Stop using as note", icon: icons.doc, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !canUseAsNote(s, true),
      action: async (s) => { const n = findNodeByFileId(s.fileTree, s.currentFileId); if (n) await s.toggleUseAsNote(n.id); } },
    { id: "style-unlock", label: "Unlock style from document", icon: icons.styles, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !s.currentFileId || !getLockedStyleId(s),
      // After clearing the lock, fall back to the active desk's saved
      // style (file-opened does the same on switches; here we don't fire it).
      action: async (s) => { await setLockedStyleId(s, null); (await import("./style-application.js")).applyDeskGlobalStyle(s); } },
    { id: "zotero", label: "Zotero: Insert reference", icon: icons.zotero, shortcutKey: "shortcutZotero", ctx: "shared",
      action: async (s) => {
        const { openZoteroModal } = await import("./zotero.js");
        openZoteroModal(s.editor ? s.editor.view : null, s);
      } },
    { id: "zotero-highlights", label: "Zotero: Create highlight browser", icon: icons.zotero, shortcutKey: null, ctx: "shared",
      action: async (s) => {
        const { openZoteroHighlightPane } = await import("./zotero/highlight-pane.js");
        openZoteroHighlightPane(s);
      } },
    { id: "versions", label: "Versions", icon: icons.versions, shortcutKey: null, ctx: "shared",
      action: (s) => s.emit("show-versions-panel") },
    { id: "desktop-set", label: "Use this file as desktop", icon: icons.files, shortcutKey: null, ctx: "shared",
      action: (s) => {
        const fileId = s.currentNotebookFileId || s.currentFileId;
        if (!fileId || s.currentProjectId) return;
        s.setDesktop(fileId);
      } },
    { id: "desktop-clear", label: "Clear desktop", icon: icons.trash, shortcutKey: null, ctx: "shared",
      action: (s) => s.setDesktop(null) },
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
    { id: "backup", label: "Backup App Data", icon: icons.export, shortcutKey: null, ctx: "shared",
      action: async (s) => {
        const { openBackupAppDataModal } = await import("./backup.js");
        openBackupAppDataModal(s);
      } },

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
    { id: "zen", label: "Zen Focus", icon: icons.focus, shortcutKey: "shortcutZenFocus", ctx: "shared",
      action: (s) => s.toggleZenFocus() },
    { id: "word-count", label: "Toggle word count", icon: null, shortcutKey: "shortcutToggleWordCount", ctx: "doc",
      action: async (s) => { const { toggleWordCount } = await import("./editor/plugins/word-count.js"); toggleWordCount(s); } },
    { id: "outline", label: "Outline view", icon: null, shortcutKey: "shortcutToggleOutline", ctx: "doc",
      action: (s) => s.emit("toggle-outline-panel") },
    { id: "proofread", label: "Proofread mode", icon: icons.proofread, shortcutKey: null, ctx: "doc",
      action: (s) => s.toggleProofread() },
    { id: "copy-as-google-doc", label: "Copy as Google Doc", icon: icons.export, shortcutKey: null, ctx: "doc",
      action: (s) => import("./editor/google-docs/copy-command.js").then((m) => s.editor?.view && m.copyAsGoogleDoc(s.editor.view)) },
    { id: "copy-as-html", label: "Copy as HTML", icon: icons.export, shortcutKey: null, ctx: "doc",
      action: (s) => import("./editor/google-docs/copy-command.js").then((m) => s.editor?.view && m.copyAsHtml(s.editor.view)) },

    // === ACTIVE PANE ONLY (doc or notebook) ===
    { id: "fit-pane-gap", label: "Fit pane to gap", icon: icons.pane, shortcutKey: null, ctx: "pane",
      action: () => fitActivePaneToGap() },
    { id: "replace-pane-content", label: "Replace pane content", icon: icons.pane, shortcutKey: null, ctx: "pane",
      keepOpen: true,
      action: (s, p) => enterFilePicker(p, s, "Replace pane content with…", (f) => {
        const id = getActivePaneId();
        if (id) replacePaneContent(id, f.fileId, f.name, f.type);
      }) },

    // === NOTEBOOK ONLY ===
    { id: "nb-shelf", label: "Open shelf", icon: null, shortcutKey: null, ctx: "notebook",
      action: (s) => s.emit("notebook-toggle-shelf") },
    { id: "nb-brainstorm", label: "Start brainstorm", icon: null, shortcutKey: "shortcutNbBrainstorm", ctx: "notebook",
      action: (s) => s.emit("notebook-toggle-brainstorm") },
    { id: "nb-minimap-show", label: "Show minimap", icon: null, shortcutKey: null, ctx: "notebook",
      hiddenIf: (s) => !!s.settings?.minimapVisible,
      action: (s) => s.toggleMinimap() },
    { id: "nb-minimap-hide", label: "Hide minimap", icon: null, shortcutKey: null, ctx: "notebook",
      hiddenIf: (s) => !s.settings?.minimapVisible,
      action: (s) => s.toggleMinimap() },
    { id: "desk-new", label: "New desk", icon: icons.desk, shortcutKey: null, ctx: "shared",
      action: async (s) => {
        const id = await s.createDesk("Untitled desk");
        if (id) await s.setActiveDesk(id);
      } },
    { id: "desk-send", label: "Send this file to another desk", icon: icons.desk, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => (s.settings?.desks || []).length < 2 || !currentFileTreeNodeId(s),
      action: async (s) => {
        const id = currentFileTreeNodeId(s);
        if (!id) return;
        const m = await import("./sidebar/send-to-desk-modal.js");
        m.openSendToDeskModal(s, id, "send");
      } },
    { id: "desk-copy", label: "Copy this file to another desk", icon: icons.desk, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => (s.settings?.desks || []).length < 2 || !currentFileTreeNodeId(s),
      action: async (s) => {
        const id = currentFileTreeNodeId(s);
        if (!id) return;
        const m = await import("./sidebar/send-to-desk-modal.js");
        m.openSendToDeskModal(s, id, "copy");
      } },
    { id: "desk-convert-folder", label: "Convert folder to desk", icon: icons.desk, shortcutKey: null, ctx: "shared",
      keepOpen: true,
      action: async (s, p) => (await import("./state/state-desks-ops.js")).enterConvertFolderPicker(p, s, { typeIcons, fallbackIcon: icons.desk }) },
    { id: "desk-collapse", label: "Collapse desk into folder", icon: icons.desk, shortcutKey: null, ctx: "shared",
      keepOpen: true,
      hiddenIf: (s) => (s.settings?.desks || []).length < 2,
      action: async (s, p) => (await import("./state/state-desks-ops.js")).enterCollapseDeskPicker(p, s, { fallbackIcon: icons.desk }) },
  ];

  return all.filter(cmd => {
    if (typeof cmd.hiddenIf === "function" && cmd.hiddenIf(state)) return false;
    if (cmd.ctx === "shared") return true;
    if (cmd.ctx === "doc") return !inNotebook;
    if (cmd.ctx === "notebook") return inNotebook;
    if (cmd.ctx === "pane") return hasActivePane;
    if (cmd.ctx === "desktop") return desktop;
    return true;
  });
}

/** Walk the file tree and return real document/notebook leaves plus
 *  user-created project nodes, skipping the Images, Trash, and Inbox
 *  subtrees. Inbox is internally typed as a project but functions as a
 *  folder, so it's filtered out of the picker — only "real" projects
 *  (the ones the user can click in the sidebar to open the joined view)
 *  appear here. */
function collectFileLeaves(fileTree) {
  const out = [];
  function walk(nodes) {
    for (const n of nodes) {
      if (n.id === "__trash__" || n.id === "__images__"
          || n.id?.startsWith("__trash__:") || n.id?.startsWith("__images__:")) continue;
      if ((n.type === "document" || n.type === "notebook") && n.fileId) {
        out.push({ id: n.id, name: n.name || "Untitled", type: n.type, fileId: n.fileId });
      }
      // Inbox is internally typed as a project but functions as a
      // folder — skip the project entry but still recurse so docs that
      // live inside Inbox surface in the picker.
      if (n.type === "project" && n.id !== "__inbox__" && !n.id?.startsWith("__inbox__:")) {
        out.push({ id: n.id, name: n.name || "Untitled", type: "project", fileId: n.id });
      }
      if (n.children?.length) walk(n.children);
    }
  }
  walk(fileTree || []);
  return out;
}

/** Active desk's children — Cmd+O / "Open as pane…" scope to this so the picker only surfaces files from the desk the user is in. */
function activeDeskSubtree(s) {
  const t = s.fileTree || [], d = t.filter((n) => n.type === "desk");
  return d.length ? ((d.find((x) => x.id === s.settings?.activeDeskId) || d[0]).children || []) : t;
}

/** Open a file picker filtered to documents (in doc mode) or notebooks
 *  (in notebook mode), excluding the currently-open file, and append the
 *  current selection to whichever the user picks. */
function enterSendSelectedPicker(palette, state) {
  const inNotebook = !!state.currentNotebookFileId;
  const wantedType = inNotebook ? "notebook" : "document";
  const currentId = inNotebook ? state.currentNotebookFileId : state.currentFileId;
  const leaves = collectFileLeaves(activeDeskSubtree(state))
    .filter((f) => f.type === wantedType && f.fileId !== currentId);
  const items = leaves.map((f) => ({
    id: "send-target-" + f.id,
    label: f.name,
    icon: f.type === "notebook" ? icons.notebook : icons.doc,
    shortcutKey: null,
    action: () => sendSelectedToFile(state, f),
  }));
  const placeholder = inNotebook ? "Send selection to notebook…" : "Send selection to document…";
  palette.setItems(items, placeholder);
}

/** Replace the palette's command list with file rows that pipe back into
 *  `onPick(fileLeaf)` on selection. Used by both "Open…" commands.
 *  `includeProjects` is opt-in because the floating-pane path doesn't
 *  support project types — only the main editor can host the joined view. */
function enterFilePicker(palette, state, placeholder, onPick, { includeProjects = false } = {}) {
  let leaves = collectFileLeaves(activeDeskSubtree(state));
  if (!includeProjects) leaves = leaves.filter((f) => f.type !== "project");
  const items = leaves.map((f) => ({
    id: "file-" + f.id,
    label: f.name,
    icon: f.type === "notebook" ? icons.notebook : f.type === "project" ? icons.project : icons.doc,
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
  // Zen Focus is the only mode whose turn-off entry shows up in
  // notebook context too (you can be Zen-focusing a text shape).
  if (state.zenFocus) {
    const zen = [{
      id: "turnoff-zenFocus", label: "Turn off Zen Focus", icon: icons.focus,
      shortcutKey: "shortcutZenFocus", action: (s) => s.toggleZenFocus(),
    }];
    if (state.currentNotebookFileId) return zen;
    // In doc mode, prepend Zen alongside the doc-only turn-offs below.
    return [...zen, ...docModeTurnoffs(state)];
  }
  if (state.currentNotebookFileId) return [];
  return docModeTurnoffs(state);
}

function docModeTurnoffs(state) {
  const modes = [
    { flag: "ratchetMode", label: "Turn off Ratchet mode", icon: icons.ratchet, action: (s) => s.stopRatchet() },
    { flag: "privateMode", label: "Turn off Private mode", icon: icons.private, shortcutKey: "shortcutTogglePrivate", action: (s) => s.togglePrivate() },
    { flag: "typewriterMode", label: "Turn off Typewriter mode", icon: icons.typewriter, shortcutKey: "shortcutTypewriter", action: (s) => s.toggleTypewriter() },
    { flag: "dryMode", label: "Turn off Show repeats", icon: icons.dry, shortcutKey: "shortcutToggleDry", action: (s) => s.toggleDry() },
    { flag: "focusMode", label: "Turn off Highlight sentence", icon: icons.focus, shortcutKey: "shortcutToggleFocus", action: (s) => s.toggleFocus() },
    { flag: "proofreadMode", label: "Turn off Proofread mode", icon: icons.proofread, action: (s) => s.toggleProofread() },
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

  // The keyboardNav flag is cleared lazily inside the row pointerenter
  // handler (mouse pointer only). Avoiding an overlay-wide pointermove
  // listener matters on iPad — pointermove fires for every touch frame,
  // even when the callback would early-return, and the dispatch alone
  // was enough to make scrolling commit only at touch release.

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
    // Hover behaviour: only react to real mouse pointers. On iOS the
    // synthetic mouseenter fires for every row your finger crosses
    // during a touch scroll; toggling an `.active` class across every
    // row each time triggers a full reflow per crossed row, which is
    // what made scrolling visibly stutter.
    //
    // While keyboard nav is engaged, ignore pointerenter entirely —
    // pointerenter fires on the row that re-renders under a stationary
    // cursor after each ArrowUp/Down, which would otherwise yank the
    // highlight back to the mouse position. The overlay-level
    // `mousemove` listener clears `keyboardNav` once the user actually
    // moves the mouse again (mousemove is mouse-only, so iPad touch
    // scrolling never trips it).
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
