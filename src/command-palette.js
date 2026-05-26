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
import {
  canUseAsNote,
  isDesktopTauri,
  formatShortcutKeys,
  buildAppearanceCommands,
} from "./command-palette-helpers.js";
import {
  paneAnchorClickPoint, promptNewNotebookName,
  docContextHasGutterAlready, openNotebookAsGutter,
  enterNotebookGutterPicker, enterPaneCopyPicker,
  enterSendSelectedPicker, enterFilePicker,
} from "./command-palette-pickers.js";
import { deleteTreeNode } from "./state/state-tree.js";
import {
  getActivePaneId, fitActivePaneToGap, createPane,
  replacePaneContent, getPanesForContext, clearPanesForContext,
  setActivePanePinned,
} from "./pane/pane-manager.js";
import { panes } from "./pane/pane-state.js";
import { canUseActivePaneAsGutter, isActivePaneAGutter, useActivePaneAsGutter, stopActivePaneAsGutter } from "./pane/pane-gutter.js";
import { arePanesHiddenForActive } from "./state/state-panes.js";
import { createNewFromSelected } from "./selection-extract.js";
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

/** Mirror of pane-manager's getCurrentContext — used to gate the
 *  pane-management palette entries. Returns "" when nothing is open. */
function activeContextId(s) {
  if (s.currentNotebookFileId) return "nb:" + s.currentNotebookFileId;
  if (s.currentProjectId) return "pj:" + s.currentProjectId;
  if (s.currentFileId) return "doc:" + s.currentFileId;
  return "";
}

function activeContextHasPanes(s) {
  const ctx = activeContextId(s);
  return ctx ? getPanesForContext(ctx).length > 0 : false;
}

/** Wrap inner SVG markup (paths / polygons / etc.) in an `<svg>` of the
 *  given viewBox so it can be dropped straight into an `iconEl`. */
function wrapSvg(inner, viewBox = "0 0 24 24") {
  return `<svg viewBox="${viewBox}">${inner}</svg>`;
}

function svgInner(raw) {
  return raw.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "").trim();
}

/** Lazy-import a Google Docs link-command and return an action fn that
 *  surfaces auth/API errors via window.alert (cheap, accessible). */
function _gdocAction(method) {
  return (s) => import("./google-docs/link-command.js")
    .then((m) => m[method](s))
    .catch((e) => { if (e) { console.error("[google-docs]", e); window.alert(e.message || String(e)); } });
}

/** Each icon is the full `<svg …>…</svg>` markup so a row can drop it
 *  straight into the icon slot without the renderer needing to know
 *  about per-icon viewBox sizing. The doc / notebook / project /
 *  inbox / images / trash glyphs are reused verbatim from the sidebar
 *  via `typeIcons` so the palette and the file tree show the exact
 *  same visual language. */
const _wrapIcon = (raw) => wrapSvg(svgInner(raw));
const icons = {
  newFile: _wrapIcon(newFileRaw), files: _wrapIcon(filesRaw), desk: _wrapIcon(deskRaw),
  pane: _wrapIcon(paneRaw), ratchet: _wrapIcon(ratchetRaw), private: _wrapIcon(privateRaw),
  typewriter: _wrapIcon(typewriterRaw), dry: _wrapIcon(dryRaw), focus: _wrapIcon(focusRaw),
  versions: _wrapIcon(versionsRaw), export: _wrapIcon(exportRaw), styles: _wrapIcon(stylesRaw),
  zotero: _wrapIcon(zoteroRaw),
  // Stroke-only "Aa" with a shallow cross overlay; picks up `stroke: currentColor`.
  proofread: `<svg viewBox="0 0 24 24"><path d="M3 19 L7 5 L11 19 M4.5 14 H9.5"/><circle cx="17" cy="14.5" r="3.5"/><path d="M20.5 11.5 V18"/><line x1="2" y1="14" x2="22" y2="10"/><line x1="2" y1="10" x2="22" y2="14"/></svg>`,
  doc: typeIcons.document, notebook: typeIcons.notebook, project: typeIcons.project, trash: typeIcons.trash,
};

/** Build the per-style "Use Style: <name>" command rows. Mirrors the
 *  click-a-row behaviour of the retired sidebar styles panel: if the
 *  current doc carries a locked style, switching also updates the lock;
 *  otherwise the choice flows through the per-desk style. */
