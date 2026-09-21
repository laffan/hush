/**
 * Command definitions for the command palette. Extracted from
 * command-palette.js so that file stays under the 700-line cap.
 *
 * Exports the `icons` object (shared with pickers / helpers), the
 * main `buildCommands(state)` factory. The "Turn off <mode>" entries
 * live in `command-palette-turnoffs.js`.
 */
import { openFindReplace, openQuickFindBar } from "./editor/find-replace.js";
import { openSettingsWindow } from "./settings/settings-ui.js";
import { findNodeByFileId } from "./state/tree-helpers.js";
import {
  canUseAsNote,
  isDesktopTauri,
  isIOSTauri,
  buildAppearanceCommands,
  currentFileDesktopTarget,
} from "./command-palette-helpers.js";
import {
  paneAnchorClickPoint, promptNewNotebookName, promptNewStackName,
  enterNotebookGutterPicker, enterPaneCopyPicker,
  enterSendSelectedPicker, enterFilePicker, enterDeskPicker,
} from "./command-palette-pickers.js";
import { addGutter, openGutter, closeGutter, gutterAddHidden, gutterOpenHidden, gutterCloseHidden } from "./project/gutter-commands.js";
import { toggleModeOnContext, hasActiveDocSurface } from "./state/mode-context.js";
import { deleteTreeNode } from "./state/state-tree.js";
import {
  getActivePaneId, fitActivePaneToGap, createPane,
  replacePaneContent, getPanesForContext, clearPanesForContext,
  setActivePanePinned, closePane,
} from "./pane/pane-manager.js";
import { panes } from "./pane/pane-state.js";
import { isActivePaneAGutter } from "./project/gutter.js";
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
import settingsRaw from "./sidebar/sidebar_icons/settings.svg?raw";
import searchRaw from "./sidebar/sidebar_icons/search.svg?raw";
import expandRaw from "./sidebar/sidebar_icons/expand.svg?raw";
import { typeIcons, showDeleteConfirmModal } from "./sidebar/files-panel-shared.js";
import { getActiveModeContext } from "./state/mode-context.js";
import { openShuffleEditor, shuffleSelectionAvailable } from "./editor/shuffle-editor.js";
import { addSticky, canAddFileSticky, canAddProjectSticky } from "./sticky/sticky-notes.js";
import {
  foldCurrentSection, unfoldCurrentSection, foldSelection,
  foldAllSections, unfoldAllSections, foldAllAtLevel,
} from "./editor/folding.js";
import { insertDate, insertDateTime } from "./editor/insert-date.js";
import { currentWordLimit, setWordLimit, wordLimitTargetFileId } from "./editor/word-limit-store.js";
import {
  canConvertDocToOutline, convertDocToOutline,
  canConvertDocToList, convertDocToList,
  isOutlineModeOn, toggleOutlineMode,
  canConvertNotebookToOutline, convertNotebookToOutline,
} from "./outline/outline-commands.js";
import { buildDeskCommands } from "./command-palette-desk-commands.js";
import { buildGoogleCommands } from "./command-palette-google-commands.js";

/** Resolve the editor view the fold commands should act on: the focused
 *  pane / stack column if one owns the active mode context, else the
 *  main editor. */
function foldView(s) {
  const ctx = getActiveModeContext(s);
  return ctx?.view || s.editor?.view || null;
}

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
  zotero: _wrapIcon(zoteroRaw), settings: _wrapIcon(settingsRaw), search: _wrapIcon(searchRaw),
  expand: _wrapIcon(expandRaw),
  // Stroke-only "Aa" with a shallow cross overlay; picks up `stroke: currentColor`.
  proofread: `<svg viewBox="0 0 24 24"><path d="M3 19 L7 5 L11 19 M4.5 14 H9.5"/><circle cx="17" cy="14.5" r="3.5"/><path d="M20.5 11.5 V18"/><line x1="2" y1="14" x2="22" y2="10"/><line x1="2" y1="10" x2="22" y2="14"/></svg>`,
  // Keyboard glyph (mirrors the Shortcuts settings-tab icon).
  keyboard: `<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="6" y1="9" x2="6" y2="9"/><line x1="10" y1="9" x2="10" y2="9"/><line x1="14" y1="9" x2="14" y2="9"/><line x1="18" y1="9" x2="18" y2="9"/><line x1="6" y1="13" x2="6" y2="13"/><line x1="18" y1="13" x2="18" y2="13"/><line x1="8" y1="16" x2="16" y2="16"/></svg>`,
  doc: typeIcons.document, notebook: typeIcons.notebook, project: typeIcons.project, trash: typeIcons.trash,
  stack: typeIcons.stack,
  // Lines of text beside a hash — the count. Both halves are drawn big
  // enough to survive the 18 px the palette renders them at; a smaller
  // hash tucked under the text turned to mush at that size.
  wordCount: `<svg viewBox="0 0 24 24"><line x1="3" y1="7" x2="12" y2="7"/><line x1="3" y1="12" x2="12" y2="12"/><line x1="3" y1="17" x2="9" y2="17"/><path d="M17.2 5.5 L15.8 18.5 M21.7 5.5 L20.3 18.5 M15 9.8 H22.4 M14.3 14.6 H21.7"/></svg>`,
  // The same lines over a rule with end stops — the cap they run up to.
  wordLimit: `<svg viewBox="0 0 24 24"><line x1="3" y1="5" x2="21" y2="5"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="15" x2="13" y2="15"/><path d="M3 19.5 H21 M3 17.5 V21.5 M21 17.5 V21.5"/></svg>`,
  // Chevron-down = collapse a section; chevron-right = expand it back.
  fold: `<svg viewBox="0 0 24 24"><path d="M6 9 L12 15 L18 9"/></svg>`,
  unfold: `<svg viewBox="0 0 24 24"><path d="M9 6 L15 12 L9 18"/></svg>`,
  // Two crossing arrows — the standard "shuffle" glyph.
  shuffle: `<svg viewBox="0 0 24 24"><path d="M3 7 H7 L17 17 H21 M17 7 H21 M3 17 H7 L11 13 M14 10 L17 7 M18 4 L21 7 L18 10 M18 14 L21 17 L18 20"/></svg>`,
  // Clock face with a counter-clockwise arrow — session history.
  history: `<svg viewBox="0 0 24 24"><path d="M4 12 a8 8 0 1 0 2.5 -5.8 M4 4 v4 h4"/><path d="M12 8 v4 l3 2"/></svg>`,
  // Square note with a folded bottom-right corner — sticky note.
  sticky: `<svg viewBox="0 0 24 24"><path d="M4 4 h16 v10 l-6 6 H4 z"/><path d="M20 14 h-6 v6"/></svg>`,
  // Calendar grid — Insert Date / Date-Time.
  calendar: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/></svg>`,
  // Outline — a framed checklist, which is exactly what an outline is:
  // a nested checklist with a border round it.
  outline: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M6.5 9 L8 10.4 L10.5 7.6"/><line x1="12.5" y1="9" x2="18" y2="9"/><path d="M6.5 15.4 L8 16.8 L10.5 14"/><line x1="12.5" y1="15.4" x2="18" y2="15.4"/></svg>`,
  // Overview — a page with the right-hand bar split off it, carrying the
  // short rules that stand for the heading list.
  overview: `<svg viewBox="0 0 24 24"><rect x="2.5" y="4" width="19" height="16" rx="2"/><line x1="14.5" y1="4" x2="14.5" y2="20"/><line x1="16.8" y1="8.5" x2="19.5" y2="8.5"/><line x1="16.8" y1="12" x2="19.5" y2="12"/><line x1="16.8" y1="15.5" x2="18.4" y2="15.5"/></svg>`,
  // Proofread notebook — the notebook dot-grid with its middle row of
  // dots replaced by a solid rule, matching the file tree's glyph for
  // the same thing.
  proofreadPdf: `<svg viewBox="0 0 24 24"><circle cx="5" cy="5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="5" r="1.4" fill="currentColor" stroke="none"/><circle cx="5" cy="19" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="19" r="1.4" fill="currentColor" stroke="none"/><line x1="3" y1="12" x2="21" y2="12"/></svg>`,
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
      section: "Styles",
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