function buildUseStyleCommands(state) {
  const styles = state.settings?.styles || [];
  const activeId = state.settings?.activeStyleId;
  const entries = [];
  function makeEntry(id, name) {
    const isActive = (id || null) === (activeId || null);
    return {
      id: id ? `use-style-${id}` : "use-style-default",
      label: `Use Style: ${name}${isActive ? " ✓" : ""}`,
      icon: icons.styles,
      shortcutKey: null,
      ctx: "shared",
      action: async (s) => {
        const { getLockedStyleId, setLockedStyleId } = await import("./sidebar/styles-panel.js");
        const lockedId = getLockedStyleId(s);
        s.updateSettings({ activeStyleId: id || null });
        if (lockedId) {
          await setLockedStyleId(s, id || null);
        } else if (typeof s.setDeskGlobalStyleId === "function") {
          await s.setDeskGlobalStyleId(id || null);
        }
        s.emit("style-changed");
      },
    };
  }
  entries.push(makeEntry(null, "Default"));
  for (const st of styles) {
    if (st && st.id) entries.push(makeEntry(st.id, st.name || "Untitled"));
  }
  return entries;
}

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
      action: (s) => promptNewNotebookName((name) => s.createNotebook(name)) },
    { id: "new-doc-pane", label: "New document as pane", icon: icons.pane, shortcutKey: null, ctx: "shared",
      action: async (s) => {
        const created = await s.newFile(null, { openImmediately: false });
        if (created) {
          const { x, y } = paneAnchorClickPoint(s);
          createPane(created.fileId, created.name, "document", x, y);
        }
      } },
    { id: "new-notebook-pane", label: "New notebook as pane", icon: icons.pane, shortcutKey: null, ctx: "shared",
      action: (s) => promptNewNotebookName(async (name) => {
        const created = await s.createNotebook(name, null, { openImmediately: false });
        if (created) {
          const { x, y } = paneAnchorClickPoint(s);
          createPane(created.fileId, created.name, "notebook", x, y);
        }
      }) },
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
    { id: "styles-edit", label: "Edit Styles", icon: icons.styles, shortcutKey: null, ctx: "shared",
      action: async (s) => {
        const { openStyleEditorModal } = await import("./sidebar/style-modal.js");
        openStyleEditorModal(s);
      } },
    // One "Use Style: <name>" entry per style (plus Default). Selecting a
    // row writes the active style — same routing as clicking a style row
    // in the old sidebar list.
    ...buildUseStyleCommands(state),
    ...buildAppearanceCommands(state),
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
    { id: "zotero-save-pdf", label: "Zotero: Save PDF", icon: icons.zotero, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !s.settings.zoteroUserId || !s.settings.zoteroApiKey,
      action: async (s) => {
        const { openZoteroSavePdfModal } = await import("./pdf/zotero-save-pdf.js");
        openZoteroSavePdfModal(s);
      } },
    { id: "pdf-update-annotations", label: "PDF: Update Annotations", icon: icons.zotero, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => {
        if (!s.currentPdfFileId) return true;
        const node = findNodeByFileId(s.fileTree, s.currentPdfFileId);
        return !node?.zoteroAttKey;
      },
      action: async (s) => {
        const { refreshPdfAnnotations } = await import("./pdf/pdf-bridge.js");
        await refreshPdfAnnotations(s);
      } },
    { id: "zotero-update", label: "Update Zotero References", icon: icons.zotero, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !s.settings.zoteroUserId || !s.settings.zoteroApiKey,
      action: async (s) => {
        const { startZoteroUpdate } = await import("./sidebar/sidebar-progress.js");
        startZoteroUpdate(s);
      } },
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
    { id: "focus", label: "Focus mode", icon: icons.focus, shortcutKey: "shortcutToggleFocus", ctx: "doc",
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
    { id: "add-notebook-as-gutter", label: "Add notebook as gutter", icon: icons.notebook, shortcutKey: null, ctx: "doc",
      keepOpen: true,
      hiddenIf: (s) => docContextHasGutterAlready(s),
      action: (s, p) => enterNotebookGutterPicker(p, s) },
    { id: "new-notebook-as-gutter", label: "New notebook as gutter", icon: icons.notebook, shortcutKey: null, ctx: "doc",
      hiddenIf: (s) => docContextHasGutterAlready(s),
      action: (s) => promptNewNotebookName(async (name) => {
        const created = await s.createNotebook(name, null, { openImmediately: false });
        if (created) await openNotebookAsGutter(s, created.fileId, created.name);
      }) },
    { id: "google-import", label: "Import from Google Doc", icon: icons.export, shortcutKey: null, ctx: "shared", action: _gdocAction("importFromGoogleDoc") },
    { id: "google-link", label: "Link Document to Google Doc", icon: icons.export, shortcutKey: null, ctx: "doc",
      hiddenIf: (s) => !!s.settings?.googleDocLinks?.[s.currentFileId], action: _gdocAction("linkCurrentDocument") },
    { id: "google-create-from-current", label: "Create Google Doc from current", icon: icons.export, shortcutKey: null, ctx: "doc",
      hiddenIf: (s) => !!s.settings?.googleDocLinks?.[s.currentFileId], action: _gdocAction("createGoogleDocFromCurrent") },
    { id: "google-unlink", label: "Unlink Document from Google Doc", icon: icons.trash, shortcutKey: null, ctx: "doc",
      hiddenIf: (s) => !s.settings?.googleDocLinks?.[s.currentFileId], action: _gdocAction("unlinkCurrentDocument") },

    // === ACTIVE PANE ONLY (doc or notebook) ===
    { id: "fit-pane-gap", label: "Fit pane to gap", icon: icons.pane, shortcutKey: null, ctx: "pane",
      hiddenIf: () => isActivePaneAGutter(),
      action: () => fitActivePaneToGap() },
    { id: "replace-pane-content", label: "Replace pane content", icon: icons.pane, shortcutKey: null, ctx: "pane",
      keepOpen: true,
      action: (s, p) => enterFilePicker(p, s, "Replace pane content with…", (f) => {
        const id = getActivePaneId();
        if (id) replacePaneContent(id, f.fileId, f.name, f.type);
      }) },
    { id: "pane-gutter-on", label: "Use Pane as Gutter", icon: icons.pane, shortcutKey: null, ctx: "pane", hiddenIf: () => !canUseActivePaneAsGutter(), action: () => useActivePaneAsGutter() },
    { id: "pane-gutter-off", label: "Stop using Pane as Gutter", icon: icons.pane, shortcutKey: null, ctx: "pane", hiddenIf: () => !isActivePaneAGutter(), action: () => stopActivePaneAsGutter() },
    { id: "pane-pin", label: "Pin pane across documents", icon: icons.pane, shortcutKey: null, ctx: "pane", hiddenIf: () => !!panes.get(getActivePaneId())?.pinned, action: () => setActivePanePinned(true) },
    { id: "pane-unpin", label: "Unpin pane", icon: icons.pane, shortcutKey: null, ctx: "pane", hiddenIf: () => !panes.get(getActivePaneId())?.pinned, action: () => setActivePanePinned(false) },

    // === PANE SET (current document's panes) ===
    { id: "panes-hide", label: "Hide panes", icon: icons.pane, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !activeContextHasPanes(s) || arePanesHiddenForActive(s),
      action: (s) => s.hidePanesForActive() },
    { id: "panes-show", label: "Show panes", icon: icons.pane, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !activeContextHasPanes(s) || !arePanesHiddenForActive(s),
      action: (s) => s.showPanesForActive() },
    { id: "panes-clear", label: "Clear panes", icon: icons.trash, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !activeContextHasPanes(s),
      action: (s) => { const ctx = activeContextId(s); if (ctx) clearPanesForContext(ctx); } },
    { id: "panes-copy-to", label: "Copy panes to Document", icon: icons.pane, shortcutKey: null, ctx: "shared",
      keepOpen: true,
      hiddenIf: (s) => !activeContextHasPanes(s),
      action: (s, p) => enterPaneCopyPicker(p, s, /*switchAfter=*/false) },
    { id: "panes-switch-to", label: "Switch panes to Document", icon: icons.pane, shortcutKey: null, ctx: "shared",
      keepOpen: true,
      hiddenIf: (s) => !activeContextHasPanes(s),
      action: (s, p) => enterPaneCopyPicker(p, s, /*switchAfter=*/true) },

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
    { flag: "focusMode", label: "Turn off Focus mode", icon: icons.focus, shortcutKey: "shortcutToggleFocus", action: (s) => s.toggleFocus() },
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

  // keyboardNav clears in the row pointerenter handler (mouse only);
  // an overlay-wide pointermove would fire per touch frame on iPad.

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