// Context: "shared" = always shown, "doc" = doc/project only, "notebook" = notebook only, "stack" = stack only
function buildCommands(state) {
  const inNotebook = !!state.currentNotebookFileId;
  const inStack = !!state.currentStackFileId;
  const hasActivePane = getActivePaneId() != null;
  const desktop = isDesktopTauri();
  const ipad = isIOSTauri();

  const all = [
    // === SHARED ===
    { id: "new-doc", section: "Create", label: "New document", icon: icons.doc, shortcutKey: "shortcutNewFile", ctx: "shared",
      action: (s) => s.newFile() },
    { id: "new-notebook", section: "Create", label: "New notebook", icon: icons.notebook, shortcutKey: "shortcutNewNotebook", ctx: "shared",
      action: (s) => promptNewNotebookName((name) => s.createNotebook(name)) },
    { id: "new-stack", section: "Create", label: "New stack", icon: icons.stack, shortcutKey: null, ctx: "shared", action: (s) => promptNewStackName((name) => s.createStack(name)) },
    { id: "new-doc-pane", section: "Create", label: "New document as pane", icon: icons.pane, shortcutKey: "shortcutNewFilePane", ctx: "shared",
      action: async (s) => {
        const created = await s.newFile(null, { openImmediately: false });
        if (created) {
          const { x, y } = paneAnchorClickPoint(s);
          createPane(created.fileId, created.name, "document", x, y);
        }
      } },
    { id: "new-notebook-pane", section: "Create", label: "New notebook as pane", icon: icons.pane, shortcutKey: "shortcutNewNotebookPane", ctx: "shared",
      action: (s) => promptNewNotebookName(async (name) => {
        const created = await s.createNotebook(name, null, { openImmediately: false });
        if (created) {
          const { x, y } = paneAnchorClickPoint(s);
          createPane(created.fileId, created.name, "notebook", x, y);
        }
      }) },
    { id: "open-file", section: "Open", label: "Open document, notebook, or project", icon: icons.files, shortcutKey: null, ctx: "shared",
      keepOpen: true,
      action: (s, p) => enterFilePicker(p, s, "Open file…", (f) => {
        if (f.type === "notebook") s.openNotebook(f.fileId);
        else if (f.type === "project") s.openProject(f.fileId);
        else if (f.type === "stack") s.openStack(f.fileId);
        else s.openFile(f.fileId);
      }, { includeProjects: true }) },
    { id: "open-pane", section: "Open", label: "Open as pane", icon: icons.pane, shortcutKey: null, ctx: "shared",
      keepOpen: true,
      action: (s, p) => enterFilePicker(p, s, "Open as pane…", (f) => {
        // Place the pane in the gap opposite the editor column shift —
        // see `getInitialPanePosition`. Falls back to the left gutter
        // when "Shift column to" is on the default ("right").
        const { x, y } = paneAnchorClickPoint(s);
        createPane(f.fileId, f.name, f.type, x, y);
      }) },
    // === DESKTOPS (canvas overview of a project) ===
    { id: "open-project-desktop", section: "Desktops", label: "Open Project Desktop", icon: icons.project, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !s.currentProjectId,
      action: async (s) => {
        (await import("./desktop/desktop-view.js")).openDesktop(s, s.currentProjectId);
      } },
    // Shown while a file that lives inside a project is open: jumps to
    // that project's Desktop with the file's thumbnail selected + centred.
    { id: "view-in-desktop", section: "Desktops", label: "View in Desktop", icon: icons.project, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !currentFileDesktopTarget(s),
      action: async (s) => {
        const target = currentFileDesktopTarget(s);
        if (!target) return;
        (await import("./desktop/desktop-view.js")).openDesktop(s, target.projectId, { focusKey: target.focusKey });
      } },
    { id: "refresh-desktop-thumbnails", section: "Desktops", label: "Refresh Desktop Thumbnails", icon: icons.files, shortcutKey: null, ctx: "shared",
      // Shown only while a Desktop is open (checked via the body class so
      // the palette doesn't pull the notebook renderer into its graph).
      hiddenIf: () => !document.body.classList.contains("desktop-active"),
      action: async () => {
        (await import("./desktop/desktop-view.js")).refreshDesktopThumbnails();
      } },
    { id: "extract-selected", section: "Create", label: "Create New From Selected", icon: icons.newFile, shortcutKey: null, ctx: "shared",
      action: (s) => createNewFromSelected(s) },
    { id: "send-selected", section: "Document", label: "Send Selected", icon: icons.export, shortcutKey: null, ctx: "shared",
      keepOpen: true,
      action: (s, p) => enterSendSelectedPicker(p, s) },
    { id: "open-in-new-window", section: "Open", label: "Open in new window", icon: icons.files, shortcutKey: null, ctx: "multiwindow",
      // Opens the active file/project in a real second window. Desktop and
      // iPad share the same path now: a wry-managed WebviewWindow seeded
      // via `index.html#file=…` (iPad multi-window is native since Tauri
      // 2.11 — see MULTI-WINDOW-TAURI.md).
      action: (s) => {
        const fileId = s.currentNotebookFileId || s.currentStackFileId || s.currentPdfFileId
          || s.currentProjectId || s.currentFileId;
        const fileType = s.currentNotebookFileId ? "notebook"
          : s.currentStackFileId ? "stack"
          : s.currentPdfFileId ? "pdf"
          : s.currentProjectId ? "project"
          : s.currentFileId ? "document" : null;
        if (!fileId || !fileType) return;
        // Seed the new window with this window's active desk so it opens
        // where the user is working (desks stay independent afterwards).
        openInNewWindow(fileId, fileType, s.getActiveDesk?.()?.id || null);
      } },
    { id: "delete-current", section: "Document", label: "Delete current file", icon: icons.trash, shortcutKey: null, ctx: "shared",
      // In-app modal, not `window.confirm`: the native dialog doesn't
      // reliably block in the WebView — it can return before the user has
      // answered, so the file was already in the Trash behind the prompt
      // that was still asking whether to put it there.
      action: (s) => {
        const fileId = s.currentNotebookFileId || s.currentFileId;
        if (!fileId) return;
        const node = findNodeByFileId(s.fileTree, fileId);
        if (!node) return;
        showDeleteConfirmModal(
          `Move "${node.name || "Untitled"}" to Trash?`,
          "You can restore it from the Trash afterwards.",
          () => { void deleteTreeNode(s, node.id); },
        );
      } },
    { id: "files", section: "Open", label: "Files", icon: icons.files, shortcutKey: "shortcutToggleSidebar", ctx: "shared",
      action: (s) => s.emit("toggle-left-panel") },
    { id: "styles-edit", section: "Styles", label: "Edit Styles", icon: icons.styles, shortcutKey: null, ctx: "shared",
      action: async (s) => {
        const { openStyleEditorModal } = await import("./sidebar/style-modal.js");
        openStyleEditorModal(s);
      } },
    // One "Use Style: <name>" entry per style (plus Default). Selecting a
    // row writes the active style — same routing as clicking a style row
    // in the old sidebar list.
    ...buildUseStyleCommands(state),
    ...buildAppearanceCommands(state),
    { id: "style-lock", section: "Styles", label: "Lock style to document", icon: icons.styles, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !s.currentFileId || !!getLockedStyleId(s),
      action: async (s) => { await setLockedStyleId(s, s.settings.activeStyleId || "__default__"); } },
    { id: "use-as-note", section: "Document", label: "Use as note", icon: icons.doc, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !canUseAsNote(s, false),
      action: async (s) => { const n = findNodeByFileId(s.fileTree, s.currentFileId); if (n) await s.toggleUseAsNote(n.id); } },
    { id: "stop-use-as-note", section: "Document", label: "Stop using as note", icon: icons.doc, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !canUseAsNote(s, true),
      action: async (s) => { const n = findNodeByFileId(s.fileTree, s.currentFileId); if (n) await s.toggleUseAsNote(n.id); } },
    { id: "style-unlock", section: "Styles", label: "Unlock style from document", icon: icons.styles, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !s.currentFileId || !getLockedStyleId(s),
      // After clearing the lock, fall back to the active desk's saved
      // style (file-opened does the same on switches; here we don't fire it).
      action: async (s) => { await setLockedStyleId(s, null); (await import("./style-application.js")).applyDeskGlobalStyle(s); } },
    { id: "zotero", section: "Research", label: "Zotero: Insert reference", icon: icons.zotero, shortcutKey: "shortcutZotero", ctx: "shared",
      action: async (s) => {
        const { openZoteroModal } = await import("./zotero.js");
        openZoteroModal(s.editor ? s.editor.view : null, s);
      } },
    { id: "zotero-highlights", section: "Research", label: "Zotero: Create highlight browser", icon: icons.zotero, shortcutKey: null, ctx: "shared",
      action: async (s) => {
        const { openZoteroHighlightPane } = await import("./zotero/highlight-pane.js");
        openZoteroHighlightPane(s);
      } },
    { id: "zotero-save-pdf", section: "Research", label: "Zotero: Save PDF", icon: icons.zotero, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !s.settings.zoteroUserId || !s.settings.zoteroApiKey,
      action: async (s) => {
        const { openZoteroSavePdfModal } = await import("./pdf/zotero-save-pdf.js");
        openZoteroSavePdfModal(s);
      } },
    { id: "proofread-pdf", section: "Research", label: "Create Proofread Notebook", icon: icons.proofreadPdf, shortcutKey: null, ctx: "shared",
      keywords: "proofread pdf proof annotate mark up pages notebook split grab",
      hiddenIf: (s) => !s.currentPdfFileId,
      action: async (s) => {
        const { createProofNotebook } = await import("./pdf/pdf-proofread.js");
        await createProofNotebook(s, s.currentPdfFileId);
      } },
    { id: "pdf-update-annotations", section: "Research", label: "PDF: Update Annotations", icon: icons.zotero, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => {
        if (!s.currentPdfFileId) return true;
        const node = findNodeByFileId(s.fileTree, s.currentPdfFileId);
        return !node?.zoteroAttKey;
      },
      action: async (s) => {
        const { refreshPdfAnnotations } = await import("./pdf/pdf-bridge.js");
        await refreshPdfAnnotations(s);
      } },
    { id: "zotero-update", section: "Research", label: "Update Zotero References", icon: icons.zotero, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !s.settings.zoteroUserId || !s.settings.zoteroApiKey,
      action: async (s) => {
        const { startZoteroUpdate } = await import("./sidebar/sidebar-progress.js");
        startZoteroUpdate(s);
      } },
    { id: "convert-project-to-doc", section: "Document", label: "Convert this Project to Doc", icon: icons.doc, shortcutKey: null, ctx: "doc",
      hiddenIf: (s) => !s.currentProjectId,
      action: async (s) => {
        const ok = window.confirm("Convert this project to a tabbed document? Each document in the project will become a tab.");
        if (ok) await s.convertProjectToDoc(s.currentProjectId);
      } },
    { id: "convert-doc-to-project", section: "Document", label: "Convert this Doc to Project", icon: icons.project, shortcutKey: null, ctx: "doc",
      hiddenIf: (s) => !s.currentFileId,
      action: async (s) => {
        const { findNodeByFileId } = await import("./state/tree-helpers.js");
        const node = findNodeByFileId(s.fileTree, s.currentFileId);
        if (!node) return;
        const ok = window.confirm("Convert this document to a project? Each tab will become a separate document.");
        if (ok) await s.convertDocToProject(node.id);
      } },
    { id: "split-at-headings", section: "Document", label: "Split Headings to Files", icon: icons.doc, shortcutKey: null, ctx: "doc",
      hiddenIf: (s) => !s.currentFileId,
      action: async (s) => {
        const { openSplitAtHeadingsModal } = await import("./sidebar/split-at-headings-modal.js");
        await openSplitAtHeadingsModal(s);
      } },
    { id: "convert-headings-to-tabs", section: "Document", label: "Convert Headings to Tabs", icon: icons.doc, shortcutKey: null, ctx: "doc",
      hiddenIf: (s) => !s.currentFileId,
      action: async (s) => {
        const { openConvertHeadingsToTabsModal } = await import("./sidebar/convert-headings-to-tabs-modal.js");
        await openConvertHeadingsToTabsModal(s);
      } },
    { id: "fold-section", section: "Folding", label: "Fold current section", icon: icons.fold, shortcutKey: null, ctx: "doc",
      action: (s) => { const v = foldView(s); if (v) foldCurrentSection(v); } },
    { id: "unfold-section", section: "Folding", label: "Unfold current section", icon: icons.unfold, shortcutKey: null, ctx: "doc",
      action: (s) => { const v = foldView(s); if (v) unfoldCurrentSection(v); } },
    { id: "fold-selection", section: "Folding", label: "Fold selection", icon: icons.fold, shortcutKey: null, ctx: "doc",
      hiddenIf: (s) => { const v = foldView(s); return !v || v.state.selection.main.empty; },
      action: (s) => { const v = foldView(s); if (v) foldSelection(v); } },
    { id: "fold-all", section: "Folding", label: "Fold all sections", icon: icons.fold, shortcutKey: null, ctx: "doc",
      action: (s) => { const v = foldView(s); if (v) foldAllSections(v); } },
    { id: "unfold-all", section: "Folding", label: "Unfold all sections", icon: icons.unfold, shortcutKey: null, ctx: "doc",
      action: (s) => { const v = foldView(s); if (v) unfoldAllSections(v); } },
    { id: "fold-h1", section: "Folding", label: "Fold all H1", icon: icons.fold, shortcutKey: null, ctx: "doc",
      action: (s) => { const v = foldView(s); if (v) foldAllAtLevel(v, 1); } },
    { id: "fold-h2", section: "Folding", label: "Fold all H2", icon: icons.fold, shortcutKey: null, ctx: "doc",
      action: (s) => { const v = foldView(s); if (v) foldAllAtLevel(v, 2); } },
    { id: "fold-h3", section: "Folding", label: "Fold all H3", icon: icons.fold, shortcutKey: null, ctx: "doc",
      action: (s) => { const v = foldView(s); if (v) foldAllAtLevel(v, 3); } },
    // === PROPERTIES (metadata frontmatter) ===
    { id: "properties-view", section: "Document", label: "View properties", icon: icons.doc, shortcutKey: "shortcutToggleProperties", ctx: "doc",
      hiddenIf: (s) => !!s.settings?.propertiesVisible,
      action: (s) => import("./editor/plugins/properties.js").then((m) => m.togglePropertiesVisibility(s)) },
    { id: "properties-hide", section: "Document", label: "Hide properties", icon: icons.doc, shortcutKey: "shortcutToggleProperties", ctx: "doc",
      hiddenIf: (s) => !s.settings?.propertiesVisible,
      action: (s) => import("./editor/plugins/properties.js").then((m) => m.togglePropertiesVisibility(s)) },
    { id: "properties-add", section: "Document", label: "Add property", icon: icons.doc, shortcutKey: null, ctx: "doc",
      action: (s) => import("./editor/plugins/properties.js").then((m) => m.addPropertyFromPalette(s)) },
    // === STICKY NOTES ===
    // Temporary reminders floating above every surface. File + project
    // stickies show while their target (or any file in the project) is
    // open; desk stickies while their desk is active; global always.
    { id: "sticky-file", section: "Sticky Notes", label: "Add File Sticky", icon: icons.sticky, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !canAddFileSticky(s),
      action: (s) => addSticky(s, "file") },
    { id: "sticky-project", section: "Sticky Notes", label: "Add Project Sticky", icon: icons.sticky, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !canAddProjectSticky(s),
      action: (s) => addSticky(s, "project") },
    { id: "sticky-desk", section: "Sticky Notes", label: "Add Desk Sticky", icon: icons.sticky, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !s.getActiveDesk?.(),
      action: (s) => addSticky(s, "desk") },
    { id: "sticky-global", section: "Sticky Notes", label: "Add Global Sticky", icon: icons.sticky, shortcutKey: null, ctx: "shared",
      action: (s) => addSticky(s, "global") },
    { id: "versions", section: "Document", label: "Versions", icon: icons.versions, shortcutKey: null, ctx: "shared",
      action: (s) => s.emit("show-versions-panel") },
    { id: "history", section: "Document", label: "History", icon: icons.history, shortcutKey: null, ctx: "shared",
      action: (s) => s.emit("show-history-panel") },
    { id: "export", section: "Document", label: "Export", icon: icons.export, shortcutKey: null, ctx: "shared",
      action: (s) => s.emit("export-current-file") },
    { id: "export-hushproject", section: "Document", label: "Export Project (.hushproject)", icon: icons.export, shortcutKey: null, ctx: "doc",
      hiddenIf: (s) => !s.currentProjectId,
      action: (s) => import("./project/project-export.js").then((m) => m.exportCurrentProject(s)) },
    { id: "fullscreen", section: "View", label: "Toggle fullscreen", icon: icons.expand, shortcutKey: "shortcutOpenFullscreen", ctx: "shared",
      action: (s) => s.toggleFullscreen() },
    { id: "find", section: "Document", label: "Find & replace", icon: icons.search, shortcutKey: "shortcutFind", ctx: "shared",
      action: (s) => { if (s.editor) openFindReplace(s.editor.view, s); } },
    { id: "find-in-doc", section: "Document", label: "Find in document", icon: icons.search, shortcutKey: "shortcutQuickFind", ctx: "doc",
      action: (s) => { if (s.editor) openQuickFindBar(s.editor.view, s); } },
    { id: "show-shortcuts", section: "App", label: "Show Shortcuts", icon: icons.keyboard, shortcutKey: null, ctx: "shared",
      action: async (s) => {
        const { openShortcutsModal } = await import("./ui/shortcuts-modal.js");
        openShortcutsModal(s);
      } },
    { id: "settings", section: "App", label: "Settings", icon: icons.settings, shortcutKey: null, ctx: "shared",
      action: (s) => openSettingsWindow(s) },
    { id: "backup", section: "App", label: "Backup App Data", icon: icons.export, shortcutKey: null, ctx: "shared",
      action: async (s) => {
        const { openBackupAppDataModal } = await import("./backup.js");
        openBackupAppDataModal(s);
      } },
    // Drop the current date / date-time at the cursor of whatever editing
    // surface is in focus (doc, pane, stack column, or notebook text shape).
    { id: "insert-date", section: "Writing", label: "Insert Date", icon: icons.calendar, shortcutKey: null, ctx: "shared",
      action: (s) => insertDate(s) },
    { id: "insert-date-time", section: "Writing", label: "Insert Date/Time", icon: icons.calendar, shortcutKey: null, ctx: "shared",
      action: (s) => insertDateTime(s) },

    // === DOC ONLY ===
    { id: "ratchet", section: "Writing", label: "Ratchet mode", icon: icons.ratchet, shortcutKey: null, ctx: "doc",
      action: (s) => s.emit("show-ratchet-dropdown") },
    { id: "private", section: "Writing", label: "Private mode", icon: icons.private, shortcutKey: "shortcutTogglePrivate", ctx: "doc",
      action: (s) => s.togglePrivate() },
    // Routed through the per-editor mode context (same helper the
    // shortcut uses) so running this with a pane or stack column
    // focused toggles that surface rather than the main editor behind
    // it. Falls back to the global toggle when the main editor is the
    // active surface.
    { id: "typewriter", section: "Writing", label: "Typewriter mode", icon: icons.typewriter, shortcutKey: "shortcutTypewriter", ctx: "doc",
      action: (s) => toggleModeOnContext(s, "typewriterMode") },
    { id: "dry", section: "Writing", label: "Show repeats", icon: icons.dry, shortcutKey: "shortcutToggleDry", ctx: "doc",
      action: (s) => s.toggleDry() },
    { id: "focus", section: "Writing", label: "Focus mode", icon: icons.focus, shortcutKey: "shortcutToggleFocus", ctx: "doc",
      action: (s) => s.toggleFocus() },
    { id: "zen", section: "Writing", label: "Zen Focus", icon: icons.focus, shortcutKey: "shortcutZenFocus", ctx: "shared",
      action: (s) => s.toggleZenFocus() },
    // Sentence mode only for now; word / paragraph are planned but not yet
    // surfaced. Shown only when there's a live selection to break apart.
    // Three start configs: explode (all in margins), or seed the column
    // with every sentence shuffled / in original order.
    { id: "shuffle-sentences-explode", section: "Writing", label: "Shuffle Editor: Sentences (explode)", icon: icons.shuffle, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !shuffleSelectionAvailable(s),
      action: (s) => openShuffleEditor(s, "explode") },
    { id: "shuffle-sentences-list-shuffle", section: "Writing", label: "Shuffle Editor: Sentences (list shuffle)", icon: icons.shuffle, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !shuffleSelectionAvailable(s),
      action: (s) => openShuffleEditor(s, "list-shuffle") },
    { id: "shuffle-sentences-list-current", section: "Writing", label: "Shuffle Editor: Sentences (list current)", icon: icons.shuffle, shortcutKey: "shortcutShuffleSentences", ctx: "shared",
      hiddenIf: (s) => !shuffleSelectionAvailable(s),
      action: (s) => openShuffleEditor(s, "list-current") },
    { id: "word-count", section: "Writing", label: "Toggle word count", icon: icons.wordCount, shortcutKey: "shortcutToggleWordCount", ctx: "doc",
      action: async (s) => { const { toggleWordCount } = await import("./editor/plugins/word-count.js"); toggleWordCount(s); } },
    // The cap belongs to a document, so both entries name the doc the
    // main editor is showing — `wordLimitTargetFileId` is null for a
    // project's joined buffer, a Local Folder file and every non-doc
    // surface, none of which can carry one. Enforcement is wider than
    // the command: a pane or stack column over the capped doc holds the
    // same cap (editor/word-limit.js), and the word count is where a
    // cap shows itself (editor/plugins/word-count.js).
    { id: "word-limit-set", section: "Writing", label: "Set word count limit", icon: icons.wordLimit, shortcutKey: null, ctx: "doc",
      keywords: "word count cap maximum target",
      hiddenIf: (s) => !wordLimitTargetFileId(s),
      action: async (s) => {
        const { openWordLimitModal } = await import("./ui/word-limit-modal.js");
        openWordLimitModal(s);
      } },
    { id: "word-limit-clear", section: "Writing", label: "Clear word count limit", icon: icons.trash, shortcutKey: null, ctx: "doc",
      keywords: "word count cap remove reset",
      hiddenIf: (s) => !currentWordLimit(s),
      action: (s) => { void setWordLimit(s, wordLimitTargetFileId(s), null); } },
    // The right-hand heading panel. Called "Outline view" until Outlines
    // (the nested-checklist blocks) shipped and the two names became
    // impossible to keep apart; the old wording stays in `keywords` so
    // muscle memory still lands it.
    { id: "overview", section: "View", label: "Overview", icon: icons.overview, shortcutKey: "shortcutToggleOverview", ctx: "doc",
      keywords: "outline view headings navigation right sidebar panel",
      action: (s) => s.emit("toggle-overview-panel") },
    // Turns the list under the caret into an outline: checkboxes on the
    // items that lack them, `outline: true` in the frontmatter. Hidden
    // once every item already has one — there would be nothing to do.
    { id: "outline-convert-doc", section: "Outline", label: "Convert to Outline", icon: icons.outline, shortcutKey: null, ctx: "doc",
      keywords: "checklist task list nested outline convert",
      hiddenIf: (s) => !canConvertDocToOutline(s),
      action: (s) => convertDocToOutline(s) },
    // The way back out: take the boxes off the outline under the caret.
    // The frontmatter switch only comes off with the document's last
    // outline — see `convertOutlineToList`.
    { id: "outline-convert-list", section: "Outline", label: "Convert to List", icon: icons.outline, shortcutKey: null, ctx: "doc",
      keywords: "checklist bullet plain unconvert outline list",
      hiddenIf: (s) => !canConvertDocToList(s),
      action: (s) => convertDocToList(s) },
    // The document-wide switch on its own, for a doc whose checklists are
    // already written: `outline: true` in the frontmatter and nothing else.
    { id: "outline-mode-on", section: "Outline", label: "Outline mode", icon: icons.outline, shortcutKey: null, ctx: "doc",
      keywords: "frontmatter outline true enable checklist frame",
      hiddenIf: (s) => isOutlineModeOn(s),
      action: (s) => toggleOutlineMode(s) },
    { id: "outline-mode-off", section: "Outline", label: "Turn off Outline mode", icon: icons.outline, shortcutKey: null, ctx: "doc",
      keywords: "frontmatter outline false disable checklist frame",
      hiddenIf: (s) => !isOutlineModeOn(s),
      action: (s) => toggleOutlineMode(s) },
    { id: "proofread", section: "Writing", label: "Proofread mode", icon: icons.proofread, shortcutKey: null, ctx: "doc",
      action: (s) => s.toggleProofread() },
    // Not `ctx: "doc"`: spellcheck rides the shared extension set, so a
    // doc pane over an open notebook can be spellchecked even though the
    // main surface is a canvas. The gate is whether any doc surface is
    // in play.
    { id: "spellcheck", section: "Writing", label: "Spellcheck", icon: icons.proofread, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !hasActiveDocSurface(s),
      action: (s) => s.toggleSpellcheck() },
    { id: "copy-as-google-doc", section: "Google", label: "Copy as Google Doc", icon: icons.export, shortcutKey: null, ctx: "doc",
      action: (s) => import("./editor/google-docs/copy-command.js").then((m) => s.editor?.view && m.copyAsGoogleDoc(s.editor.view)) },
    { id: "copy-as-html", section: "Document", label: "Copy as HTML", icon: icons.export, shortcutKey: null, ctx: "doc",
      action: (s) => import("./editor/google-docs/copy-command.js").then((m) => s.editor?.view && m.copyAsHtml(s.editor.view)) },
    { id: "add-gutter", section: "Panes", label: "Add Gutter", icon: icons.notebook, shortcutKey: null, ctx: "doc",
      hiddenIf: (s) => gutterAddHidden(s),
      action: (s) => addGutter(s) },
    { id: "add-notebook-as-gutter", section: "Panes", label: "Add notebook as gutter", icon: icons.notebook, shortcutKey: null, ctx: "doc",
      keepOpen: true,
      hiddenIf: (s) => gutterAddHidden(s),
      action: (s, p) => enterNotebookGutterPicker(p, s) },
    { id: "open-gutter", section: "Panes", label: "Open Gutter", icon: icons.notebook, shortcutKey: null, ctx: "doc",
      hiddenIf: (s) => gutterOpenHidden(s),
      action: (s) => openGutter(s) },
    { id: "close-gutter", section: "Panes", label: "Close Gutter", icon: icons.notebook, shortcutKey: null, ctx: "doc",
      hiddenIf: (s) => gutterCloseHidden(s),
      action: (s) => closeGutter(s) },
    ...buildGoogleCommands({ icons }),

    // === ACTIVE PANE ONLY (doc or notebook) ===
    { id: "fit-pane-gap", section: "Panes", label: "Fit pane to gap", icon: icons.pane, shortcutKey: null, ctx: "pane",
      hiddenIf: () => isActivePaneAGutter(),
      action: () => fitActivePaneToGap() },
    { id: "replace-pane-content", section: "Panes", label: "Replace pane content", icon: icons.pane, shortcutKey: null, ctx: "pane",
      keepOpen: true,
      action: (s, p) => enterFilePicker(p, s, "Replace pane content with…", (f) => {
        const id = getActivePaneId();
        if (id) replacePaneContent(id, f.fileId, f.name, f.type);
      }) },
    { id: "pane-pin", section: "Panes", label: "Pin pane across documents", icon: icons.pane, shortcutKey: null, ctx: "pane", hiddenIf: () => !!panes.get(getActivePaneId())?.pinned, action: () => setActivePanePinned(true) },
    { id: "pane-unpin", section: "Panes", label: "Unpin pane", icon: icons.pane, shortcutKey: null, ctx: "pane", hiddenIf: () => !panes.get(getActivePaneId())?.pinned, action: () => setActivePanePinned(false) },
    { id: "pane-close-current", section: "Panes", label: "Close current pane", icon: icons.trash, shortcutKey: null, ctx: "pane", action: () => { const id = getActivePaneId(); if (id) closePane(id); } },
    { id: "pane-close-and-delete", section: "Panes", label: "Close pane and delete document", icon: icons.trash, shortcutKey: null, ctx: "pane",
      // Same in-app modal as Delete current file, and for the same
      // reason — see there.
      action: (s) => {
        const id = getActivePaneId();
        if (!id) return;
        const pane = panes.get(id);
        const fileId = pane?.fileId;
        const node = fileId ? findNodeByFileId(s.fileTree, fileId) : null;
        if (!node) { closePane(id); return; }
        showDeleteConfirmModal(
          `Close pane and move "${node.name || "Untitled"}" to Trash?`,
          "You can restore it from the Trash afterwards.",
          () => { closePane(id); void deleteTreeNode(s, node.id); },
        );
      } },

    // === PANE SET (current document's panes) ===
    { id: "panes-hide", section: "Panes", label: "Hide panes", icon: icons.pane, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !activeContextHasPanes(s) || arePanesHiddenForActive(s),
      action: (s) => s.hidePanesForActive() },
    { id: "panes-show", section: "Panes", label: "Show panes", icon: icons.pane, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !activeContextHasPanes(s) || !arePanesHiddenForActive(s),
      action: (s) => s.showPanesForActive() },
    { id: "panes-clear", section: "Panes", label: "Close all panes", icon: icons.trash, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !activeContextHasPanes(s),
      action: (s) => { const ctx = activeContextId(s); if (ctx) clearPanesForContext(ctx); } },
    { id: "panes-copy-to", section: "Panes", label: "Copy panes to Document", icon: icons.pane, shortcutKey: null, ctx: "shared",
      keepOpen: true,
      hiddenIf: (s) => !activeContextHasPanes(s),
      action: (s, p) => enterPaneCopyPicker(p, s, /*switchAfter=*/false) },
    { id: "panes-switch-to", section: "Panes", label: "Switch panes to Document", icon: icons.pane, shortcutKey: null, ctx: "shared",
      keepOpen: true,
      hiddenIf: (s) => !activeContextHasPanes(s),
      action: (s, p) => enterPaneCopyPicker(p, s, /*switchAfter=*/true) },

    // === STACK ONLY ===
    { id: "stack-add-file", section: "Stacks", label: "Stack: Add file", icon: icons.stack, shortcutKey: null, ctx: "stack",
      action: async (s) => { const { getStackInstance } = await import("./stack/stack-bridge.js"); const inst = getStackInstance(); if (inst) inst._openAddPicker(); } },
    { id: "stack-scroll-vertical", section: "Stacks", label: "Stack : Scroll vertically", icon: icons.stack, shortcutKey: null, ctx: "stack",
      hiddenIf: (s) => s.stackScrollDirection === "vertical",
      action: async (s) => { const { getStackInstance } = await import("./stack/stack-bridge.js"); const inst = getStackInstance(); if (inst) inst.setScrollDirection("vertical"); } },
    { id: "stack-scroll-horizontal", section: "Stacks", label: "Stack : Scroll horizontally", icon: icons.stack, shortcutKey: null, ctx: "stack",
      hiddenIf: (s) => s.stackScrollDirection !== "vertical",
      action: async (s) => { const { getStackInstance } = await import("./stack/stack-bridge.js"); const inst = getStackInstance(); if (inst) inst.setScrollDirection("horizontal"); } },
    // === NOTEBOOK ONLY ===
    // The notebook half of the same command: the selected flowchart
    // becomes one outline shape holding the tree as a nested checklist.
    { id: "outline-convert-nb", section: "Outline", label: "Convert to Outline", icon: icons.outline, shortcutKey: null, ctx: "notebook",
      keywords: "flowchart checklist task nested outline convert",
      hiddenIf: () => !canConvertNotebookToOutline(),
      action: () => convertNotebookToOutline() },
    { id: "nb-shelf", section: "Notebook", label: "Open shelf", icon: null, shortcutKey: null, ctx: "notebook",
      action: (s) => s.emit("notebook-toggle-shelf") },
    { id: "nb-brainstorm", section: "Notebook", label: "Start brainstorm", icon: null, shortcutKey: "shortcutNbBrainstorm", ctx: "notebook",
      action: (s) => s.emit("notebook-toggle-brainstorm") },
    { id: "nb-minimap-show", section: "Notebook", label: "Show minimap", icon: null, shortcutKey: null, ctx: "notebook",
      hiddenIf: (s) => !!s.settings?.minimapVisible,
      action: (s) => s.toggleMinimap() },
    { id: "nb-minimap-hide", section: "Notebook", label: "Hide minimap", icon: null, shortcutKey: null, ctx: "notebook",
      hiddenIf: (s) => !s.settings?.minimapVisible,
      action: (s) => s.toggleMinimap() },
    { id: "recent-files-show", section: "View", label: "Show Recent Files", icon: null, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !!s.settings?.showRecentFiles,
      action: (s) => s.updateSettings({ showRecentFiles: true }) },
    { id: "recent-files-hide", section: "View", label: "Hide Recent Files", icon: null, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !s.settings?.showRecentFiles,
      action: (s) => s.updateSettings({ showRecentFiles: false }) },
    { id: "project-headings-show", section: "View", label: "Show Project Headings", icon: null, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !!s.settings?.showProjectHeadings,
      action: (s) => s.updateSettings({ showProjectHeadings: true }) },
    { id: "project-headings-hide", section: "View", label: "Hide Project Headings", icon: null, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !s.settings?.showProjectHeadings,
      action: (s) => s.updateSettings({ showProjectHeadings: false }) },
    ...buildDeskCommands({ state, icons, typeIcons, desktop, ipad, enterDeskPicker, currentFileTreeNodeId }),
  ];

  return all.filter(cmd => {
    if (typeof cmd.hiddenIf === "function" && cmd.hiddenIf(state)) return false;
    if (cmd.ctx === "shared") return true;
    if (cmd.ctx === "doc") return !inNotebook;
    if (cmd.ctx === "notebook") return inNotebook;
    if (cmd.ctx === "stack") return inStack;
    if (cmd.ctx === "pane") return hasActivePane;
    if (cmd.ctx === "desktop") return desktop;
    if (cmd.ctx === "ipad") return ipad;
    if (cmd.ctx === "multiwindow") return desktop || ipad; // native multi-window (desktop + iPad/Tauri 2.11)
    return true;
  });
}

export { icons, buildCommands };
